/**
 * Devframes: glues config + worktree discovery + SessionManager + an HTTP API
 * and serves the UI.
 *
 *   const df = await createDevframes({ root });
 *   await df.listen();        // http://localhost:<uiPort>
 *   await df.close();         // stops every managed dev server
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, fillTemplate } from "./config.mjs";
import { listWorktrees, worktreeDetail, worktreeChanges, fetchBase } from "./worktrees.mjs";
import { SessionManager } from "./manager.mjs";
import { allocatePort, httpUp } from "./ports.mjs";
import { launchServer, groupRss } from "./process.mjs";
import { prepareWorktree, runFix } from "./setup.mjs";
import { writeState, clearState } from "./state.mjs";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

export async function createDevframes({ root, config, uiPort, log = console.log } = {}) {
  const cfg = config ?? (await loadConfig(root));
  if (uiPort) cfg.uiPort = uiPort;
  const logDir = join(tmpdir(), "devframes", cfg.root.replace(/[^\w]+/g, "_"));
  const badges = new Map(); // id -> [{label, fix, path}]
  const fixing = new Map(); // id -> label
  let worktrees = [];

  async function refreshWorktrees() {
    worktrees = await listWorktrees(cfg.root);
    return worktrees;
  }
  const byId = (id) => worktrees.find((w) => w.id === id);

  const manager = new SessionManager({
    maxRunning: cfg.maxRunning,
    idleTimeoutMs: cfg.idleTimeoutMs,
    launch: async (id) => {
      const wt = byId(id) ?? (await refreshWorktrees(), byId(id));
      if (!wt) throw new Error(`unknown session ${id}`);
      // The main checkout may already be served by something else (a dev
      // server the user started). Adopt it rather than fighting for the port.
      if (wt.isMain && cfg.mainPort && (await httpUp(cfg.mainPort, cfg.readyPath))) {
        return { port: cfg.mainPort, pid: null, external: true, stop() {}, onExit() {} };
      }
      if (!wt.isMain) badges.set(id, await prepareWorktree(cfg, wt.path));
      const taken = new Set([cfg.uiPort, cfg.mainPort, ...manager.running().map((s) => s.port)].filter(Boolean));
      const port = wt.isMain && cfg.mainPort ? cfg.mainPort : await allocatePort(cfg.ports, taken);
      const vars = {
        port,
        root: wt.path,
        mainRoot: cfg.root,
        name: wt.name,
        cacheDir: join(tmpdir(), "devframes-cache", wt.name),
      };
      const command = fillTemplate(wt.isMain ? cfg.mainCommand : cfg.command, vars);
      const env = Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, fillTemplate(String(v), vars)]));
      log(`▶ ${wt.name} :${port}  ${command}`);
      return launchServer({
        command,
        cwd: wt.path,
        env,
        port,
        logFile: join(logDir, `${wt.name}.log`),
        readyPath: cfg.readyPath,
        readyTimeoutMs: cfg.readyTimeoutMs,
      });
    },
  });
  manager.on("change", (id, why) => why && why !== "started" && log(`· ${id}: ${why}`));

  const reaper = setInterval(
    () => manager.reap(),
    Math.max(1_000, Math.min(30_000, cfg.idleTimeoutMs / 4)),
  );
  reaper.unref();

  async function sessions() {
    await refreshWorktrees();
    return Promise.all(
      worktrees.map(async (w) => {
        const s = manager.get(w.id);
        return {
          id: w.id,
          name: w.name,
          path: w.path,
          branch: w.branch,
          head: w.head,
          isMain: w.isMain,
          ...(await worktreeDetail(w.path)),
          status: fixing.has(w.id) ? "fixing" : (s?.status ?? "stopped"),
          port: s?.port ?? null,
          url: s?.port ? `http://localhost:${s.port}` : null,
          external: Boolean(s?.handle?.external),
          pinned: manager.isPinned(w.id),
          lastSeen: s?.lastSeen ?? null,
          rss: s?.pid ? groupRss(s.pid) : null,
          error: s?.error ?? null,
          badges: badges.get(w.id) ?? [],
          fixing: fixing.get(w.id) ?? null,
        };
      }),
    );
  }

  async function fix(id, label) {
    const wt = byId(id);
    const badge = (badges.get(id) ?? []).find((b) => b.label === label);
    if (!wt || !badge) throw new Error("unknown badge");
    const wasRunning = manager.get(id)?.status === "running";
    manager.stop(id, `fixing: ${label}`);
    fixing.set(id, label);
    try {
      const code = await runFix(cfg, wt.path, badge, () => {});
      if (code !== 0) throw new Error(`${badge.fix} exited ${code}`);
      badges.set(id, (badges.get(id) ?? []).filter((b) => b !== badge));
    } finally {
      fixing.delete(id);
    }
    if (wasRunning) manager.start(id).catch(() => {});
  }

  let lastFetch = 0;
  const routes = {
    "GET /api/config": () => ({
      root: cfg.root,
      viewports: cfg.viewports,
      routes: cfg.routes,
      startPath: cfg.startPath,
      links: cfg.links,
      maxRunning: cfg.maxRunning,
      idleTimeoutMs: cfg.idleTimeoutMs,
    }),
    "GET /api/sessions": async () => ({ sessions: await sessions(), maxRunning: manager.maxRunning }),
    "GET /api/changes": async (q) => {
      const wt = byId(q.get("id"));
      if (!wt) throw new Error(`unknown session ${q.get("id")}`);
      // Fetch the base at most once a minute, so "behind" means something.
      if (Date.now() - lastFetch > 60_000) {
        lastFetch = Date.now();
        await fetchBase(cfg.root, cfg.baseRef).catch(() => {});
      }
      return worktreeChanges(wt.path, cfg.baseRef);
    },
    "POST /api/start": async (q) => {
      manager.clearError(q.get("id"));
      const s = await manager.start(q.get("id"));
      return { id: s.id, port: s.port };
    },
    "POST /api/stop": (q) => ({ ok: manager.stop(q.get("id")) }),
    "POST /api/pin": (q) => (manager.pin(q.get("id"), q.get("on") !== "0"), { ok: true }),
    "POST /api/ping": (q) => ({ ok: manager.ping(q.get("id")) }),
    "POST /api/stopAll": () => (manager.stopAll(), { ok: true }),
    "POST /api/fix": async (q) => (await fix(q.get("id"), q.get("badge")), { ok: true }),
  };

  const http = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) {
      try {
        const body = await handler(url.searchParams);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(body));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      }
      return;
    }
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (file.includes("..")) return res.writeHead(400).end();
    try {
      const body = readFileSync(join(UI_DIR, file));
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(reaper);
    manager.stopAll("devframes exit");
    clearState(cfg.root);
    await new Promise((r) => http.close(() => r()));
  }

  return {
    config: cfg,
    manager,
    sessions,
    close,
    listen: () =>
      new Promise((resolve, reject) => {
        http.once("error", reject);
        http.listen(cfg.uiPort, "127.0.0.1", async () => {
          writeState(cfg.root, { pid: process.pid, uiPort: cfg.uiPort, startedAt: Date.now() });
          await refreshWorktrees();
          resolve(`http://localhost:${cfg.uiPort}`);
        });
      }),
  };
}

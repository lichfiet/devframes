/**
 * Config loading. A project drops `devframes.config.mjs` (or `.json`) in its
 * repo root; everything is optional and merged over DEFAULTS, so a plain Vite
 * app needs no config at all.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const CONFIG_FILES = ["devframes.config.mjs", "devframes.config.js", "devframes.config.json"];

export const DEFAULTS = Object.freeze({
  /** Port the devframes UI itself listens on. */
  uiPort: 5180,
  /**
   * Dev server command for a session. Placeholders:
   *   {port} {root} (the worktree) {mainRoot} (the main checkout)
   *   {cacheDir} (a per-session scratch dir) {name}
   */
  command: "npx vite --port {port} --strictPort",
  /** Command for the main checkout; defaults to `command`. */
  mainCommand: null,
  /** Fixed port for the main checkout (null = allocate from `ports`). */
  mainPort: null,
  /** Port range for sessions, inclusive. */
  ports: [5175, 5224],
  /** Extra env for every dev server. */
  env: {},
  /** Path polled until it answers (<500) before a session counts as running. */
  readyPath: "/",
  readyTimeoutMs: 120_000,
  /** Viewports drawn side by side for the active session. */
  viewports: [
    { name: "phone", width: 390, height: 844 },
    { name: "desktop", width: 1440, height: 900 },
  ],
  /** Quick-route buttons in the toolbar. */
  routes: ["/"],
  /** Route a session opens on. */
  startPath: "/",
  /**
   * Worktree setup, run before a non-main session starts. Each `link` entry is
   * symlinked from the main checkout when the worktree doesn't have its own.
   * `badge` labels the row while the shared copy is in use — always, or only
   * `when: "lockfileDiffers"` — and clicking it removes the link and runs
   * `fix` ("install" → installCommand, "setup" → setupCommand).
   */
  worktree: {
    link: [{ path: "node_modules", badge: "deps differ", when: "lockfileDiffers", fix: "install" }],
    /** Keep the links out of every worktree's `git status` via info/exclude. */
    exclude: true,
  },
  /** Lockfile compared against main's for the "deps differ" badge. */
  lockfile: null, // auto-detect
  /** Install command used by the "deps differ" fix. null = detect from lockfile. */
  installCommand: null,
  /** Optional setup command (the "setup" fix), e.g. a content emit. */
  setupCommand: null,
  /** Stop sessions nobody viewed for this long (pinned sessions are exempt). */
  idleTimeoutMs: 15 * 60_000,
  /** Most sessions running at once; starting another stops the least recently used unpinned one. */
  maxRunning: 4,
  /** Static links shown in the sidebar (servers devframes doesn't manage). */
  links: [],
});

/** Deep-ish merge: plain objects merge one level, everything else replaces. */
export function mergeConfig(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    const b = base[k];
    if (v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object" && !Array.isArray(b)) {
      out[k] = { ...b, ...v };
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function findRepoRoot(cwd = process.cwd()) {
  try {
    // --show-toplevel of the MAIN checkout even when run inside a worktree.
    const common = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
    }).trim();
    return common.endsWith("/.git") ? common.slice(0, -5) : execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return cwd;
  }
}

export function detectLockfile(root) {
  for (const f of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"]) {
    if (existsSync(join(root, f))) return f;
  }
  return null;
}

export function installCommandFor(lockfile) {
  return (
    {
      "pnpm-lock.yaml": "pnpm install --frozen-lockfile",
      "package-lock.json": "npm ci",
      "yarn.lock": "yarn install --frozen-lockfile",
      "bun.lockb": "bun install --frozen-lockfile",
    }[lockfile] ?? "npm install"
  );
}

export async function loadConfig(root = findRepoRoot()) {
  let user = {};
  let file = null;
  for (const name of CONFIG_FILES) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    file = p;
    if (name.endsWith(".json")) user = JSON.parse(readFileSync(p, "utf8"));
    else user = (await import(`${pathToFileURL(p).href}?t=${Date.now()}`)).default ?? {};
    break;
  }
  const cfg = mergeConfig(DEFAULTS, user);
  cfg.root = root;
  cfg.configFile = file;
  cfg.lockfile ??= detectLockfile(root);
  cfg.installCommand ??= installCommandFor(cfg.lockfile);
  cfg.mainCommand ??= cfg.command;
  return cfg;
}

export function fillTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export const STARTER_CONFIG = `// devframes config — every key is optional; see the devframes README.
export default {
  // Dev server per session. {port} {root} {mainRoot} {cacheDir} {name}
  command: "npx vite --port {port} --strictPort",
  // mainPort: 5174,                 // pin the main checkout to a port
  ports: [5175, 5224],
  env: {},
  readyPath: "/",
  viewports: [
    { name: "phone", width: 390, height: 844 },
    { name: "desktop", width: 1440, height: 900 },
  ],
  routes: ["/"],
  worktree: {
    link: [{ path: "node_modules", badge: "deps differ", when: "lockfileDiffers", fix: "install" }],
  },
  // setupCommand: "npm run codegen",
  idleTimeoutMs: 15 * 60_000,
  maxRunning: 4,
};
`;

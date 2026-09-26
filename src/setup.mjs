/**
 * Worktree preparation: symlink shared, gitignored things (node_modules,
 * generated content) from the main checkout so a fresh worktree can boot, keep
 * those links out of every worktree's `git status`, and undo a link + run the
 * real command when the user clicks a badge.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const run = promisify(execFile);

function lexists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function sameFile(a, b) {
  try {
    return readFileSync(a, "utf8") === readFileSync(b, "utf8");
  } catch {
    return false;
  }
}

/**
 * Add `/<path>` lines to the repo's common info/exclude (applies to every
 * worktree, never committed). A symlink doesn't match a directory-only
 * `.gitignore` pattern like `src/pub/content/`, so without this a `git add -A`
 * in another session would commit the link.
 */
export async function ensureExcluded(root, paths) {
  const { stdout } = await run("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const file = join(stdout.trim(), "info", "exclude");
  mkdirSync(dirname(file), { recursive: true });
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = new Set(cur.split("\n"));
  const need = paths.map((p) => `/${p.replace(/^\/+/, "")}`).filter((l) => !lines.has(l));
  if (need.length) {
    appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}# devframes worktree links\n${need.join("\n")}\n`);
  }
}

/** Link what's missing; return the badges that apply to this worktree. */
export async function prepareWorktree(cfg, wtPath) {
  const links = cfg.worktree?.link ?? [];
  if (cfg.worktree?.exclude !== false && links.length) {
    await ensureExcluded(cfg.root, links.map((l) => l.path));
  }
  const lockDiffers =
    cfg.lockfile != null && !sameFile(join(wtPath, cfg.lockfile), join(cfg.root, cfg.lockfile));
  const badges = [];
  for (const l of links) {
    const target = join(wtPath, l.path);
    const source = join(cfg.root, l.path);
    if (!lexists(target) && existsSync(source)) {
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(relative(dirname(target), source), target);
    }
    if (!l.badge || !isLink(target)) continue;
    if (l.when === "lockfileDiffers" && !lockDiffers) continue;
    badges.push({ label: l.badge, fix: l.fix ?? null, path: l.path });
  }
  return badges;
}

/**
 * Run a badge's fix: remove the shared link first (so the command writes into
 * the worktree, never through the link into the main checkout), then run the
 * install/setup command in the worktree. Resolves with the exit code; streams
 * output to `log`.
 */
export function runFix(cfg, wtPath, badge, log = () => {}) {
  const cmd = badge.fix === "install" ? cfg.installCommand : badge.fix === "setup" ? cfg.setupCommand : null;
  if (!cmd) return Promise.reject(new Error(`no command for fix "${badge.fix}"`));
  const target = join(wtPath, badge.path);
  if (isLink(target)) rmSync(target);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { cwd: wtPath, shell: true, env: { ...process.env, ...cfg.env } });
    child.stdout.on("data", (d) => log(String(d)));
    child.stderr.on("data", (d) => log(String(d)));
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** Worktree discovery: `git worktree list --porcelain` plus a little detail. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";

const run = promisify(execFile);

/**
 * Parse `git worktree list --porcelain`. The first record is always the main
 * checkout. Bare and prunable records are skipped.
 */
export function parsePorcelain(text) {
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur && !cur.bare && !cur.prunable) out.push(cur);
    cur = null;
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      cur = { path: line.slice(9), head: null, branch: null, bare: false, prunable: false, locked: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith("HEAD ")) cur.head = line.slice(5, 14);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "detached") cur.branch = "(detached)";
    else if (line === "bare") cur.bare = true;
    else if (line.startsWith("prunable")) cur.prunable = true;
    else if (line.startsWith("locked")) cur.locked = true;
  }
  flush();
  return out.map((w, i) => ({
    ...w,
    isMain: i === 0,
    id: i === 0 ? "main" : basename(w.path),
    name: i === 0 ? "main" : basename(w.path),
  }));
}

export async function listWorktrees(root) {
  const { stdout } = await run("git", ["-C", root, "worktree", "list", "--porcelain"]);
  const list = parsePorcelain(stdout);
  // Disambiguate duplicate basenames (two repos' worktrees named "fix").
  const seen = new Map();
  for (const w of list) {
    const n = (seen.get(w.id) ?? 0) + 1;
    seen.set(w.id, n);
    if (n > 1) w.id = w.name = `${w.id}-${n}`;
  }
  return list;
}

const cache = new Map();
/** Dirty count + last commit, cached for a few seconds. */
export async function worktreeDetail(path, maxAgeMs = 4_000) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.detail;
  const [status, log] = await Promise.all([
    run("git", ["-C", path, "status", "--porcelain"]).catch(() => ({ stdout: "" })),
    run("git", ["-C", path, "log", "-1", "--format=%s%x09%ct"]).catch(() => ({ stdout: "" })),
  ]);
  const [subject = "", ct = "0"] = log.stdout.trim().split("\t");
  const detail = {
    dirty: status.stdout.split("\n").filter(Boolean).length,
    subject,
    committedAt: Number(ct) * 1000,
  };
  cache.set(path, { at: Date.now(), detail });
  return detail;
}

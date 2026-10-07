/**
 * Combine: merge several unmerged branches into one throwaway preview branch
 * (`preview/combined`) in its own worktree, so they can be tried together.
 *
 * Local only: nothing is ever pushed. The one destructive command is
 * `reset --hard`, and it refuses to run anywhere but the `_combined` worktree.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { listWorktrees } from "./worktrees.mjs";

const run = promisify(execFile);
const git = (cwd, args) => run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout);

export const COMBINED_BRANCH = "preview/combined";
export const combinedPath = (root) => join(root, ".claude", "worktrees", "_combined");

/** Local branches not merged into `baseRef`, plus those checked out in worktrees. */
export async function combineCandidates(root, baseRef = "origin/main") {
  const base = baseRef.replace(/^origin\//, "");
  const [unmerged, wts] = await Promise.all([
    git(root, ["branch", "--no-merged", baseRef, "--format=%(refname:short)"]).catch(() => ""),
    listWorktrees(root),
  ]);
  const names = new Set(unmerged.split("\n").map((s) => s.trim()).filter(Boolean));
  for (const w of wts) if (w.branch && w.branch !== "(detached)") names.add(w.branch);
  names.delete(COMBINED_BRANCH);
  names.delete(base);
  return [...names].sort();
}

/** Create the `_combined` worktree on `preview/combined` if it isn't there. */
export async function ensureCombinedWorktree(root, baseRef = "origin/main") {
  const path = combinedPath(root);
  const wts = await listWorktrees(root);
  const have = wts.find((w) => resolve(w.path) === path);
  if (have) {
    if (have.branch !== COMBINED_BRANCH) throw new Error(`${path} is on ${have.branch}, expected ${COMBINED_BRANCH}`);
    return path;
  }
  await git(root, ["worktree", "add", "-q", "-B", COMBINED_BRANCH, path, baseRef]);
  return path;
}

/** `git reset --hard <ref>`, only ever inside the `_combined` worktree. */
export async function resetCombined(root, path, ref) {
  if (resolve(path) !== combinedPath(root)) throw new Error(`refusing reset --hard outside _combined: ${path}`);
  const branch = (await git(path, ["branch", "--show-current"])).trim();
  if (branch !== COMBINED_BRANCH) throw new Error(`refusing reset --hard: ${path} is on "${branch}"`);
  await git(path, ["reset", "--hard", "-q", ref]);
}

/**
 * Rebuild `preview/combined`: reset to `baseRef`, then merge each branch,
 * skipping (and aborting) any that conflict.
 * @returns {{ merged: string[], skipped: { branch: string, files: string[], error?: string }[], at: number }}
 */
export async function buildCombined(root, branches, { baseRef = "origin/main", fetch = true, log = () => {} } = {}) {
  const path = await ensureCombinedWorktree(root, baseRef);
  if (fetch) await run("git", ["-C", root, "fetch", "-q", "origin"], { timeout: 60_000 }).catch((e) => log(`fetch failed: ${e.message}`));
  await resetCombined(root, path, baseRef);
  const merged = [];
  const skipped = [];
  for (const branch of branches) {
    try {
      await git(path, ["merge", "--no-edit", branch]);
      merged.push(branch);
    } catch (err) {
      const files = (await git(path, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
      await git(path, ["merge", "--abort"]).catch(() => {});
      skipped.push({ branch, files, ...(files.length ? {} : { error: String(err.stderr || err.message).trim().split("\n")[0] }) });
    }
  }
  return { merged, skipped, at: Date.now() };
}

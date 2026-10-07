/**
 * Combine: merge several unmerged branches into one throwaway preview branch
 * (default `devframes/combined`) in its own worktree, so they can be tried together.
 *
 * Local only: nothing is ever pushed. The one destructive command is
 * `reset --hard`, and it refuses to run anywhere but the configured combine worktree.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, relative, resolve } from "node:path";
import { listWorktrees } from "./worktrees.mjs";
import { resolveBaseRef } from "./config.mjs";
import { ensureExcluded } from "./setup.mjs";

const run = promisify(execFile);
const git = (cwd, args) => run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout);

export const COMBINE_DEFAULTS = Object.freeze({ worktreeDir: ".devframes/combined", branch: "devframes/combined" });
const opts = (combine) => ({ ...COMBINE_DEFAULTS, ...combine });
export const combinedPath = (root, combine) => resolve(root, opts(combine).worktreeDir);

/** Local branches not merged into `baseRef`, plus those checked out in worktrees. */
export async function combineCandidates(root, baseRef = resolveBaseRef(root), combine) {
  const { branch: combinedBranch } = opts(combine);
  const base = baseRef.replace(/^origin\//, "");
  const [unmerged, wts] = await Promise.all([
    git(root, ["branch", "--no-merged", baseRef, "--format=%(refname:short)"]).catch(() => ""),
    listWorktrees(root),
  ]);
  const names = new Set(unmerged.split("\n").map((s) => s.trim()).filter(Boolean));
  for (const w of wts) if (w.branch && w.branch !== "(detached)") names.add(w.branch);
  names.delete(combinedBranch);
  names.delete(base);
  return [...names].sort();
}

/** Create the combine worktree on its branch if it isn't there. */
export async function ensureCombinedWorktree(root, baseRef = resolveBaseRef(root), combine) {
  const { branch } = opts(combine);
  const path = combinedPath(root, combine);
  const wts = await listWorktrees(root);
  const have = wts.find((w) => resolve(w.path) === path);
  if (have) {
    if (have.branch !== branch) throw new Error(`${path} is on ${have.branch}, expected ${branch}`);
    return path;
  }
  // Keep a worktree inside the repo out of `git status` (info/exclude, never committed).
  const rel = relative(root, path);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
    await ensureExcluded(root, [rel.startsWith(".devframes") ? ".devframes/" : rel]).catch(() => {});
  }
  await git(root, ["worktree", "add", "-q", "-B", branch, path, baseRef]);
  return path;
}

/** `git reset --hard <ref>`, only ever inside the configured combine worktree. */
export async function resetCombined(root, path, ref, combine) {
  if (resolve(path) !== combinedPath(root, combine)) throw new Error(`refusing reset --hard outside the combine worktree: ${path}`);
  const branch = (await git(path, ["branch", "--show-current"])).trim();
  if (branch !== opts(combine).branch) throw new Error(`refusing reset --hard: ${path} is on "${branch}"`);
  await git(path, ["reset", "--hard", "-q", ref]);
}

/**
 * Rebuild the combine branch: reset to `baseRef`, then merge each branch,
 * skipping (and aborting) any that conflict.
 * @returns {{ merged: string[], skipped: { branch: string, files: string[], error?: string }[], at: number }}
 */
export async function buildCombined(root, branches, { baseRef = resolveBaseRef(root), combine, fetch = true, log = () => {} } = {}) {
  const path = await ensureCombinedWorktree(root, baseRef, combine);
  if (fetch) await run("git", ["-C", root, "fetch", "-q", "origin"], { timeout: 60_000 }).catch((e) => log(`fetch failed: ${e.message}`));
  await resetCombined(root, path, baseRef, combine);
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

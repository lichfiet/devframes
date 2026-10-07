import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCombined, combineCandidates, combinedPath, resetCombined } from "../src/combine.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

/** A repo with an "origin" (bare) and branches a (clean), b (clean), c (conflicts with a). */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "devframes-combine-"));
  const origin = join(dir, "origin.git");
  const root = join(dir, "repo");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, root]);
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  const commit = (file, text, msg) => {
    writeFileSync(join(root, file), text);
    git(root, "add", file);
    git(root, "commit", "-q", "-m", msg);
  };
  commit("shared.txt", "base\n", "base");
  git(root, "push", "-q", "origin", "HEAD:main");
  git(root, "fetch", "-q", "origin");
  git(root, "branch", "-q", "--set-upstream-to=origin/main");
  for (const [name, file, text] of [
    ["a", "shared.txt", "from a\n"],
    ["b", "b.txt", "from b\n"],
    ["c", "shared.txt", "from c\n"],
  ]) {
    git(root, "checkout", "-q", "-b", name, "main");
    commit(file, text, name);
  }
  git(root, "checkout", "-q", "main");
  return { root };
}

test("lists unmerged branches", async () => {
  const { root } = fixture();
  assert.deepEqual(await combineCandidates(root), ["a", "b", "c"]);
});

test("merges clean branches, skips and aborts conflicting ones", async () => {
  const { root } = fixture();
  const res = await buildCombined(root, ["a", "b", "c"], { fetch: false });
  assert.deepEqual(res.merged, ["a", "b"]);
  assert.deepEqual(res.skipped, [{ branch: "c", files: ["shared.txt"] }]);
  const wt = combinedPath(root);
  assert.equal(git(wt, "branch", "--show-current").trim(), "devframes/combined");
  assert.equal(git(wt, "status", "--porcelain").trim(), "");
  assert.ok(existsSync(join(wt, "b.txt")));
  assert.equal(git(root, "branch", "--show-current").trim(), "main");
  // Rebuilding resets first: a different selection drops the earlier merges.
  const again = await buildCombined(root, ["b"], { fetch: false });
  assert.deepEqual(again.merged, ["b"]);
  assert.equal(git(wt, "show", "HEAD:shared.txt"), "base\n");
});

test("reset --hard refuses anywhere but the combine worktree", async () => {
  const { root } = fixture();
  await assert.rejects(resetCombined(root, root, "origin/main"), /refusing/);
});

test("worktreeDir and branch are configurable; .devframes is excluded", async () => {
  const { root } = fixture();
  const combine = { worktreeDir: ".claude/worktrees/_combined", branch: "preview/combined" };
  await buildCombined(root, ["a"], { fetch: false, combine });
  const wt = combinedPath(root, combine);
  assert.ok(wt.endsWith("/.claude/worktrees/_combined"));
  assert.equal(git(wt, "branch", "--show-current").trim(), "preview/combined");
  await assert.rejects(resetCombined(root, combinedPath(root), "origin/main", combine), /refusing/);
  await buildCombined(root, ["b"], { fetch: false });
  assert.match(git(root, "status", "--porcelain", "--ignored"), /!! \.devframes\//);
  assert.equal(git(root, "status", "--porcelain").trim(), "");
});

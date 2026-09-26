import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePorcelain } from "../src/worktrees.mjs";

const SAMPLE = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo/.claude/worktrees/shop-nav
HEAD 2222222222222222222222222222222222222222
branch refs/heads/shop-nav

worktree /repo/.claude/worktrees/probe
HEAD 3333333333333333333333333333333333333333
detached

worktree /gone
HEAD 4444444444444444444444444444444444444444
branch refs/heads/old
prunable gitdir file points to non-existent location

`;

test("parses main, branch and detached worktrees; skips prunable", () => {
  const list = parsePorcelain(SAMPLE);
  assert.equal(list.length, 3);
  assert.deepEqual(
    list.map((w) => [w.id, w.branch, w.isMain, w.head]),
    [
      ["main", "main", true, "111111111"],
      ["shop-nav", "shop-nav", false, "222222222"],
      ["probe", "(detached)", false, "333333333"],
    ],
  );
});

test("skips bare records", () => {
  const list = parsePorcelain("worktree /bare\nbare\n\nworktree /x\nHEAD abc\nbranch refs/heads/x\n");
  assert.deepEqual(list.map((w) => w.path), ["/x"]);
  assert.equal(list[0].isMain, true);
});

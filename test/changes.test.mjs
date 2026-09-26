import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLog, parseStatus } from "../src/worktrees.mjs";

test("parseLog reads tab-separated git log lines, keeping tabs in subjects", () => {
  const out = parseLog("abc123\t1700000000\tTrevor Lichfield\tFix\tthing\n\n");
  assert.deepEqual(out, [{ sha: "abc123", at: 1700000000000, author: "Trevor Lichfield", subject: "Fix\tthing" }]);
});

test("parseStatus reads porcelain status codes and paths", () => {
  const out = parseStatus(" M src/a.ts\n?? new file.ts\nA  b.ts\n");
  assert.deepEqual(out, [
    { status: "M", path: "src/a.ts" },
    { status: "??", path: "new file.ts" },
    { status: "A", path: "b.ts" },
  ]);
});

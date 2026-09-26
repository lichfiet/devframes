import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { allocatePort, portFree } from "../src/ports.mjs";

test("allocatePort skips taken and busy ports", async () => {
  const busy = new Set([5176]);
  const p = await allocatePort([5175, 5180], new Set([5175]), async (port) => !busy.has(port));
  assert.equal(p, 5177);
});

test("allocatePort throws when the range is exhausted", async () => {
  await assert.rejects(allocatePort([1, 2], new Set(), async () => false), /no free port/);
});

test("portFree detects a real listener", async () => {
  const srv = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const { port } = srv.address();
  assert.equal(await portFree(port), false);
  srv.close();
  await new Promise((r) => srv.once("close", r));
  assert.equal(await portFree(port), true);
});

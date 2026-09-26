import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/manager.mjs";

function fake({ maxRunning = 2, idleTimeoutMs = 1000 } = {}) {
  let clock = 0;
  let port = 6000;
  const stopped = [];
  const m = new SessionManager({
    maxRunning,
    idleTimeoutMs,
    now: () => clock,
    launch: async (id) => ({ port: port++, pid: null, stop: () => stopped.push(id), onExit() {} }),
  });
  return { m, stopped, tick: (ms) => (clock += ms) };
}

test("start is idempotent and returns the running session", async () => {
  const { m } = fake();
  const a = await m.start("a");
  const again = await m.start("a");
  assert.equal(a, again);
  assert.equal(m.running().length, 1);
});

test("running cap evicts the least recently used session", async () => {
  const { m, stopped, tick } = fake({ maxRunning: 2 });
  await m.start("a");
  tick(10);
  await m.start("b");
  tick(10);
  m.ping("a"); // b is now least recent
  await m.start("c");
  assert.deepEqual(stopped, ["b"]);
  assert.deepEqual(m.running().map((s) => s.id).sort(), ["a", "c"]);
});

test("pinned sessions are never evicted", async () => {
  const { m, stopped, tick } = fake({ maxRunning: 2 });
  await m.start("a");
  m.pin("a");
  tick(10);
  await m.start("b");
  tick(10);
  await m.start("c");
  assert.deepEqual(stopped, ["b"]);
});

test("cap reached with everything pinned is an error", async () => {
  const { m } = fake({ maxRunning: 1 });
  await m.start("a");
  m.pin("a");
  await assert.rejects(m.start("b"), /every session is pinned/);
});

test("reap stops idle unpinned sessions only", async () => {
  const { m, stopped, tick } = fake({ maxRunning: 4, idleTimeoutMs: 100 });
  await m.start("a");
  await m.start("b");
  await m.start("c");
  m.pin("c");
  tick(50);
  m.ping("b");
  tick(60); // a idle 110, b idle 60, c pinned
  assert.deepEqual(m.reap(), ["a"]);
  assert.deepEqual(stopped, ["a"]);
  tick(100);
  assert.deepEqual(m.reap(), ["b"]);
  assert.equal(m.get("c").status, "running");
});

test("pins survive a stop; stopAll stops everything", async () => {
  const { m, stopped } = fake({ maxRunning: 4 });
  await m.start("a");
  m.pin("a");
  m.stop("a");
  assert.equal(m.isPinned("a"), true);
  await m.start("a");
  await m.start("b");
  m.stopAll();
  assert.equal(m.running().length, 0);
  assert.deepEqual(stopped, ["a", "a", "b"]);
});

test("a failed launch records the error and can be retried", async () => {
  let fail = true;
  const m = new SessionManager({
    launch: async () => {
      if (fail) throw new Error("boom");
      return { port: 1, stop() {}, onExit() {} };
    },
  });
  await assert.rejects(m.start("x"), /boom/);
  assert.equal(m.get("x").status, "error");
  m.clearError("x");
  fail = false;
  assert.equal((await m.start("x")).status, "running");
});

test("exit of the dev server removes the session", async () => {
  let exit;
  const m = new SessionManager({ launch: async () => ({ port: 1, stop() {}, onExit: (fn) => (exit = fn) }) });
  await m.start("x");
  exit();
  assert.equal(m.get("x"), undefined);
});

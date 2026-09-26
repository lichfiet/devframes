import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, mergeConfig, fillTemplate, DEFAULTS, installCommandFor } from "../src/config.mjs";

test("defaults apply with no config file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "df-"));
  const cfg = await loadConfig(dir);
  assert.equal(cfg.configFile, null);
  assert.equal(cfg.uiPort, 5180);
  assert.deepEqual(cfg.ports, [5175, 5224]);
  assert.equal(cfg.mainCommand, cfg.command);
  assert.equal(cfg.installCommand, "npm install");
});

test("mjs config merges over defaults; nested objects merge one level", async () => {
  const dir = mkdtempSync(join(tmpdir(), "df-"));
  writeFileSync(join(dir, "package-lock.json"), "{}");
  writeFileSync(
    join(dir, "devframes.config.mjs"),
    `export default { mainPort: 5174, env: { A: "1" }, worktree: { exclude: false }, maxRunning: 2 };`,
  );
  const cfg = await loadConfig(dir);
  assert.equal(cfg.mainPort, 5174);
  assert.deepEqual(cfg.env, { A: "1" });
  assert.equal(cfg.worktree.exclude, false);
  assert.deepEqual(cfg.worktree.link, DEFAULTS.worktree.link); // kept from defaults
  assert.equal(cfg.maxRunning, 2);
  assert.equal(cfg.lockfile, "package-lock.json");
  assert.equal(cfg.installCommand, "npm ci");
});

test("json config is supported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "df-"));
  writeFileSync(join(dir, "devframes.config.json"), JSON.stringify({ routes: ["/a", "/b"] }));
  const cfg = await loadConfig(dir);
  assert.deepEqual(cfg.routes, ["/a", "/b"]);
});

test("arrays replace rather than merge", () => {
  assert.deepEqual(mergeConfig({ a: [1, 2] }, { a: [3] }).a, [3]);
});

test("fillTemplate substitutes known vars and leaves unknown ones", () => {
  assert.equal(fillTemplate("vite --port {port} {x}", { port: 5175 }), "vite --port 5175 {x}");
});

test("install command follows the lockfile", () => {
  assert.equal(installCommandFor("pnpm-lock.yaml"), "pnpm install --frozen-lockfile");
  assert.equal(installCommandFor("yarn.lock"), "yarn install --frozen-lockfile");
});

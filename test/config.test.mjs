import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { detectCommand, resolveBaseRef, loadConfig, mergeConfig, fillTemplate, DEFAULTS, installCommandFor } from "../src/config.mjs";

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
  assert.deepEqual(cfg.worktree.link, []); // no package.json: no node_modules link
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

const pkgDir = (pkg, ...files) => {
  const dir = mkdtempSync(join(tmpdir(), "df-"));
  if (pkg) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  for (const f of files) writeFileSync(join(dir, f), "");
  return dir;
};

test("detects Vite, with the package manager from the lockfile", () => {
  const pkg = { devDependencies: { vite: "^5" } };
  assert.deepEqual(detectCommand(pkgDir(pkg)), { framework: "Vite", command: "npx vite --port {port} --strictPort" });
  assert.equal(detectCommand(pkgDir(pkg, "pnpm-lock.yaml")).command, "pnpm exec vite --port {port} --strictPort");
});

test("detects Next.js ahead of a generic dev script", () => {
  const dir = pkgDir({ dependencies: { next: "14" }, scripts: { dev: "next dev" } });
  assert.deepEqual(detectCommand(dir), { framework: "Next.js", command: "npx next dev -p {port}" });
});

test("generic dev script gets PORT, and --port only for known tools", () => {
  assert.equal(detectCommand(pkgDir({ scripts: { dev: "node server.js" } })).command, "PORT={port} npm run dev");
  assert.equal(
    detectCommand(pkgDir({ scripts: { dev: "webpack serve" } })).command,
    "PORT={port} npm run dev -- --port {port}",
  );
  assert.equal(detectCommand(pkgDir({ scripts: { dev: "node s.js" } }, "yarn.lock")).command, "PORT={port} yarn dev");
});

test("no package.json or nothing runnable: no detection, no node_modules link", async () => {
  assert.equal(detectCommand(pkgDir(null)), null);
  assert.equal(detectCommand(pkgDir({ name: "x" })), null);
  const py = await loadConfig(pkgDir(null));
  assert.equal(py.command, null);
  assert.deepEqual(py.worktree.link, []);
  const node = await loadConfig(pkgDir({ devDependencies: { vite: "5" } }));
  assert.equal(node.worktree.link[0].path, "node_modules");
});

test("a configured command is always honoured", async () => {
  const dir = pkgDir({ devDependencies: { vite: "5" } });
  writeFileSync(join(dir, "devframes.config.json"), JSON.stringify({ command: "python manage.py runserver {port}" }));
  const cfg = await loadConfig(dir);
  assert.equal(cfg.command, "python manage.py runserver {port}");
  assert.equal(cfg.mainCommand, cfg.command);
});

const sh = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

test("baseRef follows the remote's HEAD (master), then falls back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "df-ref-"));
  const origin = join(dir, "origin.git");
  const root = join(dir, "repo");
  execFileSync("git", ["init", "-q", "--bare", "-b", "master", origin]);
  execFileSync("git", ["clone", "-q", origin, root]);
  sh(root, "config", "user.email", "t@example.com");
  sh(root, "config", "user.name", "T");
  writeFileSync(join(root, "f"), "x");
  sh(root, "add", "f");
  sh(root, "commit", "-q", "-m", "init");
  sh(root, "push", "-q", "origin", "HEAD:master");
  sh(root, "fetch", "-q", "origin");
  sh(root, "remote", "set-head", "origin", "master");
  assert.equal(resolveBaseRef(root), "origin/master");
  assert.equal((await loadConfig(root)).baseRef, "origin/master");
  // No origin/HEAD: still finds origin/master.
  sh(root, "remote", "set-head", "origin", "-d");
  assert.equal(resolveBaseRef(root), "origin/master");
  // No remote at all: the local branch.
  sh(root, "remote", "remove", "origin");
  assert.equal(resolveBaseRef(root), "master");
});

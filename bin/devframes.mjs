#!/usr/bin/env node
/**
 * devframes            start the UI (default port 5180) for the repo you're in
 * devframes init       write a starter devframes.config.mjs
 * devframes stop       stop the running UI and every dev server it started
 * devframes status     print whether it's running
 *
 * Flags: --port <n>   --root <path>   --help
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDevframes, findRepoRoot, starterConfig, detectCommand, resolveBaseRef } from "../src/index.mjs";
import { readState, clearState, isAlive } from "../src/state.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const VALUE_FLAGS = new Set(["--port", "--root"]);
const cmd = args.find((a, i) => !a.startsWith("-") && !VALUE_FLAGS.has(args[i - 1])) ?? "start";
const root = findRepoRoot(flag("root") ?? process.cwd());

if (args.includes("--help") || args.includes("-h")) {
  console.log(`devframes — live phone + desktop previews of every git worktree

  devframes [--port 5180]   start the UI for ${root}
  devframes init [--force]  write devframes.config.mjs
  devframes stop            stop the UI and all dev servers it started
  devframes status`);
  process.exit(0);
}

if (cmd === "init") {
  const file = join(root, "devframes.config.mjs");
  if (existsSync(file) && !args.includes("--force")) {
    console.error(`${file} exists (use --force to overwrite)`);
    process.exit(1);
  }
  const found = detectCommand(root);
  writeFileSync(file, starterConfig(found));
  console.log(`wrote ${file}`);
  console.log(
    found
      ? `detected ${found.framework}: ${found.command}`
      : "no dev command detected: set `command` in the config (see the README for Django, Rails, static examples)",
  );
  console.log(`base ref: ${resolveBaseRef(root)}`);
  process.exit(0);
}

if (cmd === "stop" || cmd === "status") {
  const st = readState(root);
  if (!st || !isAlive(st.pid)) {
    if (st) clearState(root);
    console.log("devframes is not running for", root);
    process.exit(cmd === "stop" ? 0 : 1);
  }
  if (cmd === "status") {
    console.log(`running: pid ${st.pid}, http://localhost:${st.uiPort}`);
    process.exit(0);
  }
  process.kill(st.pid, "SIGTERM");
  console.log(`stopped devframes (pid ${st.pid})`);
  process.exit(0);
}

if (cmd !== "start") {
  console.error(`unknown command: ${cmd} (try --help)`);
  process.exit(1);
}

const existing = readState(root);
if (existing && isAlive(existing.pid)) {
  console.log(`already running: http://localhost:${existing.uiPort} (pid ${existing.pid})`);
  process.exit(0);
}

const df = await createDevframes({ root, uiPort: flag("port") ? Number(flag("port")) : undefined });
const url = await df.listen();
console.log(`devframes: ${url}  (${df.config.configFile ?? "no config file, defaults"})`);

let exiting = false;
const shutdown = async (code) => {
  if (exiting) return;
  exiting = true;
  await df.close();
  process.exit(code);
};
process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));
process.on("exit", () => df.manager.stopAll("exit"));

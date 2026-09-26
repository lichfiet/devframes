/** A tiny state file per repo so `devframes stop` can find the running UI. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "devframes");

export function stateFile(root) {
  const h = createHash("sha1").update(root).digest("hex").slice(0, 12);
  return join(DIR, `${h}.json`);
}

export function writeState(root, data) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(stateFile(root), JSON.stringify({ root, ...data }, null, 2));
}

export function readState(root) {
  try {
    return JSON.parse(readFileSync(stateFile(root), "utf8"));
  } catch {
    return null;
  }
}

export function clearState(root) {
  rmSync(stateFile(root), { force: true });
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

/** Remove the state file, keeping the saved Combine selection and env profiles (it outlives a run). */
export function clearState(root) {
  const { combine, profiles } = readState(root) ?? {};
  rmSync(stateFile(root), { force: true });
  if (combine || profiles) writeState(root, { ...(combine && { combine }), ...(profiles && { profiles }) });
}

/** Merge `patch` into the existing state. */
export function updateState(root, patch) {
  writeState(root, { ...readState(root), ...patch });
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

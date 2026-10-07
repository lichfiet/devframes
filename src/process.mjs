/**
 * Spawning dev servers: each runs in its own process group (so `npx` → `vite`
 * trees die together), logs to a file, and counts as up once its readiness
 * path answers.
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { httpUp, tcpUp } from "./ports.mjs";

/**
 * @returns {Promise<{ port, pid, stop, onExit, log }>}
 */
export async function launchServer({ command, cwd, env, port, logFile, readyPath = "/", readyCheck = "http", readyTimeoutMs = 120_000 }) {
  mkdirSync(join(logFile, ".."), { recursive: true });
  const out = openSync(logFile, "a");
  const child = spawn(command, {
    cwd,
    shell: true,
    detached: true, // own process group
    env: { ...process.env, ...env },
    stdio: ["ignore", out, out],
  });
  const exitHandlers = [];
  let exited = false;
  child.on("exit", () => {
    exited = true;
    for (const fn of exitHandlers) fn();
  });
  const stop = () => killGroup(child.pid);

  const until = Date.now() + readyTimeoutMs;
  while (true) {
    if (exited) throw new Error(`dev server exited during startup (see ${logFile})`);
    if (await (readyCheck === "tcp" ? tcpUp(port) : httpUp(port, readyPath))) break;
    if (Date.now() > until) {
      stop();
      throw new Error(`timed out after ${Math.round(readyTimeoutMs / 1000)}s waiting for :${port}${readyCheck === "tcp" ? "" : readyPath}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { port, pid: child.pid, stop, onExit: (fn) => exitHandlers.push(fn), log: logFile };
}

export function killGroup(pid, signal = "SIGTERM") {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* gone */
    }
  }
}

/**
 * Resident memory (bytes) of a process group, summed from /proc. Linux only;
 * returns null elsewhere.
 */
export function groupRss(pgid) {
  if (!pgid || process.platform !== "linux") return null;
  let total = 0;
  try {
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      let stat;
      try {
        stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch {
        continue;
      }
      // pgrp is the 5th field, after "(comm)" which may contain spaces.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) !== pgid) continue;
      const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
      if (m) total += Number(m[1]) * 1024;
    }
  } catch {
    return null;
  }
  return total;
}

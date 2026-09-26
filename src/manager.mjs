/**
 * Session manager: one dev server per worktree, started on demand.
 *
 * Owns the lifecycle rules — readiness, idle reaping, the running cap with
 * least-recently-used eviction, pinning — and nothing about HTTP or git, so it
 * can be driven from tests with a fake `launch`.
 *
 *   const m = new SessionManager({ maxRunning: 4, idleTimeoutMs, launch });
 *   await m.start("feature-x", { port, ... });   // evicts LRU if at cap
 *   m.ping("feature-x"); m.pin("feature-x", true); m.stop("feature-x");
 *   m.reap(Date.now());                          // stop idle, unpinned
 */
import { EventEmitter } from "node:events";

export class SessionManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {number} o.maxRunning
   * @param {number} o.idleTimeoutMs
   * @param {(id: string, spec: object) => Promise<{ port: number, stop: () => void, pid?: number, onExit?: (fn: () => void) => void }>} o.launch
   * @param {() => number} [o.now]
   */
  constructor({ maxRunning = 4, idleTimeoutMs = 15 * 60_000, launch, now = Date.now }) {
    super();
    this.maxRunning = maxRunning;
    this.idleTimeoutMs = idleTimeoutMs;
    this.launch = launch;
    this.now = now;
    /** id -> { id, status, port, pid, pinned, lastSeen, startedAt, error, handle, starting } */
    this.sessions = new Map();
    /** Pins survive a stop, so re-starting a pinned session keeps it pinned. */
    this.pins = new Set();
  }

  get(id) {
    return this.sessions.get(id);
  }

  running() {
    return [...this.sessions.values()].filter((s) => s.status === "running" || s.status === "starting");
  }

  /** Least recently seen running, unpinned session other than `except`. */
  lruVictim(except) {
    return this.running()
      .filter((s) => s.id !== except && !this.pins.has(s.id))
      .sort((a, b) => a.lastSeen - b.lastSeen)[0];
  }

  async start(id, spec = {}) {
    const cur = this.sessions.get(id);
    if (cur?.status === "running") {
      cur.lastSeen = this.now();
      return cur;
    }
    if (cur?.starting) return cur.starting;

    // Enforce the cap before spending memory on another server.
    while (this.running().length >= this.maxRunning) {
      const victim = this.lruVictim(id);
      if (!victim) throw new Error(`running cap (${this.maxRunning}) reached and every session is pinned`);
      this.stop(victim.id, "evicted (running cap)");
    }

    const s = {
      id,
      status: "starting",
      port: null,
      pid: null,
      lastSeen: this.now(),
      startedAt: this.now(),
      error: null,
      handle: null,
      starting: null,
    };
    this.sessions.set(id, s);
    this.emit("change", id);
    s.starting = (async () => {
      try {
        const handle = await this.launch(id, spec);
        // Stopped while we were booting? Tear the fresh server down.
        if (this.sessions.get(id) !== s) {
          handle.stop();
          throw new Error("stopped while starting");
        }
        s.handle = handle;
        s.port = handle.port;
        s.pid = handle.pid ?? null;
        s.status = "running";
        handle.onExit?.(() => {
          if (this.sessions.get(id) === s) {
            this.sessions.delete(id);
            this.emit("change", id, "exited");
          }
        });
        this.emit("change", id, "started");
        return s;
      } catch (err) {
        if (this.sessions.get(id) === s) {
          s.status = "error";
          s.error = String(err?.message ?? err);
          this.emit("change", id, "error");
        }
        throw err;
      } finally {
        s.starting = null;
      }
    })();
    return s.starting;
  }

  stop(id, reason = "stopped") {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.sessions.delete(id);
    try {
      s.handle?.stop();
    } catch {
      /* already gone */
    }
    this.emit("change", id, reason);
    return true;
  }

  stopAll(reason = "stop all") {
    for (const id of [...this.sessions.keys()]) this.stop(id, reason);
  }

  ping(id) {
    const s = this.sessions.get(id);
    if (s) s.lastSeen = this.now();
    return Boolean(s);
  }

  pin(id, on = true) {
    if (on) this.pins.add(id);
    else this.pins.delete(id);
    this.emit("change", id, on ? "pinned" : "unpinned");
  }

  isPinned(id) {
    return this.pins.has(id);
  }

  /** Stop running sessions idle longer than idleTimeoutMs (pinned exempt). */
  reap(now = this.now()) {
    const stopped = [];
    for (const s of this.running()) {
      if (s.status !== "running" || this.pins.has(s.id)) continue;
      if (now - s.lastSeen > this.idleTimeoutMs) {
        this.stop(s.id, "idle");
        stopped.push(s.id);
      }
    }
    return stopped;
  }

  /** Clear a failed session so it can be retried. */
  clearError(id) {
    const s = this.sessions.get(id);
    if (s?.status === "error") this.sessions.delete(id);
  }
}

/** Port helpers. */
import { createServer, connect } from "node:net";

/** True when nothing is listening on `port` (bind test on 127.0.0.1). */
export function portFree(port) {
  return new Promise((resolve) => {
    const s = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => s.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}

/** True when an HTTP server answers on `port` (any status below 500). */
export async function httpUp(port, path = "/", timeoutMs = 2_000) {
  try {
    const res = await fetch(`http://localhost:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** True when something accepts TCP connections on `port`. */
export function tcpUp(port, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const sock = connect({ port, host: "127.0.0.1" });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * First port in [lo, hi] that isn't `taken` and passes `isFree`.
 * `isFree` is injectable so the allocation logic is testable.
 */
export async function allocatePort([lo, hi], taken = new Set(), isFree = portFree) {
  for (let p = lo; p <= hi; p++) {
    if (taken.has(p)) continue;
    if (await isFree(p)) return p;
  }
  throw new Error(`no free port in ${lo}-${hi}`);
}

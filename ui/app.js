// devframes UI — plain ES module, no build step.
//
// Every RUNNING session keeps its own mounted set of iframes (one per
// viewport). Switching sessions only toggles which set is visible, so each
// session keeps its route, scroll position and open dialogs. Stopped sessions
// have no frames at all.

import { initChanges, openChanges, changesFollow } from "./changes.js";

const $ = (id) => document.getElementById(id);
const api = async (method, path) => {
  const res = await fetch(path, { method });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
};

const state = {
  config: null,
  sessions: [],
  active: null,
  visible: null, // Set of viewport names shown
  pending: new Set(), // ids with a start/stop request in flight
  errors: new Map(),
};
const pairs = new Map();

/* ── Rotation (per viewport, remembered) ─────────────────────── */
const rotated = new Set((() => {
  try { return JSON.parse(localStorage.getItem("devframes.rotated") || "[]"); } catch { return []; }
})());
/** Effective size: a rotated viewport swaps width and height. */
function dims(vp) {
  return rotated.has(vp.name) ? { w: vp.height, h: vp.width } : { w: vp.width, h: vp.height };
}
function toggleRotate(name) {
  rotated.has(name) ? rotated.delete(name) : rotated.add(name);
  try { localStorage.setItem("devframes.rotated", JSON.stringify([...rotated])); } catch {}
  for (const p of pairs.values()) {
    const f = p.frames.get(name);
    if (!f) continue;
    const d = dims(f.vp);
    f.iframe.width = d.w;
    f.iframe.height = d.h;
    f.label.textContent = `${name} · ${d.w}×${d.h}`;
  }
  layout();
} // id -> { el, url, frames: Map(vpName -> {box, iframe}) }

/* ── Hash (active session + view mode) ───────────────────────── */

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  return { s: h.get("s"), v: h.get("v") };
}
function writeHash() {
  const h = new URLSearchParams();
  if (state.active) h.set("s", state.active);
  const all = state.config.viewports.map((v) => v.name);
  const vis = all.filter((n) => state.visible.has(n));
  h.set("v", vis.length === all.length ? "all" : vis.join(","));
  history.replaceState(null, "", `#${h}`);
}

/* ── Formatting ──────────────────────────────────────────────── */

function age(ms) {
  if (!ms) return "";
  const s = (Date.now() - ms) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
function bytes(n) {
  if (!n) return "0 MB";
  return n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) e.append(k);
  return e;
};
const svg = (d) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", "15");
  s.setAttribute("height", "15");
  s.innerHTML = `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  return s;
};
const ICON = {
  play: "M7 5l12 7-12 7z",
  stop: "M7 7h10v10H7z",
  pin: "M12 17v5M8 3h8l-1 6 3 3v2H6v-2l3-3z",
};

/* ── Sidebar ─────────────────────────────────────────────────── */

function renderSidebar() {
  const list = $("sessions");
  list.replaceChildren(
    ...state.sessions.map((s) => {
      const status = state.pending.has(s.id) && s.status === "stopped" ? "starting" : s.status;
      const running = status === "running" || status === "starting";
      const meta = [s.branch, age(s.committedAt)].filter(Boolean).join(" · ");
      const row = el(
        "li",
        {
          className: `row${s.id === state.active ? " active" : ""}`,
          title: `${s.path}\n${s.subject ?? ""}`,
          onclick: () => activate(s.id),
        },
        el("span", { className: `dot ${status}`, title: status }),
        el(
          "div",
          { className: "row-main" },
          el("div", { className: "row-title" }, s.name),
          el(
            "div",
            { className: "row-meta" },
            meta,
            s.dirty
              ? el(
                  "span",
                  {
                    className: "dirty",
                    title: "Show what changed",
                    onclick: (e) => (e.stopPropagation(), activate(s.id), openChanges(s.id)),
                  },
                  ` · ${s.dirty} changed`,
                )
              : null,
            s.port ? ` · :${s.port}` : null,
          ),
        ),
        el(
          "div",
          { className: "row-actions" },
          el(
            "button",
            {
              className: `icon-btn${s.pinned ? " on" : ""}`,
              title: s.pinned ? "Unpin (allow idle stop / eviction)" : "Pin (never idle-stopped or evicted)",
              "aria-label": s.pinned ? "Unpin" : "Pin",
              onclick: (e) => (e.stopPropagation(), pin(s.id, !s.pinned)),
            },
            svg(ICON.pin),
          ),
          el(
            "button",
            {
              className: "icon-btn",
              title: running ? "Stop" : "Start",
              "aria-label": running ? `Stop ${s.name}` : `Start ${s.name}`,
              onclick: (e) => (e.stopPropagation(), running ? stop(s.id) : start(s.id)),
            },
            svg(running ? ICON.stop : ICON.play),
          ),
        ),
        s.badges.length
          ? el(
              "div",
              { className: "badges" },
              ...s.badges.map((b) =>
                el(
                  "button",
                  {
                    className: "badge",
                    title: b.fix ? `Click to ${b.fix === "install" ? "install this worktree's own dependencies" : "run the setup command"}` : "",
                    disabled: !b.fix || s.status === "fixing",
                    onclick: (e) => (e.stopPropagation(), fixBadge(s.id, b.label)),
                  },
                  s.fixing === b.label ? `${b.label}…` : b.label,
                ),
              ),
            )
          : null,
        state.errors.get(s.id) || s.error ? el("div", { className: "err" }, state.errors.get(s.id) || s.error) : null,
      );
      return row;
    }),
  );

  const running = state.sessions.filter((s) => s.status === "running");
  const mem = running.reduce((a, s) => a + (s.rss ?? 0), 0);
  $("summary").textContent = `${running.length}/${state.config.maxRunning} running${mem ? ` · ~${bytes(mem)}` : ""}`;
  $("stopAll").disabled = running.length === 0;
}

function renderLinks() {
  $("links").replaceChildren(
    ...(state.config.links ?? []).map((l) =>
      el("li", {}, el("a", { href: l.url, target: "_blank", rel: "noreferrer", title: l.url }, `↗ ${l.name}`)),
    ),
  );
}

/* ── Toolbar ─────────────────────────────────────────────────── */

function renderToolbar() {
  const vps = state.config.viewports;
  const mk = (label, on, click) => el("button", { className: on ? "on" : "", onclick: click, type: "button" }, label);
  const allOn = vps.every((v) => state.visible.has(v.name));
  $("viewModes").replaceChildren(
    ...vps.map((v) =>
      mk(v.name, state.visible.has(v.name) && !allOn, () => setVisible(new Set([v.name]))),
    ),
    ...(vps.length > 1 ? [mk(vps.length > 2 ? "all" : "both", allOn, () => setVisible(new Set(vps.map((v) => v.name))))] : []),
  );
  $("quick").replaceChildren(
    ...state.config.routes.map((r) => el("button", { type: "button", onclick: () => navigate(r) }, r)),
  );
  const s = activeSession();
  $("openTab").href = s?.url ? s.url + ($("path").value || "/") : "#";
}

/* ── Frames ──────────────────────────────────────────────────── */

const activeSession = () => state.sessions.find((s) => s.id === state.active);

function ensurePair(s) {
  let p = pairs.get(s.id);
  if (p && p.url !== s.url) {
    p.el.remove();
    pairs.delete(s.id);
    p = null;
  }
  if (!p) {
    p = { el: el("div", { className: "pair" }), url: s.url, frames: new Map(), path: state.config.startPath };
    $("stage").append(p.el);
    pairs.set(s.id, p);
  }
  // Mount visible viewports, drop hidden ones (memory: "phone only" really is lighter).
  for (const vp of state.config.viewports) {
    const want = state.visible.has(vp.name);
    const have = p.frames.get(vp.name);
    if (want && !have) {
      const iframe = el("iframe", { src: s.url + p.path, title: `${s.name} — ${vp.name}` });
      const d = dims(vp);
      iframe.width = d.w;
      iframe.height = d.h;
      const box = el("div", { className: `frame-box ${vp.name}` }, iframe);
      const label = el("span", {}, `${vp.name} · ${d.w}×${d.h}`);
      const rotate = vp.rotatable
        ? el("button", { className: "rotate-btn", title: "Rotate", "aria-label": `Rotate ${vp.name}`, onclick: () => toggleRotate(vp.name) }, "↻")
        : null;
      const wrap = el("div", { className: "frame" }, el("div", { className: "frame-label" }, label, rotate), box);
      wrap.dataset.vp = vp.name;
      // keep config order
      const after = [...p.el.children].find(
        (c) => state.config.viewports.findIndex((v) => v.name === c.dataset.vp) > state.config.viewports.indexOf(vp),
      );
      p.el.insertBefore(wrap, after ?? null);
      p.frames.set(vp.name, { wrap, box, iframe, vp, label });
    } else if (!want && have) {
      have.wrap.remove();
      p.frames.delete(vp.name);
    }
  }
  return p;
}

function syncFrames() {
  for (const s of state.sessions) {
    if (s.status === "running" && s.url) ensurePair(s);
  }
  for (const [id, p] of pairs) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s || s.status !== "running") {
      p.el.remove();
      pairs.delete(id);
    }
  }
  for (const [id, p] of pairs) p.el.hidden = id !== state.active;
  const s = activeSession();
  const empty = $("empty");
  if (!s) empty.textContent = "Pick a session on the left, or press [ / ].";
  else if (s.status === "running") empty.textContent = "";
  else if (s.status === "starting" || state.pending.has(s.id)) empty.textContent = `Starting ${s.name}…`;
  else if (s.status === "fixing") empty.textContent = `Fixing ${s.name}…`;
  else empty.textContent = `${s.name} is stopped — press ▶ to start it.`;
  empty.hidden = !empty.textContent;
  layout();
}

function layout() {
  const stage = $("stage");
  const W = stage.clientWidth - 32;
  const H = stage.clientHeight - 32 - 20; // padding + label
  const vps = state.config.viewports.filter((v) => state.visible.has(v.name));
  if (!vps.length) return;
  const border = (vp) => (vp.name === "phone" ? 16 : 2);
  const totalW = vps.reduce((a, v) => a + dims(v).w + border(v), 0) + 24 * (vps.length - 1);
  const maxH = Math.max(...vps.map((v) => dims(v).h + border(v)));
  const scale = Math.min(1, W / totalW, H / maxH);
  for (const p of pairs.values()) {
    for (const f of p.frames.values()) {
      const d = dims(f.vp);
      f.box.style.width = `${d.w * scale + border(f.vp)}px`;
      f.box.style.height = `${d.h * scale + border(f.vp)}px`;
      f.iframe.style.transform = `scale(${scale})`;
    }
  }
}

/* ── Actions ─────────────────────────────────────────────────── */

async function refresh() {
  try {
    const { sessions } = await api("GET", "/api/sessions");
    state.sessions = sessions;
    if (state.active && !sessions.some((s) => s.id === state.active)) state.active = null;
  } catch (err) {
    console.warn(err);
  }
  renderSidebar();
  renderToolbar();
  syncFrames();
}

async function start(id) {
  state.pending.add(id);
  state.errors.delete(id);
  renderSidebar();
  syncFrames();
  try {
    await api("POST", `/api/start?id=${encodeURIComponent(id)}`);
  } catch (err) {
    state.errors.set(id, err.message);
  } finally {
    state.pending.delete(id);
    await refresh();
  }
}

async function stop(id) {
  await api("POST", `/api/stop?id=${encodeURIComponent(id)}`).catch(() => {});
  await refresh();
}

async function pin(id, on) {
  await api("POST", `/api/pin?id=${encodeURIComponent(id)}&on=${on ? 1 : 0}`).catch(() => {});
  await refresh();
}

async function fixBadge(id, label) {
  const p = api("POST", `/api/fix?id=${encodeURIComponent(id)}&badge=${encodeURIComponent(label)}`);
  setTimeout(refresh, 300);
  await p.catch((err) => state.errors.set(id, err.message));
  await refresh();
}

function activate(id) {
  state.active = id;
  writeHash();
  changesFollow(id);
  const s = activeSession();
  const p = pairs.get(id);
  $("path").value = p?.path ?? state.config.startPath;
  if (s && s.status !== "running" && s.status !== "fixing" && !state.pending.has(id)) start(id);
  else ping();
  renderSidebar();
  renderToolbar();
  syncFrames();
}

function navigate(path) {
  if (!path.startsWith("/")) path = `/${path}`;
  $("path").value = path;
  const s = activeSession();
  const p = pairs.get(state.active);
  if (!s?.url || !p) return;
  p.path = path;
  for (const f of p.frames.values()) f.iframe.src = s.url + path;
  renderToolbar();
}

function setVisible(set) {
  state.visible = set;
  writeHash();
  renderToolbar();
  syncFrames();
}

function ping() {
  if (state.active) api("POST", `/api/ping?id=${encodeURIComponent(state.active)}`).catch(() => {});
}

function cycle(dir) {
  const running = state.sessions.filter((s) => s.status === "running" || pairs.has(s.id));
  const ring = running.length >= 2 ? running : state.sessions;
  if (!ring.length) return;
  const i = ring.findIndex((s) => s.id === state.active);
  activate(ring[(i + dir + ring.length) % ring.length].id);
}

/* ── Boot ────────────────────────────────────────────────────── */

async function boot() {
  state.config = await api("GET", "/api/config");
  $("repo").textContent = state.config.root;
  const h = readHash();
  const names = state.config.viewports.map((v) => v.name);
  state.visible = new Set(!h.v || h.v === "all" ? names : h.v.split(",").filter((n) => names.includes(n)));
  if (!state.visible.size) state.visible = new Set(names);
  $("path").value = state.config.startPath;
  renderLinks();
  await refresh();
  if (h.s && state.sessions.some((s) => s.id === h.s)) activate(h.s);

  initChanges(() => state.active);
  $("pathForm").onsubmit = (e) => {
    e.preventDefault();
    navigate($("path").value.trim() || "/");
  };
  $("reload").onclick = () => {
    const p = pairs.get(state.active);
    if (p) for (const f of p.frames.values()) f.iframe.src = f.iframe.src;
  };
  $("stopAll").onclick = async () => {
    await api("POST", "/api/stopAll").catch(() => {});
    await refresh();
  };
  $("collapse").onclick = () => {
    $("app").classList.toggle("collapsed");
    try {
      localStorage.setItem("devframes.collapsed", $("app").classList.contains("collapsed") ? "1" : "0");
    } catch {}
    requestAnimationFrame(layout);
  };
  try {
    if (localStorage.getItem("devframes.collapsed") === "1") $("app").classList.add("collapsed");
  } catch {}
  addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "[") cycle(-1);
    if (e.key === "]") cycle(1);
  });
  addEventListener("resize", layout);
  new ResizeObserver(layout).observe($("stage"));
  setInterval(refresh, 2500);
  setInterval(ping, 60_000);
}

boot();

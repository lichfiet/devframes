// Changes panel: what's new in the active session — its recent commits, how
// far it is ahead/behind the base branch, commits on the base it hasn't picked
// up, and its uncommitted files (the "N changed" on each sidebar row).

const $ = (id) => document.getElementById(id);

const panel = { id: null, open: false, timer: null };

function ago(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function h(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((k) => k != null && k !== false));
  return node;
}

function commitList(commits) {
  if (!commits.length) return h("p", { className: "muted small" }, "None.");
  return h(
    "ul",
    { className: "commit-list" },
    ...commits.map((c) =>
      h(
        "li",
        { title: `${c.sha} · ${new Date(c.at).toLocaleString()} · ${c.author}` },
        h("div", { className: "commit-subject" }, c.subject),
        h("div", { className: "muted small" }, `${c.sha} · ${ago(c.at)} · ${c.author.split(" ")[0]}`),
      ),
    ),
  );
}

function section(title, count, body) {
  return h(
    "section",
    { className: "changes-section" },
    h("h3", {}, title, count != null ? h("span", { className: "count" }, ` ${count}`) : null),
    body,
  );
}

async function load() {
  if (!panel.open || !panel.id) return;
  const body = $("changesBody");
  try {
    const res = await fetch(`/api/changes?id=${encodeURIComponent(panel.id)}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error ?? res.statusText);
    $("changesTitle").textContent = d.branch;
    body.replaceChildren(
      h(
        "p",
        { className: "muted small" },
        `${d.ahead} ahead · ${d.behind} behind ${d.baseRef}`,
      ),
      section(
        "Uncommitted",
        d.changes.length,
        d.changes.length
          ? h(
              "ul",
              { className: "file-list" },
              ...d.changes.map((c) =>
                h("li", {}, h("span", { className: `st st-${c.status[0]}` }, c.status), " ", c.path),
              ),
            )
          : h("p", { className: "muted small" }, "Working tree clean."),
      ),
      section("Recent commits", null, commitList(d.commits)),
      d.behind ? section(`New on ${d.baseRef}`, d.behind, commitList(d.incoming)) : null,
    );
  } catch (err) {
    body.replaceChildren(h("p", { className: "err" }, String(err.message ?? err)));
  }
}

/** Show the panel for a session (or keep it on the current one). */
export function openChanges(id) {
  panel.id = id ?? panel.id;
  panel.open = true;
  $("changes").hidden = false;
  // Sit just under the toolbar, which can wrap to two rows.
  $("changes").style.top = `${document.querySelector(".toolbar")?.offsetHeight ?? 48}px`;
  $("changesBtn").classList.add("on");
  load();
  clearInterval(panel.timer);
  panel.timer = setInterval(load, 15_000);
}

export function closeChanges() {
  panel.open = false;
  $("changes").hidden = true;
  $("changesBtn").classList.remove("on");
  clearInterval(panel.timer);
}

/** Call when the active session changes; follows it if the panel is open. */
export function changesFollow(id) {
  panel.id = id;
  if (panel.open) load();
}

export function initChanges(getActive) {
  $("changesBtn").onclick = () => (panel.open ? closeChanges() : openChanges(getActive()));
  $("changesClose").onclick = closeChanges;
}

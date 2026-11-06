/**
 * Renderer: draws one card per session from the snapshots the main process
 * pushes. Blocked and waiting sessions come first, then working, then the
 * rest by most recent activity.
 */

/** Sort rank per state; lower shows first. */
const STATE_ORDER = { waiting: 0, working: 1, idle: 2, unreported: 3, done: 4 };
/** The last snapshot received, kept so the filter can redraw without a refresh. */
let last = null;

/**
 * Create an element with optional class and text.
 * @param {string} tag Tag name.
 * @param {string} [cls] Class name.
 * @param {string} [text] Text content (never parsed as HTML).
 * @returns {HTMLElement} The element.
 */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Format a token count compactly (1.2M, 34k).
 * @param {number|null|undefined} n Token count.
 * @returns {string} Formatted value, or "–" when unknown.
 */
function tokens(n) {
  if (n == null || Number.isNaN(n)) return "–";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/**
 * Format a number of minutes as a short age.
 * @param {number|null|undefined} m Minutes.
 * @returns {string} e.g. "4 min", "2.5 h", or "–".
 */
function age(m) {
  if (m == null) return "–";
  if (m < 1) return "now";
  if (m < 90) return `${Math.round(m)} min`;
  return `${(m / 60).toFixed(1)} h`;
}

/**
 * Effective state of a row: the self-reported one, or "unreported".
 * @param {object} row Joined row.
 * @returns {string} State name.
 */
function stateOf(row) {
  return (row.entry && row.entry.state) || "unreported";
}

/**
 * Minutes since the session's latest activity, measured or self-reported.
 * @param {object} row Joined row.
 * @returns {number} Minutes (Infinity when unknown).
 */
function idleOf(row) {
  if (row.usage && row.usage.idle_minutes != null) return row.usage.idle_minutes;
  if (row.entry && row.entry.age_minutes != null) return row.entry.age_minutes;
  return Infinity;
}

/**
 * Add a labelled value to a stats grid.
 * @param {HTMLElement} grid Grid container.
 * @param {string} key Label.
 * @param {string} value Value.
 */
function stat(grid, key, value) {
  const cell = el("div");
  cell.append(el("div", "k", key), el("div", "v", value));
  grid.append(cell);
}

/**
 * Build the card of one session.
 * @param {object} row Joined row: {session, entry, usage, stale}.
 * @returns {HTMLElement} The card.
 */
function card(row) {
  const e = row.entry || {};
  const u = row.usage || {};
  const state = stateOf(row);
  const node = el("section", "card");
  node.style.setProperty("--state", `var(--${state in STATE_ORDER ? state : "idle"})`);

  const top = el("div", "top");
  top.append(el("span", "state", state));
  const cwd = e.cwd || u.cwd || "";
  top.append(el("span", "project", cwd.split("/").pop() || "?"));
  if (row.stale) top.append(el("span", "tag", "stale entry"));
  top.append(el("span", "sid", row.session.slice(0, 8)));
  node.append(top);

  node.append(el("div", "model", `${e.agent || u.agent || "?"} · ${e.model || u.model || "?"}`));

  const task = e.task || (u.title ? `(title) ${u.title}` : "");
  if (task) node.append(el("div", "task", task));
  if (e.blocker) node.append(el("div", "blocker", `Blocked: ${e.blocker}`));

  const grid = el("div", "grid");
  stat(grid, "items left", e.items_left != null ? String(e.items_left) : "–");
  stat(grid, "ETA", e.eta || "–");
  stat(grid, "projected left", tokens(e.tokens_left));
  stat(grid, "output", tokens(u.output));
  stat(grid, "context", tokens(u.context));
  stat(grid, "total", tokens(u.total));
  stat(grid, "last active", age(u.idle_minutes));
  stat(grid, "entry age", age(e.age_minutes));
  stat(grid, "calls", u.calls != null ? String(u.calls) : "–");
  node.append(grid);

  if (Array.isArray(e.items) && e.items.length) {
    const list = el("ul");
    for (const item of e.items) list.append(el("li", null, item));
    node.append(list);
  }
  if (Array.isArray(e.notes) && e.notes.length) {
    const list = el("ul", "notes");
    for (const note of e.notes) list.append(el("li", null, note));
    node.append(list);
  }
  return node;
}

/**
 * Redraw the whole window from a snapshot.
 * @param {object} snap Snapshot from the main process.
 */
function render(snap) {
  last = snap;
  const showUnreported = document.getElementById("showUnreported").checked;
  const rows = snap.rows
    .filter((r) => showUnreported || r.entry)
    .sort((a, b) => {
      const blocked = Number(Boolean(b.entry && b.entry.blocker)) - Number(Boolean(a.entry && a.entry.blocker));
      if (blocked) return blocked;
      const rank = (STATE_ORDER[stateOf(a)] ?? 2) - (STATE_ORDER[stateOf(b)] ?? 2);
      return rank || idleOf(a) - idleOf(b);
    });

  const reported = snap.rows.filter((r) => r.entry).length;
  document.getElementById("meta").textContent =
    `${snap.rows.length} sessions (${reported} reporting) · updated ${new Date(snap.at).toLocaleTimeString()}`;

  const monitors = document.getElementById("monitors");
  monitors.replaceChildren(
    ...snap.monitors.map((m) =>
      el("span", `pill${m.alive ? " alive" : ""}`, `${m.session}: ${m.alive ? "alive" : "stopped"}`),
    ),
  );

  const error = document.getElementById("error");
  error.hidden = !snap.usageError;
  error.textContent = snap.usageError ? `usage.py failed: ${snap.usageError}` : "";

  const cards = document.getElementById("cards");
  cards.replaceChildren(...rows.map(card));
  if (!rows.length) cards.append(el("div", "empty", `No sessions found in ${snap.board}.`));
}

window.statusApi.onStatus(render);
document.getElementById("refresh").addEventListener("click", async () => render(await window.statusApi.refresh()));
document.getElementById("showUnreported").addEventListener("change", () => last && render(last));

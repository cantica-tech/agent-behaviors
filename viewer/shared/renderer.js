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
  node.append(top);

  node.append(el("div", "model", `${e.agent || u.agent || "?"} · ${e.model || u.model || "?"}`));

  if (e.done_epoch) {
    const at = new Date(e.done_epoch * 1000);
    node.append(el("div", "doneat", `done at ${at.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`));
  }

  const ident = el("div", "ident");
  const name = nameOf(e);
  if (name) ident.append(el("span", "k", "name "), el("span", "name", name), document.createTextNode(" · "));
  ident.append(el("span", "k", "id "), el("span", "sid", row.session));
  node.append(ident);
  node.append(linksLine(row));
  node.append(messageArea(row));

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
  const notes = (Array.isArray(e.notes) ? e.notes : []).filter((n) => !NAME_NOTE.test(n));
  if (notes.length) {
    const list = el("ul", "notes");
    for (const note of notes) list.append(el("li", null, note));
    node.append(list);
  }
  return node;
}

/** Message drafts by session id, kept across re-renders: {open, text, status}. */
const drafts = new Map();

/**
 * Inbox line, "Message…" button and composer of a card. The composer sends a
 * prompt to the session's inbox (read by any agent that follows the
 * session-status skill when it next publishes) and offers to open the
 * session so the user can type to it directly.
 * @param {object} row Joined row (`inbox`, `open`, `entry`).
 * @returns {HTMLElement} The area.
 */
function messageArea(row) {
  const area = el("div", "messaging");
  if (row.entry && row.entry.state === "done") {
    // A done session takes no more messages.
    area.append(el("div", "k", "Done: messaging closed."));
    return area;
  }
  const draft = drafts.get(row.session) || { open: false, text: "", status: "" };
  drafts.set(row.session, draft);
  const inbox = row.inbox || {};
  const bar = el("div", "msgbar");
  const toggle = el("button", "small", draft.open ? "Close" : "Message…");
  bar.append(toggle);
  if (!row.entry && row.liveNow) bar.append(startReportingButton(row, draft));
  if (inbox.unread) bar.append(el("span", "waiting", `${inbox.unread} message${inbox.unread === 1 ? "" : "s"} waiting`));
  else if (inbox.lastRead) bar.append(el("span", "k", `last message read ${new Date(inbox.lastRead).toLocaleTimeString()}`));
  area.append(bar);
  toggle.addEventListener("click", () => {
    draft.open = !draft.open;
    if (last) render(last);
  });
  if (!draft.open) return area;

  const box = el("div", "composer");
  const text = document.createElement("textarea");
  text.className = "compose";
  text.rows = 3;
  text.placeholder = "Prompt for this agent…";
  text.value = draft.text;
  text.addEventListener("input", () => {
    draft.text = text.value;
  });
  text.addEventListener("blur", () => setTimeout(() => last && render(last), 0));
  const actions = el("div", "actions");
  const send = el("button", "primary small", "Send");
  const open = el("button", "small", row.open && row.open.kind === "attach" ? "Open session (attach)" : "Open session");
  open.disabled = !row.open;
  if (!row.open) open.title = "No way to open this session: its project folder is unknown";
  const status = el("span", "message", draft.status);
  actions.append(send, open, status);
  const notes = [];
  if (!row.entry) notes.push("This session doesn't publish its status, so it won't read messages: use Open session.");
  else if (["idle", "waiting", "done"].includes(row.entry.state)) {
    notes.push(`It is ${row.entry.state}: it reads messages only when it next publishes.`);
  }
  box.append(text, actions);
  for (const n of notes) box.append(el("div", "k note", n));
  area.append(box);

  send.addEventListener("click", async () => {
    send.disabled = true;
    const result = await window.statusApi.sendMessage(row.session, draft.text);
    send.disabled = false;
    draft.status = result.ok ? "Sent to its inbox." : result.error;
    if (result.ok) draft.text = "";
    if (last) render(last);
  });
  open.addEventListener("click", async () => {
    const result = await window.statusApi.openSession(row.session);
    draft.status = result && result.ok === false ? result.error : "";
    if (last) render(last);
  });
  return area;
}

/**
 * Prompt asking an agent to load the session-status skill and report under
 * its own session id (the id the viewers already show for it).
 * @param {string} skillPath Real path of session-status/SKILL.md.
 * @param {string} sid The session's id.
 * @returns {string} The prompt.
 */
function startReportingPrompt(skillPath, sid) {
  return `Load the skill ${skillPath} and follow it from now on. ` +
    `Publish your status right away with its board.py, using your session id ${sid}, ` +
    `then publish before you start each task and after you finish it.`;
}

/**
 * "Onboard" button, shown only for live sessions that don't report.
 * Such a session doesn't read the inbox, so the prompt can't be delivered
 * there: the button copies it to the clipboard and opens the session for the
 * user to paste it.
 * @param {object} row Joined row (no `entry`, `liveNow` true).
 * @param {object} draft The card's draft state, for the status text.
 * @returns {HTMLElement} The button.
 */
function startReportingButton(row, draft) {
  const button = el("button", "small primary", "Onboard");
  const skill = (last && last.skillPath) || null;
  button.disabled = !skill || !row.open;
  button.title = !skill ? "session-status skill not found (~/.agent-behaviors/skills/session-status)" :
    !row.open ? "This session cannot be opened" :
    "Copy a prompt asking this agent to load the session-status skill, and open its session to paste it";
  button.addEventListener("click", async () => {
    const copied = await window.statusApi.copyText(startReportingPrompt(skill, row.session));
    const opened = await window.statusApi.openSession(row.session);
    draft.open = true;
    draft.status = !copied ? "Could not copy the prompt." :
      opened && opened.ok === false ? `Prompt copied; could not open the session (${opened.error}).` :
      "Prompt copied: paste it into the session that just opened.";
    if (last) render(last);
  });
  return button;
}

/** What each link is called, and what to say when its target is gone or unknown. */
const LINK_LABELS = {
  context: ["context folder", "context folder no longer available", "context folder unknown"],
  memory: ["memory", "memory no longer available (none saved, or removed)", "no memory location known"],
};

/**
 * Build the line with links to a session's context folder and memory. A
 * link opens the location (in Finder, or the default app for a file); a
 * location that is gone or unknown is described in plain text instead.
 * @param {object} row Joined row with `links` from the monitor.
 * @returns {HTMLElement} The line.
 */
function linksLine(row) {
  const line = el("div", "links");
  const links = row.links || {};
  for (const [key, [label, gone, unknown]] of Object.entries(LINK_LABELS)) {
    const link = links[key] || {};
    if (line.childNodes.length) line.append(document.createTextNode(" · "));
    if (link.exists) {
      const a = el("a", null, label);
      a.href = "#";
      a.title = link.path;
      a.addEventListener("click", (event) => {
        event.preventDefault();
        window.statusApi.openPath(link.path);
      });
      line.append(a);
    } else {
      const text = el("span", "gone", link.path ? gone : unknown);
      if (link.path) text.title = link.path;
      line.append(text);
    }
  }
  return line;
}

/** Note that carries a session's reachable name, as published per SKILL.md: "name: <name>". */
const NAME_NOTE = /^\s*name:\s*(.+?)\s*$/i;

/**
 * The name a session can be reached by: a `name` field, else a "name: …" note.
 * @param {object} entry Board entry (may be empty).
 * @returns {string|null} The name, or null when the session published none.
 */
function nameOf(entry) {
  if (entry.name) return String(entry.name);
  for (const note of Array.isArray(entry.notes) ? entry.notes : []) {
    const m = NAME_NOTE.exec(note);
    if (m) return m[1];
  }
  return null;
}

/**
 * Redraw the whole window from a snapshot.
 * @param {object} snap Snapshot from the main process.
 */
function render(snap) {
  last = snap;
  // Don't rebuild the cards under the user's typing; re-render when the box loses focus.
  const active = document.activeElement;
  if (active && active.classList && active.classList.contains("compose")) return;
  const showUnreported = document.getElementById("showUnreported").checked;
  const hideDone = document.getElementById("hideDone").checked;
  const rows = snap.rows
    .filter((r) => showUnreported || r.entry)
    .filter((r) => !hideDone || stateOf(r) !== "done")
    .sort((a, b) => {
      const blocked = Number(Boolean(b.entry && b.entry.blocker)) - Number(Boolean(a.entry && a.entry.blocker));
      if (blocked) return blocked;
      const rank = (STATE_ORDER[stateOf(a)] ?? 2) - (STATE_ORDER[stateOf(b)] ?? 2);
      return rank || idleOf(a) - idleOf(b);
    });

  const reported = snap.rows.filter((r) => r.entry).length;
  document.getElementById("meta").textContent =
    `${snap.rows.length} sessions (${reported} reporting) · updated ${new Date(snap.at).toLocaleTimeString()}` +
    (snap.settings ? ` · usage every ${snap.settings.viewerUsageSeconds} s, board every ${snap.settings.viewerBoardSeconds} s` : "");

  const monitors = document.getElementById("monitors");
  monitors.replaceChildren(
    ...snap.monitors.map((m) =>
      el("span", `pill${m.alive ? " alive" : ""}`, `${m.session}: ${m.alive ? "alive" : "stopped"}`),
    ),
  );

  const error = document.getElementById("error");
  const problems = [
    snap.usageError && `usage.py failed: ${snap.usageError}`,
    snap.settingsError && `Settings: ${snap.settingsError} (keeping the previous rates)`,
  ].filter(Boolean);
  error.hidden = !problems.length;
  error.textContent = problems.join(" · ");

  const cards = document.getElementById("cards");
  cards.replaceChildren(...rows.map(card));
  if (!rows.length) cards.append(el("div", "empty", `No sessions found in ${snap.board}.`));
}

window.statusApi.onStatus(render);
document.getElementById("refresh").addEventListener("click", async () => render(await window.statusApi.refresh()));
document.getElementById("showUnreported").addEventListener("change", () => last && render(last));
document.getElementById("hideDone").addEventListener("change", () => last && render(last));

/** Settings the panel edits: key, label and unit, in display order. */
const SETTING_FIELDS = [
  ["viewerBoardSeconds", "Board refresh", "s"],
  ["viewerUsageSeconds", "Usage refresh", "s"],
  ["statusSessionSeconds", "Status session cycle", "s"],
  ["doneVisibleHours", "Show done sessions for", "h"],
];

/**
 * Settings panel: a header button that opens a small form to edit the
 * session-status settings at runtime. Saving goes through
 * `window.statusApi.saveSettings`, which validates, writes the settings file
 * and applies the new rates at once. The form is filled when it opens and is
 * not refreshed by later snapshots, so typing is never interrupted.
 */
function setupSettingsPanel() {
  // VS Code has its own Settings (the gear in the Sessions view's title bar): no button here.
  if (window.statusApi.openSettings || !window.statusApi.saveSettings) return;
  const button = el("button", null, "Settings");
  button.id = "settingsButton";
  document.getElementById("refresh").before(button);

  const panel = el("section", "settings-panel");
  panel.hidden = true;
  const form = el("form");
  const inputs = {};
  for (const [key, label, unit] of SETTING_FIELDS) {
    const row = el("label", "setting");
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.name = key;
    inputs[key] = input;
    const range = el("span", "k");
    row.append(el("span", null, label), input, el("span", "k", unit), range);
    row.range = range;
    form.append(row);
  }
  const actions = el("div", "actions");
  const save = el("button", "primary", "Save");
  save.type = "submit";
  const cancel = el("button", null, "Close");
  cancel.type = "button";
  const message = el("span", "message");
  actions.append(save, cancel, message);
  const where = el("div", "k where");
  form.append(actions, where);
  panel.append(form);
  document.querySelector("header").after(panel);

  /** Fill the form from the latest snapshot. */
  function fill() {
    const snap = last || {};
    const values = snap.settings || {};
    const ranges = snap.settingRanges || {};
    for (const [key] of SETTING_FIELDS) {
      const input = inputs[key];
      const r = ranges[key];
      if (r) {
        input.min = r[0];
        input.max = r[1];
        input.parentElement.range.textContent = `${r[0]}–${r[1]}`;
      }
      input.value = values[key] ?? "";
    }
    where.textContent = snap.settingsFile ? `Saved to ${snap.settingsFile}; applies at once.` : "";
    message.textContent = "";
    message.className = "message";
  }

  button.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) fill();
  });
  cancel.addEventListener("click", () => {
    panel.hidden = true;
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = {};
    for (const [key] of SETTING_FIELDS) values[key] = Number(inputs[key].value);
    save.disabled = true;
    try {
      const result = await window.statusApi.saveSettings(values);
      message.textContent = result.ok ? "Saved." : result.error;
      message.className = `message ${result.ok ? "ok" : "bad"}`;
    } catch (err) {
      message.textContent = String(err && err.message ? err.message : err);
      message.className = "message bad";
    } finally {
      save.disabled = false;
    }
  });
}

setupSettingsPanel();

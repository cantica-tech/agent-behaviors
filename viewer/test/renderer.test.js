/**
 * Unit tests of shared/renderer.js (the card UI of both viewers), run in
 * jsdom against a fake window.statusApi that records calls.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage } = require("./helpers");

/**
 * A fake statusApi recording calls; methods resolve with configurable results.
 * @returns {object} The fake, with `calls` and `push(snapshot)`.
 */
function fakeApi() {
  const api = {
    calls: [],
    results: { saveSettings: { ok: true }, sendMessage: { ok: true }, openSession: { ok: true }, copyText: true },
    onStatus(cb) {
      api.cb = cb;
    },
    push(snap) {
      api.cb(snap);
    },
  };
  for (const name of ["refresh", "saveSettings", "sendMessage", "openSession", "openPath", "copyText"]) {
    api[name] = (...args) => {
      api.calls.push([name, ...args]);
      return Promise.resolve(api.results[name]);
    };
  }
  return api;
}

/**
 * A row of a snapshot with sensible defaults.
 * @param {object} over Fields to override.
 * @returns {object} Row.
 */
function row(over = {}) {
  return {
    session: "s-1",
    entry: { agent: "claude-code", model: "m", state: "working", cwd: "/p/proj", task: "do things", updated_epoch: 1 },
    usage: { agent: "claude-code", output: 1500, context: 2000000, total: 12, idle_minutes: 3, calls: 4 },
    stale: false,
    links: { context: { path: "/ctx", exists: true }, memory: { path: "/mem", exists: false } },
    inbox: { unread: 0, lastRead: null },
    open: { kind: "folder", path: "/p/proj" },
    liveNow: true,
    ...over,
  };
}

/**
 * A snapshot with sensible defaults.
 * @param {object[]} rows Rows.
 * @param {object} over Fields to override.
 * @returns {object} Snapshot.
 */
function snap(rows, over = {}) {
  return {
    board: "/board", at: "2026-11-07T10:00:00Z", rows, monitors: [], usageError: null,
    settings: { viewerUsageSeconds: 30, viewerBoardSeconds: 5, statusSessionSeconds: 300, doneVisibleHours: 12 },
    settingsError: null, settingsFile: "/home/.agent-behaviors/session-status.json",
    settingRanges: { viewerBoardSeconds: [1, 300], viewerUsageSeconds: [10, 3600], statusSessionSeconds: [60, 3600], doneVisibleHours: [0, 720] },
    skillPath: "/skills/session-status/SKILL.md",
    ...over,
  };
}

/**
 * Load the Electron page with the renderer and a fake API.
 * @returns {{win: Window, api: object, doc: Document, $: Function, $$: Function}} Handles.
 */
function page() {
  const api = fakeApi();
  const win = loadPage("index.html", ["shared/renderer.js"], { statusApi: api });
  const doc = win.document;
  return { win, api, doc, $: (s) => doc.querySelector(s), $$: (s) => [...doc.querySelectorAll(s)] };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("formatting helpers", () => {
  const { win } = page();
  const tokens = win.eval("tokens");
  assert.equal(tokens(null), "–");
  assert.equal(tokens(999), "999");
  assert.equal(tokens(1500), "2k");
  assert.equal(tokens(2500000), "2.5M");
  const age = win.eval("age");
  assert.equal(age(null), "–");
  assert.equal(age(0.5), "now");
  assert.equal(age(45), "45 min");
  assert.equal(age(150), "2.5 h");
});

test("header: counts, rates, pills and errors", () => {
  const { api, $, $$ } = page();
  api.push(snap([row(), row({ session: "u", entry: null })], {
    monitors: [{ session: "a.status", alive: true }, { session: "b.status", alive: false }],
    usageError: "boom", settingsError: "s.json ignored: bad",
  }));
  assert.match($("#meta").textContent, /2 sessions \(1 reporting\)/);
  assert.match($("#meta").textContent, /usage every 30 s, board every 5 s/);
  assert.deepEqual($$(".pill").map((p) => [p.textContent, p.classList.contains("alive")]), [["a.status: alive", true], ["b.status: stopped", false]]);
  assert.equal($("#error").hidden, false);
  assert.match($("#error").textContent, /usage.py failed: boom/);
  assert.match($("#error").textContent, /Settings: s.json ignored: bad/);
});

test("empty board says where it looked", () => {
  const { api, $ } = page();
  api.push(snap([]));
  assert.match($(".empty").textContent, /No sessions found in \/board/);
});

test("order: blocked, waiting, working, idle, unreported, done", () => {
  const { api, $$ } = page();
  const r = (session, state, extra = {}) => row({ session, entry: state ? { state, task: "t", ...extra } : null });
  api.push(snap([r("done", "done", { done_epoch: 1 }), r("unrep", null), r("idle", "idle"), r("work", "working"), r("wait", "waiting"), r("blocked", "working", { blocker: "x" })]));
  assert.deepEqual($$(".card .sid").map((n) => n.textContent), ["blocked", "wait", "work", "idle", "unrep", "done"]);
});

test("card: state, project, model, full id, name from note, notes, items, blocker, stale", () => {
  const { api, $ } = page();
  api.push(snap([row({
    session: "c572e59b-8d6a-49bc-9a22-80a830bafce6", stale: true,
    entry: { agent: "claude-code", model: "opus", state: "working", cwd: "/p/proj", task: "the task", blocker: "need input",
      items: ["one", "two"], notes: ["name: helper", "a note"], items_left: 2, eta: "5 min", tokens_left: 1000 },
  })]));
  const card = $(".card");
  assert.equal(card.querySelector(".state").textContent, "working");
  assert.equal(card.querySelector(".project").textContent, "proj");
  assert.equal(card.querySelector(".tag").textContent, "stale entry");
  assert.equal(card.querySelector(".model").textContent, "claude-code · opus");
  assert.equal(card.querySelector(".sid").textContent, "c572e59b-8d6a-49bc-9a22-80a830bafce6");
  assert.equal(card.querySelector(".name").textContent, "helper");
  assert.equal(card.querySelector(".task").textContent, "the task");
  assert.equal(card.querySelector(".blocker").textContent, "Blocked: need input");
  assert.deepEqual([...card.querySelectorAll("ul:not(.notes) li")].map((n) => n.textContent), ["one", "two"]);
  assert.deepEqual([...card.querySelectorAll("ul.notes li")].map((n) => n.textContent), ["a note"], "the name note is not repeated");
  const stats = Object.fromEntries([...card.querySelectorAll(".grid > div")].map((d) => [d.firstChild.textContent, d.lastChild.textContent]));
  assert.equal(stats["items left"], "2");
  assert.equal(stats.ETA, "5 min");
  assert.equal(stats["projected left"], "1k");
  assert.equal(stats.output, "2k");
});

test("unreported card falls back to usage and the session title", () => {
  const { api, $ } = page();
  api.push(snap([row({ entry: null, usage: { agent: "copilot", model: "gpt", cwd: "/x/repo", title: "fix it", idle_minutes: 1 } })]));
  const card = $(".card");
  assert.equal(card.querySelector(".state").textContent, "unreported");
  assert.equal(card.querySelector(".model").textContent, "copilot · gpt");
  assert.equal(card.querySelector(".task").textContent, "(title) fix it");
  assert.equal(card.querySelector(".name"), null);
});

test("done card shows when it reached done and closes messaging", () => {
  const { api, $ } = page();
  api.push(snap([row({ entry: { state: "done", task: "t", done_epoch: 1794000000 } })]));
  assert.match($(".doneat").textContent, /^done at /);
  assert.equal($(".messaging").textContent, "Done: messaging closed.");
  assert.equal($(".msgbar"), null);
});

test("links: open when present, describe when gone or unknown", () => {
  const { api, $, $$ } = page();
  api.push(snap([row({ links: { context: { path: "/ctx", exists: true }, memory: { path: "/mem", exists: false } } }),
    row({ session: "s-2", links: { context: { path: null, exists: false }, memory: { path: null, exists: false } } })]));
  const [first, second] = $$(".links");
  const link = first.querySelector("a");
  assert.equal(link.textContent, "context folder");
  assert.equal(link.title, "/ctx");
  link.click();
  assert.deepEqual(api.calls.at(-1), ["openPath", "/ctx"]);
  assert.equal(first.querySelector(".gone").textContent, "memory no longer available (none saved, or removed)");
  assert.deepEqual([...second.querySelectorAll(".gone")].map((n) => n.textContent), ["context folder unknown", "no memory location known"]);
  assert.ok($(".links"));
});

test("filters: show unreported and hide done", () => {
  const { api, $, $$, win } = page();
  api.push(snap([row(), row({ session: "u", entry: null }), row({ session: "d", entry: { state: "done", done_epoch: 1 } })]));
  assert.equal($$(".card").length, 3);
  $("#showUnreported").checked = false;
  $("#showUnreported").dispatchEvent(new win.Event("change"));
  assert.deepEqual($$(".card .sid").map((n) => n.textContent), ["s-1", "d"]);
  $("#hideDone").checked = true;
  $("#hideDone").dispatchEvent(new win.Event("change"));
  assert.deepEqual($$(".card .sid").map((n) => n.textContent), ["s-1"]);
});

test("refresh button renders what refresh returns", async () => {
  const { api, $ } = page();
  api.push(snap([]));
  api.results.refresh = snap([row()]);
  $("#refresh").click();
  await tick();
  assert.ok(api.calls.some((c) => c[0] === "refresh"));
  assert.equal($(".card .sid").textContent, "s-1");
});

test("messaging: composer, send, status, inbox line and notes", async () => {
  const { api, $, win } = page();
  api.push(snap([row({ inbox: { unread: 2, lastRead: null } })]));
  assert.equal($(".msgbar .waiting").textContent, "2 messages waiting");
  $(".msgbar button").click();
  const box = $(".composer textarea");
  assert.ok(box, "composer opens");
  box.value = "please add tests";
  box.dispatchEvent(new win.Event("input"));
  $(".composer .actions button.primary").click();
  await tick();
  await tick();
  assert.deepEqual(api.calls.find((c) => c[0] === "sendMessage"), ["sendMessage", "s-1", "please add tests"]);
  assert.equal($(".composer .message").textContent, "Sent to its inbox.");
  assert.equal($(".composer textarea").value, "", "draft cleared after sending");
  api.results.sendMessage = { ok: false, error: "nope" };
  $(".composer .actions button.primary").click();
  await tick();
  await tick();
  assert.equal($(".composer .message").textContent, "nope");
});

test("messaging: draft survives refreshes; no redraw while typing", async () => {
  const { api, $, win, $$ } = page();
  api.push(snap([row()]));
  $(".msgbar button").click();
  const box = $(".composer textarea");
  box.value = "half written";
  box.dispatchEvent(new win.Event("input"));
  box.focus();
  api.push(snap([row(), row({ session: "s-2" })]));
  assert.equal($$(".card").length, 1, "no redraw while the composer has focus");
  box.blur();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal($$(".card").length, 2, "redrawn after blur");
  assert.equal($(".composer textarea").value, "half written", "draft kept");
});

test("messaging notes: unreported and idle sessions; Open session", async () => {
  const { api, $, $$ } = page();
  api.push(snap([row({ session: "u", entry: null, open: null }), row({ session: "i", entry: { state: "idle", task: "t" } })]));
  for (const b of $$(".msgbar button")) if (b.textContent === "Message…") b.click();
  const notes = $$(".composer .note").map((n) => n.textContent);
  assert.ok(notes.some((n) => /doesn't publish its status/.test(n)));
  assert.ok(notes.some((n) => /It is idle: it reads messages only when it next publishes/.test(n)));
  const cards = $$(".card");
  const openUnreported = [...cards.find((c) => c.querySelector(".sid").textContent === "u").querySelectorAll(".composer button")].find((b) => b.textContent.startsWith("Open session"));
  assert.equal(openUnreported.disabled, true, "no target: Open session disabled");
  const openIdle = [...cards.find((c) => c.querySelector(".sid").textContent === "i").querySelectorAll(".composer button")].find((b) => b.textContent.startsWith("Open session"));
  openIdle.click();
  await tick();
  assert.deepEqual(api.calls.find((c) => c[0] === "openSession"), ["openSession", "i"]);
});

test("Open session label says attach for background Claude sessions", () => {
  const { api, $ } = page();
  api.push(snap([row({ open: { kind: "attach", id: "s-1" } })]));
  $(".msgbar button").click();
  assert.ok([...composerButtons($)].some((b) => b.textContent === "Open session (attach)"));
});

/**
 * Buttons of the open composer.
 * @param {Function} $ Query helper.
 * @returns {HTMLElement[]} Buttons.
 */
function composerButtons($) {
  return $(".composer").querySelectorAll("button");
}

test("Onboard: only live unreported sessions; copies the prompt and opens the session", async () => {
  const { api, $, $$ } = page();
  api.push(snap([
    row({ session: "live-unrep", entry: null, liveNow: true }),
    row({ session: "idle-unrep", entry: null, liveNow: false }),
    row({ session: "reporting", liveNow: true }),
  ]));
  const onboard = $$("button").filter((b) => b.textContent === "Onboard");
  assert.equal(onboard.length, 1);
  assert.equal(onboard[0].closest(".card").querySelector(".sid").textContent, "live-unrep");
  onboard[0].click();
  await tick();
  await tick();
  const copied = api.calls.find((c) => c[0] === "copyText")[1];
  assert.match(copied, /\/skills\/session-status\/SKILL\.md/);
  assert.match(copied, /session id live-unrep/);
  assert.deepEqual(api.calls.find((c) => c[0] === "openSession"), ["openSession", "live-unrep"]);
  assert.match($(".composer .message").textContent, /Prompt copied: paste it/);
});

test("Onboard is disabled without a skill path or a way to open; reports failures", async () => {
  const { api, $$ } = page();
  api.push(snap([row({ session: "a", entry: null, open: null })], { skillPath: null }));
  assert.equal($$("button").find((b) => b.textContent === "Onboard").disabled, true);
  api.push(snap([row({ session: "b", entry: null })]));
  api.results.openSession = { ok: false, error: "no way" };
  $$("button").find((b) => b.textContent === "Onboard").click();
  await tick();
  await tick();
  assert.match($$(".composer .message")[0].textContent, /could not open the session \(no way\)/);
});

test("settings panel: fill, save numbers, show errors", async () => {
  const { api, $, $$, win } = page();
  api.push(snap([]));
  const button = $("#settingsButton");
  assert.ok(button, "Settings button added to the header");
  button.click();
  const panel = $(".settings-panel");
  assert.equal(panel.hidden, false);
  const inputs = Object.fromEntries($$(".settings-panel input").map((i) => [i.name, i]));
  assert.equal(inputs.viewerBoardSeconds.value, "5");
  assert.equal(inputs.viewerBoardSeconds.min, "1");
  assert.equal(inputs.doneVisibleHours.max, "720");
  assert.match($(".settings-panel .where").textContent, /session-status\.json/);
  inputs.viewerBoardSeconds.value = "9";
  $(".settings-panel form").dispatchEvent(new win.Event("submit", { cancelable: true }));
  await tick();
  const saved = api.calls.find((c) => c[0] === "saveSettings")[1];
  assert.equal(saved.viewerBoardSeconds, 9);
  assert.equal(typeof saved.doneVisibleHours, "number");
  assert.equal($(".settings-panel .message").textContent, "Saved.");
  api.results.saveSettings = { ok: false, error: "too big" };
  $(".settings-panel form").dispatchEvent(new win.Event("submit", { cancelable: true }));
  await tick();
  assert.equal($(".settings-panel .message").textContent, "too big");
  [...$(".settings-panel").querySelectorAll("button")].find((b) => b.textContent === "Close").click();
  assert.equal(panel.hidden, true);
});

test("no Settings button in the view when the host has its own settings (VS Code)", () => {
  const api = fakeApi();
  api.openSettings = () => api.calls.push(["openSettings"]);
  const win = loadPage("index.html", ["shared/renderer.js"], { statusApi: api });
  api.push(snap([]));
  assert.equal(win.document.getElementById("settingsButton"), null, "the gear in the Sessions title bar is the way in");
  assert.equal(win.document.querySelector(".settings-panel"), null, "no in-page form");
});

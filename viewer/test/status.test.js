/**
 * Unit tests of shared/status.js: the status monitor used by both the
 * Electron app and the VS Code extension.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { board, writeJson, waitFor, tmp } = require("./helpers");
const status = require("../shared/status");

/**
 * Start a monitor on a temporary board, with `claude agents` disabled.
 * @param {import("node:test").TestContext} t Test context.
 * @param {object} b Board from helpers.board().
 * @param {object} [extra] Extra options.
 * @returns {{m: object, snaps: object[]}} Monitor and the snapshots it pushed.
 */
function monitor(t, b, extra = {}) {
  const snaps = [];
  const m = status.createMonitor({
    board: b.board, usagePy: b.usagePy, settingsFile: b.settingsFile, claudeCandidates: [],
    onChange: (s) => snaps.push(s), ...extra,
  });
  t.after(() => m.dispose());
  return { m, snaps };
}

const now = () => Date.now() / 1000;

test("validSettings keeps in-range numbers and defaults the rest", () => {
  const d = status.validSettings({});
  assert.deepEqual(d, { statusSessionSeconds: 300, viewerUsageSeconds: 30, viewerBoardSeconds: 5, doneVisibleHours: 12 });
  const v = status.validSettings({ viewerBoardSeconds: 2, viewerUsageSeconds: 5, doneVisibleHours: 0, statusSessionSeconds: "60", _doc: {} });
  assert.equal(v.viewerBoardSeconds, 2);
  assert.equal(v.viewerUsageSeconds, 30, "below range falls back to default");
  assert.equal(v.doneVisibleHours, 0, "0 is in range");
  assert.equal(v.statusSessionSeconds, 300, "strings are not numbers");
  assert.deepEqual(status.validSettings(null), d);
  assert.deepEqual(status.validSettings([1, 2]), d);
  assert.equal(status.validSettings({ viewerBoardSeconds: Infinity }).viewerBoardSeconds, 5);
});

test("parseUsage keys records by session and skips junk", () => {
  const m = status.parseUsage('{"session":"a","output":1}\nnot json\n\n{"x":1}\n{"session":"b"}\n');
  assert.deepEqual([...m.keys()], ["a", "b"]);
  assert.equal(m.get("a").output, 1);
});

test("readBoard separates entries from heartbeats and ignores other files", (t) => {
  const b = board(t);
  b.entry({ session: "s1", state: "working" });
  writeJson(path.join(b.board, ".claude-opus-5-5.status.json"), { model: "claude-opus-5-5", session: "claude-opus-5-5.status", beat_epoch: now() });
  writeJson(path.join(b.board, ".gpt-6.status.json"), { model: "gpt-6", session: "gpt-6.status", beat_epoch: now() - 3600 });
  writeJson(path.join(b.board, ".usage-viewer.status.json"), { session: "nope" });
  writeJson(path.join(b.board, ".request.json"), { by: "x" });
  fs.writeFileSync(path.join(b.board, "broken.json"), "{");
  writeJson(path.join(b.board, "nosession.json"), { state: "working" });
  const { entries, monitors } = status.readBoard(b.board);
  assert.deepEqual(entries.map((e) => e.session), ["s1"]);
  assert.ok(entries[0].age_minutes >= 0 && entries[0].age_minutes < 1);
  const alive = Object.fromEntries(monitors.map((x) => [x.model, x.alive]));
  assert.deepEqual(alive, { "claude-opus-5-5": true, "gpt-6": false });
  assert.deepEqual(status.readBoard(path.join(b.dir, "missing")), { entries: [], monitors: [] });
});

test("snapshot joins entries with usage; usage-only sessions are unreported", async (t) => {
  const b = board(t, [
    { session: "s1", agent: "test", output: 10, last: new Date().toISOString(), idle_minutes: 1 },
    { session: "u1", agent: "copilot", output: 5, idle_minutes: 60 },
  ]);
  b.entry({ session: "s1", state: "working" });
  const { m } = monitor(t, b);
  const snap = await waitFor(() => { const s = m.snapshot(); return s.rows.some((r) => r.usage) && s; });
  const rows = Object.fromEntries(snap.rows.map((r) => [r.session, r]));
  assert.equal(rows.s1.entry.state, "working");
  assert.equal(rows.s1.usage.output, 10);
  assert.equal(rows.u1.entry, null);
  assert.equal(rows.u1.usage.agent, "copilot");
  assert.equal(snap.usageError, null);
});

test("usage.py failure is reported, not thrown", async (t) => {
  const b = board(t);
  fs.writeFileSync(b.usagePy, "import sys\nsys.stderr.write('boom\\n')\nsys.exit(3)\n");
  const { m } = monitor(t, b);
  const snap = await waitFor(() => { const s = m.snapshot(); return s.usageError && s; });
  assert.match(snap.usageError, /boom/);
});

test("stale: active since last publish, but never for done sessions", async (t) => {
  const old = now() - 600;
  const last = new Date().toISOString();
  const b = board(t, [{ session: "w", last }, { session: "d", last }, { session: "fresh", last: new Date(old * 1000).toISOString() }]);
  b.entry({ session: "w", state: "working", updated_epoch: old });
  b.entry({ session: "d", state: "done", updated_epoch: old, done_epoch: old });
  b.entry({ session: "fresh", state: "working", updated_epoch: old });
  const { m } = monitor(t, b);
  const snap = await waitFor(() => { const s = m.snapshot(); return s.rows.every((r) => r.usage) && s; });
  const stale = Object.fromEntries(snap.rows.map((r) => [r.session, r.stale]));
  assert.deepEqual(stale, { w: true, d: false, fresh: false });
});

test("done sessions expire after doneVisibleHours, with their usage", async (t) => {
  const b = board(t, [{ session: "old" }, { session: "recent" }]);
  b.entry({ session: "recent", state: "done", done_epoch: now() - 3600 });
  b.entry({ session: "old", state: "done", done_epoch: now() - 13 * 3600 });
  b.entry({ session: "legacy", state: "done", updated_epoch: now() - 13 * 3600 });
  const { m } = monitor(t, b);
  const snap = await waitFor(() => { const s = m.snapshot(); return s.rows.some((r) => r.usage) && s; });
  assert.deepEqual(snap.rows.map((r) => r.session).sort(), ["recent"], "old (and its usage) and legacy (no done_epoch) expired");
  assert.ok(snap.rows[0].entry.done_epoch);
});

test("settings: defaults when missing, live reload, half-written file ignored", async (t) => {
  const b = board(t);
  fs.rmSync(b.settingsFile);
  const { m } = monitor(t, b);
  assert.equal(m.snapshot().settings.viewerBoardSeconds, 5);
  assert.equal(m.snapshot().settingsError, null);
  writeJson(b.settingsFile, { viewerBoardSeconds: 2, doneVisibleHours: 1 });
  await waitFor(() => m.snapshot().settings.viewerBoardSeconds === 2, 8000);
  assert.equal(m.snapshot().settings.doneVisibleHours, 1);
  fs.writeFileSync(b.settingsFile, '{"viewerBoardSeconds": 1,');
  await waitFor(() => m.snapshot().settingsError, 8000);
  assert.equal(m.snapshot().settings.viewerBoardSeconds, 2, "previous settings kept");
  assert.deepEqual(m.snapshot().settingRanges.viewerBoardSeconds, [1, 300]);
});

test("saveSettings validates, keeps other keys, refuses a broken file", (t) => {
  const b = board(t);
  writeJson(b.settingsFile, { _doc: { about: "x" }, viewerUsageSeconds: 30 });
  const { m } = monitor(t, b);
  const ok = m.saveSettings({ viewerBoardSeconds: 7, doneVisibleHours: "24" });
  assert.equal(ok.ok, true);
  assert.equal(ok.settings.viewerBoardSeconds, 7);
  assert.equal(ok.settings.doneVisibleHours, 24, "numeric strings from inputs are accepted");
  const file = JSON.parse(fs.readFileSync(b.settingsFile, "utf8"));
  assert.deepEqual(file._doc, { about: "x" });
  assert.equal(file.viewerUsageSeconds, 30);
  assert.equal(m.snapshot().settings.viewerBoardSeconds, 7, "applied at once");
  assert.match(m.saveSettings({ viewerBoardSeconds: 0 }).error, /from 1 to 300/);
  assert.match(m.saveSettings({ nope: 1 }).error, /unknown setting/);
  assert.equal(m.saveSettings(null).ok, false);
  fs.writeFileSync(b.settingsFile, "{");
  assert.match(m.saveSettings({ viewerBoardSeconds: 3 }).error, /not valid JSON/);
  assert.equal(fs.readFileSync(b.settingsFile, "utf8"), "{", "broken file untouched");
  writeJson(b.settingsFile, [1]);
  assert.match(m.saveSettings({ viewerBoardSeconds: 3 }).error, /not a JSON object/);
});

test("saveSettings creates a missing file", (t) => {
  const b = board(t);
  fs.rmSync(path.dirname(b.settingsFile), { recursive: true });
  const { m } = monitor(t, b);
  assert.equal(m.saveSettings({ viewerUsageSeconds: 60 }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(b.settingsFile, "utf8")).viewerUsageSeconds, 60);
});

test("links: usage paths checked for existence; board-only sessions located by id", async (t) => {
  const b = board(t);
  const ctx = path.join(b.dir, "ctx");
  fs.mkdirSync(ctx);
  b.setUsage([{ session: "u", context_dir: ctx, memory: path.join(b.dir, "gone") }]);
  b.entry({ session: "g", agent: "gemini" });
  b.entry({ session: "cp-missing-session", agent: "copilot" });
  const { m } = monitor(t, b);
  const snap = await waitFor(() => { const s = m.snapshot(); return s.rows.some((r) => r.usage) && s; });
  const rows = Object.fromEntries(snap.rows.map((r) => [r.session, r]));
  assert.deepEqual(rows.u.links.context, { path: ctx, exists: true });
  assert.equal(rows.u.links.memory.exists, false);
  assert.deepEqual(rows.g.links.context, { path: null, exists: false }, "unknown for agents not laid out by id");
  assert.ok(rows["cp-missing-session"].links.context.path.endsWith(path.join("session-state", "cp-missing-session")));
  assert.equal(rows["cp-missing-session"].links.context.exists, false);
  assert.equal(m.isOpenablePath(ctx), true);
  assert.equal(m.isOpenablePath(path.join(b.dir, "gone")), false, "missing paths are not openable");
  assert.equal(m.isOpenablePath("/etc/passwd"), false, "paths outside the status are not openable");
  assert.equal(m.isOpenablePath(42), false);
});

test("sendMessage writes the inbox format, refuses unknown, unsafe, empty, long and done", (t) => {
  const b = board(t);
  b.entry({ session: "w", state: "working", cwd: b.dir });
  b.entry({ session: "d", state: "done", done_epoch: now() });
  const { m } = monitor(t, b, { sender: "tester" });
  m.snapshot();
  const r = m.sendMessage("w", "  hello  ");
  assert.equal(r.ok, true);
  const files = fs.readdirSync(path.join(b.board, "inbox", "w"));
  assert.equal(files.length, 1);
  const msg = JSON.parse(fs.readFileSync(path.join(b.board, "inbox", "w", files[0]), "utf8"));
  assert.equal(msg.text, "hello");
  assert.equal(msg.sender, "tester");
  assert.equal(msg.to, "w");
  assert.equal(msg.id, r.id);
  assert.match(msg.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(m.sendMessage("nobody", "x").error, "unknown session");
  assert.equal(m.sendMessage("../w", "x").error, "unknown session");
  assert.equal(m.sendMessage("w", "   ").error, "empty message");
  assert.match(m.sendMessage("w", "x".repeat(8001)).error, /longer than/);
  assert.match(m.sendMessage("d", "x").error, /done/);
  assert.equal(m.snapshot().rows.find((x) => x.session === "w").inbox.unread, 1);
});

test("inbox state counts unread and reports the last read time", (t) => {
  const b = board(t);
  b.entry({ session: "s" });
  writeJson(path.join(b.board, "inbox", "s", "2.json"), { text: "x" });
  writeJson(path.join(b.board, "inbox", "s", "read", "1.json"), { text: "y", read_at: "2026-11-07T10:00:00Z" });
  const { m } = monitor(t, b);
  assert.deepEqual(m.snapshot().rows[0].inbox, { unread: 1, lastRead: "2026-11-07T10:00:00Z" });
});

test("sessionTarget, sessionAgent and liveNow", async (t) => {
  const b = board(t, [{ session: "live", agent: "claude-code", model: "m", idle_minutes: 2, cwd: "/" }, { session: "idle", idle_minutes: 120 }]);
  const dir = tmp(t);
  b.entry({ session: "live", state: "working", cwd: dir });
  b.entry({ session: "nocwd", state: "working", cwd: path.join(dir, "gone") });
  const { m } = monitor(t, b);
  const snap = await waitFor(() => { const s = m.snapshot(); return s.rows.some((r) => r.usage) && s; });
  const rows = Object.fromEntries(snap.rows.map((r) => [r.session, r]));
  assert.equal(rows.live.liveNow, true);
  assert.equal(rows.idle.liveNow, false);
  assert.equal(rows.nocwd.liveNow, false);
  assert.deepEqual(m.sessionTarget("live"), { kind: "folder", path: dir });
  assert.equal(m.sessionTarget("nocwd"), null, "missing folder: nothing to open");
  assert.equal(m.sessionTarget("unknown"), null);
  assert.deepEqual(m.sessionAgent("live"), { agent: "test", model: "m", cwd: dir, live: true }, "board entry wins over usage");
  assert.equal(m.sessionAgent("unknown"), null);
});

test("snapshot carries the skill path, and refresh/dispose are safe", (t) => {
  const b = board(t);
  const { m } = monitor(t, b, { skillPath: "/x/SKILL.md" });
  assert.equal(m.snapshot().skillPath, "/x/SKILL.md");
  m.refresh();
  m.dispose();
  m.refresh();
  assert.equal(m.saveSettings({ viewerBoardSeconds: 9 }).ok, true);
});

test("board changes push snapshots", async (t) => {
  const b = board(t);
  const { snaps } = monitor(t, b);
  await waitFor(() => snaps.length > 0);
  const before = snaps.length;
  b.entry({ session: "new" });
  await waitFor(() => snaps.length > before && snaps[snaps.length - 1].rows.some((r) => r.session === "new"), 8000);
});

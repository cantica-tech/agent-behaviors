/**
 * Unit tests of the Electron app's main process (main.js), the chat process
 * manager (chat/chat-main.js) and both preloads, with Electron, the status
 * monitor and child_process mocked: no window opens, no `claude` or
 * `osascript` runs.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { ROOT, tmp, loadWithMocks } = require("./helpers");

/**
 * Fake Electron, child_process and status monitor, recording everything.
 * @returns {object} The fakes: {electron, childProcess, statusModule, rec, monitor}.
 */
function fakes() {
  const rec = { handlers: {}, windows: [], sent: [], opened: [], clipboard: [], execFile: [], spawned: [], dock: null, appEvents: {} };
  let nextId = 1;
  class BrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this.events = {};
      this.destroyed = false;
      const win = this;
      this.webContents = { id: nextId++, send: (...a) => rec.sent.push([win, ...a]), on: (ev, fn) => (win.events[`wc:${ev}`] = fn) };
      rec.windows.push(this);
    }
    loadFile(f) {
      this.loaded = f;
    }
    isDestroyed() {
      return this.destroyed;
    }
    on(ev, fn) {
      this.events[ev] = fn;
    }
    static getAllWindows() {
      return rec.windows;
    }
  }
  const electron = {
    app: { whenReady: () => Promise.resolve(), on: (ev, fn) => (rec.appEvents[ev] = fn), dock: { setIcon: (i) => (rec.dock = i) }, quit() {} },
    BrowserWindow,
    ipcMain: { handle: (ch, fn) => (rec.handlers[ch] = fn) },
    nativeImage: { createFromPath: (p) => ({ path: p }) },
    shell: { openPath: async (p) => (rec.opened.push(p), rec.openError || "") },
    clipboard: { writeText: (t) => rec.clipboard.push(t) },
    dialog: { showOpenDialog: async (_w, o) => (rec.dialog = o, { canceled: false, filePaths: ["/picked/a.txt"] }) },
  };
  const childProcess = {
    execFile: (cmd, args, cb) => {
      rec.execFile.push([cmd, args]);
      cb(rec.execError || null);
    },
    spawn: (cmd, args, opts) => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.written = [];
      proc.stdin = { write: (s) => proc.written.push(s) };
      proc.killed = [];
      proc.kill = (sig) => proc.killed.push(sig || "SIGTERM");
      rec.spawned.push({ cmd, args, opts, proc });
      return proc;
    },
  };
  const monitor = {
    calls: [],
    agent: null,
    target: null,
    snapshot: () => ({ rows: [] }),
    refresh: () => monitor.calls.push(["refresh"]),
    saveSettings: (v) => (monitor.calls.push(["saveSettings", v]), { ok: true }),
    sendMessage: (s, t) => (monitor.calls.push(["sendMessage", s, t]), { ok: true }),
    sessionAgent: () => monitor.agent,
    sessionTarget: () => monitor.target,
    isOpenablePath: (p) => p === "/allowed",
    dispose: () => monitor.calls.push(["dispose"]),
  };
  const statusModule = { createMonitor: (opts) => ((rec.monitorOpts = opts), monitor) };
  return { electron, childProcess, statusModule, rec, monitor };
}

/**
 * Load main.js (and with it chat-main.js) against the fakes, and let
 * app.whenReady() run.
 * @returns {Promise<object>} The fakes.
 */
async function loadMain() {
  const f = fakes();
  loadWithMocks("main.js", { electron: f.electron, child_process: f.childProcess, "./shared/status": f.statusModule });
  await new Promise((r) => setTimeout(r, 0));
  return f;
}

test("startup: monitor options, main window, dock icon", async () => {
  const { rec } = await loadMain();
  assert.equal(rec.monitorOpts.usageState, "viewer");
  assert.equal(rec.monitorOpts.usagePy, path.join(ROOT, "..", "session-status", "scripts", "usage.py"));
  assert.equal(rec.monitorOpts.skillPath, path.join(ROOT, "..", "session-status", "SKILL.md"));
  const win = rec.windows[0];
  assert.equal(win.loaded, path.join(ROOT, "index.html"));
  assert.equal(win.opts.webPreferences.contextIsolation, true);
  assert.equal(win.opts.webPreferences.sandbox, true);
  assert.equal(win.opts.webPreferences.nodeIntegration, false);
  if (process.platform === "darwin") assert.equal(rec.dock.path, path.join(ROOT, "icons", "icon.png"));
});

test("snapshots are pushed to the window", async () => {
  const { rec } = await loadMain();
  rec.monitorOpts.onChange({ rows: ["x"] });
  assert.deepEqual(rec.sent.at(-1).slice(1), ["status", { rows: ["x"] }]);
  rec.windows[0].destroyed = true;
  const before = rec.sent.length;
  rec.monitorOpts.onChange({ rows: [] });
  assert.equal(rec.sent.length, before, "nothing sent to a destroyed window");
});

test("IPC: refresh, save-settings, send-message go to the monitor", async () => {
  const { rec, monitor } = await loadMain();
  assert.deepEqual(await rec.handlers.refresh(), { rows: [] });
  assert.deepEqual(await rec.handlers["save-settings"]({}, { viewerBoardSeconds: 3 }), { ok: true });
  assert.deepEqual(await rec.handlers["send-message"]({}, "s1", "hi"), { ok: true });
  assert.deepEqual(monitor.calls, [["refresh"], ["saveSettings", { viewerBoardSeconds: 3 }], ["sendMessage", "s1", "hi"]]);
});

test("IPC open-path: only paths the monitor allows", async () => {
  const { rec } = await loadMain();
  assert.equal(await rec.handlers["open-path"]({}, "/allowed"), "");
  assert.match(await rec.handlers["open-path"]({}, "/etc/passwd"), /not a context or memory path/);
  assert.deepEqual(rec.opened, ["/allowed"]);
});

test("IPC copy-text: strings up to 10000 characters", async () => {
  const { rec } = await loadMain();
  assert.equal(await rec.handlers["copy-text"]({}, "prompt"), true);
  assert.equal(await rec.handlers["copy-text"]({}, "x".repeat(10001)), false);
  assert.equal(await rec.handlers["copy-text"]({}, 42), false);
  assert.deepEqual(rec.clipboard, ["prompt"]);
});

test("IPC open-session: folder, attach (Terminal on macOS), unknown, failure", async () => {
  const { rec, monitor } = await loadMain();
  monitor.agent = { agent: "copilot", cwd: "/p" };
  monitor.target = { kind: "folder", path: "/p" };
  assert.deepEqual(await rec.handlers["open-session"]({}, "s"), { ok: true });
  assert.deepEqual(rec.opened, ["/p"]);
  rec.openError = "boom";
  assert.deepEqual(await rec.handlers["open-session"]({}, "s"), { ok: false, error: "boom" });
  monitor.target = { kind: "attach", id: "abc-123" };
  const res = await rec.handlers["open-session"]({}, "s");
  if (process.platform === "darwin") {
    assert.deepEqual(res, { ok: true });
    const [cmd, args] = rec.execFile[0];
    assert.equal(cmd, "osascript");
    assert.ok(args.includes('tell application "Terminal" to do script "claude attach abc-123"'));
    rec.execError = new Error("denied");
    assert.deepEqual(await rec.handlers["open-session"]({}, "s"), { ok: false, error: "denied" });
  } else {
    assert.deepEqual(res, { ok: false, error: "run: claude attach abc-123" });
  }
  monitor.target = null;
  assert.match((await rec.handlers["open-session"]({}, "s")).error, /cannot be opened/);
});

test("IPC open-session: Claude Code sessions open a chat window", async (t) => {
  const { rec, monitor } = await loadMain();
  const cwd = tmp(t);
  monitor.agent = { agent: "claude-code", cwd, live: true };
  assert.deepEqual(await rec.handlers["open-session"]({}, "sess-1"), { ok: true });
  const chatWin = rec.windows.at(-1);
  assert.equal(chatWin.loaded, path.join(ROOT, "chat", "chat.html"));
  assert.equal(chatWin.opts.title, `Chat · ${path.basename(cwd)}`);
  assert.equal(chatWin.opts.webPreferences.preload, path.join(ROOT, "chat", "preload.js"));
  monitor.agent = { agent: "claude-code", cwd: path.join(cwd, "gone"), live: false };
  assert.match((await rec.handlers["open-session"]({}, "sess-1")).error, /folder is unknown or gone/);
});

/**
 * Open a chat window through main.js and return what's needed to drive it.
 * @param {import("node:test").TestContext} t Test context.
 * @param {boolean} live Whether the session is live (fork).
 * @returns {Promise<object>} {rec, win, ev, cwd, call}.
 */
async function openChat(t, live) {
  const f = await loadMain();
  const cwd = tmp(t);
  fs.writeFileSync(path.join(cwd, "notes.md"), "x");
  f.monitor.agent = { agent: "claude-code", cwd, live };
  await f.rec.handlers["open-session"]({}, "sess-1");
  const win = f.rec.windows.at(-1);
  const ev = { sender: { id: win.webContents.id } };
  const call = (ch, ...args) => f.rec.handlers[ch](ev, ...args);
  const events = () => f.rec.sent.filter((s) => s[0] === win && s[1] === "chat-event").map((s) => s[2]);
  return { ...f, win, ev, cwd, call, events };
}

test("chat: info, files and file picking", async (t) => {
  const { call, cwd, rec } = await openChat(t, true);
  const info = await call("chat-info");
  assert.equal(info.sessionId, "sess-1");
  assert.equal(info.fork, true);
  assert.equal(info.mode, "manual");
  assert.ok(info.modes.includes("acceptEdits"));
  assert.ok(info.commands.includes("compact"));
  assert.deepEqual(await call("chat-files", "not"), ["notes.md"]);
  assert.deepEqual(await call("chat-pick"), ["/picked/a.txt"]);
  assert.equal(rec.dialog.defaultPath, cwd);
  assert.equal(await rec.handlers["chat-info"]({ sender: { id: 999 } }), null, "unknown window");
});

test("chat: first message starts claude (resume + fork when live) and writes stream-json", async (t) => {
  const { call, rec, cwd } = await openChat(t, true);
  assert.deepEqual(await call("chat-send", "  ", []), { ok: false, error: "empty message" });
  assert.deepEqual(await call("chat-send", "hello", ["relative/ignored.txt"]), { ok: true });
  const { cmd, args, opts, proc } = rec.spawned[0];
  assert.match(cmd, /claude$/);
  assert.ok(args.includes("--resume") && args[args.indexOf("--resume") + 1] === "sess-1");
  assert.ok(args.includes("--fork-session"));
  assert.equal(opts.cwd, cwd);
  assert.equal(opts.env.ELECTRON_RUN_AS_NODE, undefined);
  const line = JSON.parse(proc.written[0]);
  assert.deepEqual(line, { type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } });
  await call("chat-send", "again", []);
  assert.equal(rec.spawned.length, 1, "one process per window while it runs");
  assert.equal(proc.written.length, 2);
});

test("chat: stdout lines (split across chunks) become window events; fork id adopted", async (t) => {
  const { call, rec, events } = await openChat(t, true);
  await call("chat-send", "hi", []);
  const { proc } = rec.spawned[0];
  const init = JSON.stringify({ type: "system", subtype: "init", session_id: "forked-1", model: "m", slash_commands: ["x"] });
  proc.stdout.emit("data", Buffer.from(`${init.slice(0, 10)}`));
  proc.stdout.emit("data", Buffer.from(`${init.slice(10)}\nnot json\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "yo" }] } })}\n`));
  proc.stderr.emit("data", Buffer.from("warn"));
  const kinds = events().map((e) => e.kind);
  assert.deepEqual(kinds, ["status", "init", "assistant", "stderr"]);
  assert.equal(events()[1].sessionId, "forked-1");
  assert.equal((await call("chat-info")).sessionId, "forked-1");
  proc.emit("exit", 0);
  assert.equal(events().at(-1).kind, "exit");
  await call("chat-send", "next", []);
  const second = rec.spawned[1].args;
  assert.equal(second[second.indexOf("--resume") + 1], "forked-1", "restart resumes the fork");
  assert.ok(!second.includes("--fork-session"), "no second fork");
});

test("chat: not live means no fork; Stop interrupts; mode change restarts with the new mode", async (t) => {
  const { call, rec } = await openChat(t, false);
  await call("chat-send", "hi", []);
  assert.ok(!rec.spawned[0].args.includes("--fork-session"));
  await call("chat-stop");
  assert.deepEqual(rec.spawned[0].proc.killed, ["SIGINT"]);
  assert.equal(await call("chat-mode", "nonsense"), false);
  assert.equal(await call("chat-mode", "acceptEdits"), true);
  assert.deepEqual(rec.spawned[0].proc.killed, ["SIGINT", "SIGTERM"]);
  rec.spawned[0].proc.emit("exit", null);
  await call("chat-send", "again", []);
  const args = rec.spawned[1].args;
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
});

test("chat: closing the window kills its process", async (t) => {
  const { call, rec, win } = await openChat(t, false);
  await call("chat-send", "hi", []);
  win.events.closed();
  assert.deepEqual(rec.spawned[0].proc.killed, ["SIGTERM"]);
});

test("chat: spawn errors are reported to the window", async (t) => {
  const { call, rec, events } = await openChat(t, false);
  await call("chat-send", "hi", []);
  rec.spawned[0].proc.emit("error", new Error("ENOENT"));
  assert.equal(events().at(-1).text, "Could not start claude: ENOENT");
});

/**
 * Load a preload against a fake Electron and return what it exposed.
 * @param {string} file Preload path under the viewer root.
 * @returns {{api: object, calls: Array, listeners: object, name: string}} Exposed API and recorded IPC.
 */
function loadPreload(file) {
  const out = { calls: [], listeners: {} };
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => Object.assign(out, { name, api }) },
    ipcRenderer: { invoke: (...a) => (out.calls.push(a), Promise.resolve("ok")), on: (ch, fn) => (out.listeners[ch] = fn) },
  };
  loadWithMocks(file, { electron });
  return out;
}

test("preload: statusApi maps each method to its IPC channel", async () => {
  const { name, api, calls, listeners } = loadPreload("preload.js");
  assert.equal(name, "statusApi");
  await api.refresh();
  await api.saveSettings({ a: 1 });
  await api.openPath("/p");
  await api.sendMessage("s", "t");
  await api.openSession("s");
  await api.copyText("c");
  assert.deepEqual(calls, [["refresh"], ["save-settings", { a: 1 }], ["open-path", "/p"], ["send-message", "s", "t"], ["open-session", "s"], ["copy-text", "c"]]);
  let got = null;
  api.onStatus((s) => (got = s));
  listeners.status({}, { rows: [1] });
  assert.deepEqual(got, { rows: [1] });
});

test("chat preload: chatApi maps each method to its IPC channel", async () => {
  const { name, api, calls, listeners } = loadPreload("chat/preload.js");
  assert.equal(name, "chatApi");
  await api.info();
  await api.send("hi", ["/a"]);
  await api.stop();
  await api.setMode("plan");
  await api.files("q");
  await api.pickFiles();
  assert.deepEqual(calls, [["chat-info"], ["chat-send", "hi", ["/a"]], ["chat-stop"], ["chat-mode", "plan"], ["chat-files", "q"], ["chat-pick"]]);
  let got = null;
  api.onEvent((e) => (got = e));
  listeners["chat-event"]({}, { kind: "init" });
  assert.deepEqual(got, { kind: "init" });
});

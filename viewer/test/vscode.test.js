/**
 * Unit tests of the VS Code extension (vscode/extension.js) with a fake
 * `vscode` API and a fake status monitor, and of its webview bridge
 * (vscode/media/bridge.js) in jsdom.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { loadWithMocks, loadPage } = require("./helpers");

/** A temporary AgentsMonitor folder per test file, so tests never touch ~/.agent-behaviors. */
const MONITOR_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-monitor-"));
process.on("exit", () => fs.rmSync(MONITOR_ROOT, { recursive: true, force: true }));
let monitorCount = 0;

/**
 * A fake webview recording what the extension posts and set up.
 * @returns {object} Fake webview with `posted` and `receive(msg)`.
 */
function fakeWebview() {
  const wv = {
    posted: [],
    cspSource: "vscode-csp",
    asWebviewUri: (u) => `webview:${u.fsPath}`,
    postMessage: (m) => (wv.posted.push(m), Promise.resolve(true)),
    onDidReceiveMessage: (fn) => ((wv.handler = fn), { dispose: () => (wv.handler = null) }),
    receive: (m) => wv.handler(m),
  };
  return wv;
}

/**
 * Fake vscode API, fake monitor module, and a record of everything.
 * @param {object} [settings] agentStatus settings.
 * @returns {object} {vscode, statusModule, rec, monitor(i)}.
 */
function fakes(settings = {}) {
  const rec = { commands: {}, executed: [], externals: [], terminals: [], panels: [], providers: {}, shown: [], infos: [], errors: [],
    clipboard: [], monitors: [], available: ["claude-vscode.editor.open", "workbench.action.chat.open", "mistral-vibe-code.open", "chatgpt.openSidebar"],
    configListeners: [], trees: {}, warnings: [], statusMessages: [], saved: [] };
  const conf = { showStatusBar: true, python: "python3", boardDirectory: "", usageScript: "",
    agentsMonitorFolder: path.join(MONITOR_ROOT, `m${monitorCount++}`), chatCommands: {
    claude: { command: "claude-vscode.editor.open", withSession: true },
    copilot: { command: "workbench.action.chat.open" },
    mistral: { command: "mistral-vibe-code.open" },
    codex: { command: "chatgpt.openSidebar" },
  }, ...settings };
  const file = (p) => ({ fsPath: p, path: p, scheme: "file" });
  class Disposable {
    constructor(fn) {
      this.fn = fn;
    }
    dispose() {
      this.fn();
    }
  }
  const vscode = {
    Uri: { file, joinPath: (base, ...parts) => file(path.join(base.fsPath, ...parts)) },
    Disposable,
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    ThemeIcon: class {
      constructor(id) {
        this.id = id;
      }
    },
    TreeItem: class {
      constructor(label) {
        this.label = label;
      }
    },
    EventEmitter: class {
      constructor() {
        this.fired = 0;
        this.event = () => ({ dispose() {} });
      }
      fire() {
        this.fired++;
      }
    },
    StatusBarAlignment: { Left: 1 },
    ViewColumn: { Active: -1 },
    workspace: {
      workspaceFolders: [{ uri: file("/work/here") }],
      getConfiguration: () => ({ get: (k) => conf[k], inspect: (k) => ({ globalValue: (rec.userSet || {})[k] }) }),
      onDidChangeConfiguration: (fn) => (rec.configListeners.push(fn), { dispose() {} }),
    },
    window: {
      createStatusBarItem: () => (rec.status = { visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }),
      createWebviewPanel: (type, title, col, opts) => {
        const panel = { type, title, opts, webview: fakeWebview(), revealed: 0, reveal() { this.revealed++; },
          onDidDispose(fn) { this.disposeFn = fn; }, dispose() { this.disposeFn(); } };
        rec.panels.push(panel);
        return panel;
      },
      createTreeView: (id, opts) => ((rec.trees[id] = { id, provider: opts.treeDataProvider, dispose() {} }), rec.trees[id]),
      registerWebviewViewProvider: (id, provider, opts) => ((rec.providers[id] = { provider, opts }), { dispose() {} }),
      createTerminal: (opts) => {
        const term = { opts, sent: [], shown: false, show() { this.shown = true; }, sendText(t) { this.sent.push(t); } };
        rec.terminals.push(term);
        return term;
      },
      showTextDocument: async (uri) => {
        if (rec.showFails) throw new Error("nope");
        rec.shown.push(uri.fsPath);
      },
      showInformationMessage: (m, ...buttons) => (rec.infos.push(m), Promise.resolve(buttons.length ? rec.answer : undefined)),
      showQuickPick: async (items) => ((rec.quickPick = items), rec.pick ? rec.pick(items) : undefined),
      showWarningMessage: (m) => rec.warnings.push(m),
      setStatusBarMessage: (m) => rec.statusMessages.push(m),
      showErrorMessage: (m) => rec.errors.push(m),
    },
    commands: {
      registerCommand: (id, fn) => ((rec.commands[id] = fn), { dispose() {} }),
      executeCommand: async (...a) => rec.executed.push(a),
      getCommands: async () => rec.available,
    },
    env: {
      openExternal: async (u) => rec.externals.push(u.fsPath),
      clipboard: { writeText: async (t) => rec.clipboard.push(t) },
    },
  };
  const statusModule = {
    DEFAULT_SETTINGS_FILE: "/home/.agent-behaviors/session-status.json",
    createMonitor: (opts) => {
      const m = { opts, calls: [], agent: null, target: null, disposed: false,
        snapshot: () => ({ rows: rec.initialRows || [], settingsFile: "/cfg/s.json" }),
        refresh: () => m.calls.push("refresh"),
        saveSettings: (v) => (rec.saved.push(v), rec.saveResult || { ok: true, v }),
        sendMessage: (s, t) => ({ ok: true, s, t }),
        sessionAgent: () => m.agent,
        sessionTarget: () => m.target,
        isOpenablePath: (p) => p === "/allowed",
        dispose: () => (m.disposed = true) };
      rec.monitors.push(m);
      return m;
    },
  };
  const skillsModule = {
    entries: [],
    installed: [],
    missing: () => skillsModule.entries,
    findSkills: () => [{ name: "session-status" }, { name: "markdown" }],
    summary: (es) => es.map((e) => e.agent.name).join(", "),
    install: (e) => (skillsModule.installed.push(e.agent.id), { added: e.missing.map((s) => s.name), errors: [] }),
  };
  return { vscode, statusModule, skillsModule, rec, conf };
}

/**
 * Load and activate the extension against fakes.
 * @param {object} [settings] agentStatus settings.
 * @returns {object} {ext, rec, conf, monitor, context}.
 */
function activate(settings, initialRows, extensionPath = "/ext", version = "1.0.0", pre = {}) {
  const f = fakes(settings);
  Object.assign(f.rec, pre);
  f.rec.initialRows = initialRows;
  if (f.rec.skillEntries) f.skillsModule.entries = f.rec.skillEntries;
  const ext = loadWithMocks("vscode/extension.js", { vscode: f.vscode, "./media/status": f.statusModule, "./media/agent-skills": f.skillsModule });
  const state = new Map(f.rec.globalState || []);
  const context = { extensionPath, extensionUri: f.vscode.Uri.file(extensionPath), subscriptions: [],
    extension: { packageJSON: { version } },
    globalState: { get: (k) => state.get(k), update: async (k, v) => state.set(k, v) } };
  ext.activate(context);
  return { ext, ...f, context, monitor: () => f.rec.monitors.at(-1) };
}

const row = (session, state, extra = {}) => ({ session, entry: state ? { state, ...extra } : null });

test("activate: monitor options, status bar, commands, sidebar provider", () => {
  const { rec, monitor } = activate();
  const m = monitor();
  assert.equal(m.opts.usagePy, path.join("/ext", "media", "usage.py"));
  assert.equal(m.opts.usageState, "vscode");
  assert.equal(m.opts.python, "python3");
  assert.equal(m.opts.board, undefined, "empty setting: default board");
  assert.equal(rec.status.command, "agentStatus.open");
  assert.deepEqual(Object.keys(rec.commands).sort(), ["agentStatus.addSkills", "agentStatus.open", "agentStatus.openSettings", "agentStatus.refresh"]);
  assert.equal(rec.providers["agentStatus.sidebar"].opts.webviewOptions.retainContextWhenHidden, true);
});

test("activate: settings pass through to the monitor", () => {
  const { monitor } = activate({ boardDirectory: "/b", usageScript: "/u.py", python: "/py3" });
  assert.equal(monitor().opts.board, "/b");
  assert.equal(monitor().opts.usagePy, "/u.py");
  assert.equal(monitor().opts.python, "/py3");
});

test("status bar: working/waiting/blocked counts, warning colour, hide setting", () => {
  const { rec, monitor, conf } = activate();
  monitor().opts.onChange({ rows: [row("a", "working"), row("b", "working", { blocker: "x" }), row("c", "waiting"), row("d", null)] });
  assert.equal(rec.status.text, "$(pulse) 2 working · 1 waiting · 1 blocked");
  assert.match(rec.status.tooltip, /4 agent sessions \(3 reporting\)/);
  assert.equal(rec.status.backgroundColor.id, "statusBarItem.warningBackground");
  assert.equal(rec.status.visible, true);
  monitor().opts.onChange({ rows: [row("a", "working")] });
  assert.equal(rec.status.text, "$(pulse) 1 working");
  assert.equal(rec.status.backgroundColor, undefined);
  conf.showStatusBar = false;
  monitor().opts.onChange({ rows: [] });
  assert.equal(rec.status.visible, false);
});

test("counts show at activation: status bar and badge from the first, synchronous snapshot", () => {
  const { rec } = activate({}, [row("a", "working"), row("b", "idle"), row("c", null)]);
  assert.equal(rec.status.text, "$(pulse) 1 working", "status bar set before any timer or usage.py run");
  assert.equal(rec.status.visible, true);
  assert.deepEqual(rec.trees["agentStatus.summary"].badge, { value: 2, tooltip: "2 reporting agent sessions" },
    "badge set at activation, without opening the sidebar");
});

test("badge: counts reporting sessions, singular tooltip, none at 0", () => {
  const { rec, monitor } = activate();
  const tree = rec.trees["agentStatus.summary"];
  assert.equal(tree.badge, undefined, "no badge when nobody reports");
  monitor().opts.onChange({ rows: [row("a", "working")] });
  assert.deepEqual(tree.badge, { value: 1, tooltip: "1 reporting agent session" });
  monitor().opts.onChange({ rows: [row("c", null)] });
  assert.equal(tree.badge, undefined);
});

test("Summary view: one line per session, blocked and waiting first, refreshed on change", () => {
  const { rec, monitor } = activate();
  const provider = rec.trees["agentStatus.summary"].provider;
  const fired = provider.emitter.fired;
  monitor().opts.onChange({ rows: [
    { session: "u", entry: null, usage: { agent: "copilot", cwd: "/x/repo", title: "fix" } },
    { session: "w", entry: { state: "working", cwd: "/p/proj", task: "build", agent: "claude-code", model: "m" } },
    { session: "b", entry: { state: "working", cwd: "/p/other", blocker: "needs input" } },
    { session: "q", entry: { state: "waiting", cwd: "/p/wait" } },
  ] });
  assert.ok(provider.emitter.fired > fired, "tree refreshed");
  const items = provider.getChildren().map((r) => provider.getTreeItem(r));
  assert.deepEqual(items.map((i) => i.label), ["other · working", "wait · waiting", "proj · working", "repo · unreported"]);
  assert.equal(items[0].description, "blocked: needs input");
  assert.equal(items[0].iconPath.id, "warning");
  assert.equal(items[2].description, "build");
  assert.match(items[2].tooltip, /claude-code · m\nw\nbuild/);
  assert.equal(items[3].description, "(title) fix");
  assert.equal(items[2].command.command, "agentStatus.open");
  assert.equal(items[2].id, "w");
});

test("sidebar webview: filled when VS Code resolves it", () => {
  const { rec } = activate();
  const view = { webview: fakeWebview(), onDidDispose(fn) { this.disposeFn = fn; } };
  rec.providers["agentStatus.sidebar"].provider.resolveWebviewView(view);
  assert.equal(view.webview.options.enableScripts, true);
  assert.match(view.webview.html, /Content-Security-Policy/);
  view.disposeFn();
});

test("panel: opened once then revealed; HTML has a nonce CSP and local resources", () => {
  const { rec } = activate();
  rec.commands["agentStatus.open"]();
  rec.commands["agentStatus.open"]();
  assert.equal(rec.panels.length, 1);
  assert.equal(rec.panels[0].revealed, 1);
  const html = rec.panels[0].webview.html;
  const nonce = /'nonce-([^']+)'/.exec(html)[1];
  assert.ok(nonce.length >= 16);
  assert.equal((html.match(new RegExp(`nonce="${nonce.replace(/[+/=]/g, "\\$&")}"`, "g")) || []).length, 2, "both scripts carry the nonce");
  assert.match(html, /default-src 'none'/);
  assert.match(html, /webview:\/ext\/media\/styles\.css/);
  assert.match(html, /webview:\/ext\/media\/bridge\.js/);
  assert.match(html, /webview:\/ext\/media\/renderer\.js/);
  assert.match(html, /<div class="titleline">\s*<h1>Agent Status<\/h1>\s*<span id="meta">/, "title and status on a line of their own");
  assert.ok(html.indexOf('class="titleline"') < html.indexOf('class="filters"'), "controls come after the title line");
  assert.match(html, /id="showUnreported"/);
  assert.match(html, /id="hideDone"/);
  assert.deepEqual(rec.panels[0].opts.localResourceRoots.map((u) => u.fsPath), [path.join("/ext", "media")]);
  assert.equal(rec.panels[0].iconPath.light.fsPath, path.join("/ext", "media", "viewer.svg"));
  rec.panels[0].dispose();
  rec.commands["agentStatus.open"]();
  assert.equal(rec.panels.length, 2, "a new panel after the old one closed");
});

test("html: a fresh nonce each time", () => {
  const { ext, vscode } = activate();
  const wv = fakeWebview();
  const media = vscode.Uri.file("/ext/media");
  assert.notEqual(/'nonce-([^']+)'/.exec(ext._test.html(wv, media))[1], /'nonce-([^']+)'/.exec(ext._test.html(wv, media))[1]);
});

/**
 * Open the panel and return its webview, after one snapshot.
 * @param {object} a Activated extension handles.
 * @returns {object} The fake webview.
 */
function panelWebview(a) {
  a.monitor().opts.onChange({ rows: [row("a", "working")], settingsFile: "/cfg/s.json" });
  a.rec.commands["agentStatus.open"]();
  return a.rec.panels[0].webview;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("webview messages: ready, refresh, saveSettings, sendMessage", async () => {
  const a = activate();
  const wv = panelWebview(a);
  wv.receive({ type: "ready" });
  assert.equal(wv.posted.at(-1).type, "status");
  wv.receive({ type: "refresh" });
  assert.deepEqual(a.monitor().calls, ["refresh"]);
  wv.receive({ type: "saveSettings", id: 3, values: { viewerBoardSeconds: 2 } });
  assert.deepEqual(wv.posted.at(-1), { type: "result", id: 3, result: { ok: true, v: { viewerBoardSeconds: 2 } } });
  wv.receive({ type: "sendMessage", id: 4, session: "a", text: "hi" });
  assert.deepEqual(wv.posted.at(-1), { type: "result", id: 4, result: { ok: true, s: "a", t: "hi" } });
});

test("webview messages: copyText (bounded) and openPath (allowlisted)", async () => {
  const a = activate();
  const wv = panelWebview(a);
  wv.receive({ type: "copyText", id: 5, text: "prompt" });
  await tick();
  assert.deepEqual(wv.posted.at(-1), { type: "result", id: 5, result: true });
  wv.receive({ type: "copyText", id: 6, text: "x".repeat(10001) });
  await tick();
  assert.deepEqual(wv.posted.at(-1), { type: "result", id: 6, result: false });
  assert.deepEqual(a.rec.clipboard, ["prompt"]);
  wv.receive({ type: "openPath", path: "/allowed" });
  wv.receive({ type: "openPath", path: "/etc/passwd" });
  assert.deepEqual(a.rec.externals, ["/allowed"]);
});

test("openSession: the agent's own chat when configured and installed", async () => {
  const a = activate();
  const wv = panelWebview(a);
  const open = async (agent, model) => {
    a.monitor().agent = { agent, model };
    a.rec.executed.length = 0;
    wv.receive({ type: "openSession", id: 7, session: "sess" });
    await tick();
    await tick();
    return { executed: a.rec.executed.slice(), result: wv.posted.at(-1) };
  };
  let r = await open("claude-code", "claude-opus-5-5");
  assert.deepEqual(r.executed, [["claude-vscode.editor.open", "sess"]], "Claude Code reopens that session");
  assert.deepEqual(r.result, { type: "result", id: 7, result: { ok: true, note: "opened in its chat" } });
  r = await open("copilot", "gpt-6");
  assert.deepEqual(r.executed, [["workbench.action.chat.open"]]);
  r = await open("vibe", "mistral-large");
  assert.deepEqual(r.executed, [["mistral-vibe-code.open"]], "matched on the model");
  r = await open("codex", "gpt-5");
  assert.deepEqual(r.executed, [["chatgpt.openSidebar"]]);
});

test("openSession: fallbacks when there is no chat (attach, folder here, new window, none)", async () => {
  const a = activate();
  const wv = panelWebview(a);
  a.monitor().agent = { agent: "gemini", model: "gemini-2-5-pro" };
  const go = async () => {
    wv.receive({ type: "openSession", id: 8, session: "sess" });
    await tick();
    await tick();
    return wv.posted.at(-1).result;
  };
  a.monitor().target = { kind: "attach", id: "abc", cwd: "/p" };
  assert.deepEqual(await go(), { ok: true });
  assert.deepEqual(a.rec.terminals[0].sent, ["claude attach abc"]);
  assert.equal(a.rec.terminals[0].opts.cwd, "/p");
  assert.equal(a.rec.terminals[0].shown, true);
  a.monitor().target = { kind: "folder", path: "/work/here" };
  assert.deepEqual(await go(), { ok: true });
  assert.match(a.rec.infos.at(-1), /runs in this window's project/);
  a.monitor().target = { kind: "folder", path: "/elsewhere" };
  assert.deepEqual(await go(), { ok: true });
  assert.deepEqual(a.rec.executed.at(-1), ["vscode.openFolder", { fsPath: "/elsewhere", path: "/elsewhere", scheme: "file" }, { forceNewWindow: true }]);
  a.monitor().target = null;
  assert.match((await go()).error, /cannot be opened/);
});

test("openSession: a chat command that is not installed falls back", async () => {
  const a = activate();
  a.rec.available = [];
  const wv = panelWebview(a);
  a.monitor().agent = { agent: "claude-code", model: "m" };
  a.monitor().target = { kind: "folder", path: "/elsewhere" };
  wv.receive({ type: "openSession", id: 9, session: "s" });
  await tick();
  await tick();
  assert.equal(a.rec.executed.at(-1)[0], "vscode.openFolder");
});

test("openSession: chatCommands can add agents (e.g. Grok)", async () => {
  const a = activate({ chatCommands: { grok: { command: "grok.chat.open" } } });
  a.rec.available.push("grok.chat.open");
  const wv = panelWebview(a);
  a.monitor().agent = { agent: "grok-cli", model: "grok-4" };
  wv.receive({ type: "openSession", id: 10, session: "s" });
  await tick();
  await tick();
  assert.deepEqual(a.rec.executed.at(-1), ["grok.chat.open"]);
});

test("Settings opens VS Code's settings on the extension's page (command and webview button)", async () => {
  const a = activate();
  await a.rec.commands["agentStatus.openSettings"]();
  assert.deepEqual(a.rec.executed.at(-1), ["workbench.action.openSettings", "@ext:canticatech.cantica-agent-status"]);
  const wv = panelWebview(a);
  a.rec.executed.length = 0;
  wv.receive({ type: "openSettings" });
  await tick();
  assert.deepEqual(a.rec.executed, [["workbench.action.openSettings", "@ext:canticatech.cantica-agent-status"]]);
  assert.equal(a.rec.shown.length, 0, "the JSON file is not opened");
});

test("refresh settings changed in VS Code are saved to session-status.json, without restarting", () => {
  const a = activate();
  a.rec.userSet = { viewerBoardSeconds: 9, doneVisibleHours: 24 };
  a.rec.configListeners[0]({ affectsConfiguration: (s) => s === "agentStatus" || s === "agentStatus.viewerBoardSeconds" });
  assert.deepEqual(a.rec.saved, [{ viewerBoardSeconds: 9, doneVisibleHours: 24 }]);
  assert.equal(a.rec.monitors.length, 1, "monitor not restarted");
  a.rec.saveResult = { ok: false, error: "out of range" };
  a.rec.configListeners[0]({ affectsConfiguration: (s) => s === "agentStatus" || s === "agentStatus.viewerBoardSeconds" });
  assert.match(a.rec.warnings.concat(a.rec.errors).at(-1), /settings not saved: out of range/);
  a.rec.userSet = {};
  const before = a.rec.saved.length;
  a.ext._test.saveFileSettings();
  assert.equal(a.rec.saved.length, before, "nothing written when nothing is set by the user");
});

/**
 * An extension folder with bundled skills, for the deployment tests.
 * @returns {string} Its path.
 */
function bundledExtension() {
  const ext = fs.mkdtempSync(path.join(MONITOR_ROOT, "ext-"));
  fs.mkdirSync(path.join(ext, "skills", "session-status", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(ext, "skills", "README.md"), "readme v1");
  fs.writeFileSync(path.join(ext, "skills", "LICENSE"), "Apache");
  fs.writeFileSync(path.join(ext, "skills", "session-status", "scripts", "board.py"), "print(1)");
  return ext;
}

test("skills are deployed into <AgentsMonitor>/skills at activation, once per version", () => {
  const ext = bundledExtension();
  const a = activate({}, [], ext, "1.0.0");
  const target = path.join(a.conf.agentsMonitorFolder, "skills");
  assert.equal(fs.readFileSync(path.join(target, "README.md"), "utf8"), "readme v1");
  assert.ok(fs.existsSync(path.join(target, "LICENSE")));
  assert.ok(fs.existsSync(path.join(target, "session-status", "scripts", "board.py")));
  assert.equal(fs.readFileSync(path.join(target, ".cantica-agent-status-version"), "utf8").trim(), "1.0.0");
  assert.match(a.rec.statusMessages.at(-1), /skills deployed to/);
  fs.writeFileSync(path.join(target, "README.md"), "edited by the user");
  fs.writeFileSync(path.join(target, "mine.txt"), "keep");
  const same = a.ext._test.deploySkills(a.context);
  assert.equal(same.status, "current", "same version: not copied again");
  assert.equal(fs.readFileSync(path.join(target, "README.md"), "utf8"), "edited by the user");
  const upgraded = a.ext._test.deploySkills({ ...a.context, extension: { packageJSON: { version: "1.0.1" } } });
  assert.equal(upgraded.status, "deployed");
  assert.equal(fs.readFileSync(path.join(target, "README.md"), "utf8"), "readme v1", "new version overwrites shipped files");
  assert.equal(fs.readFileSync(path.join(target, "mine.txt"), "utf8"), "keep", "other files kept");
});

test("a skills folder that is a link is never written to", () => {
  const ext = bundledExtension();
  const folder = path.join(MONITOR_ROOT, `linked${monitorCount++}`);
  const checkout = path.join(MONITOR_ROOT, `checkout${monitorCount++}`);
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(checkout, { recursive: true });
  fs.writeFileSync(path.join(checkout, "README.md"), "the repository's own README");
  fs.symlinkSync(checkout, path.join(folder, "skills"));
  const a = activate({ agentsMonitorFolder: folder }, [], ext);
  assert.equal(a.ext._test.deploySkills(a.context).status, "linked");
  assert.equal(fs.readFileSync(path.join(checkout, "README.md"), "utf8"), "the repository's own README");
  assert.equal(a.rec.warnings.length, 0);
});

test("AgentsMonitor folder: ~ expanded, change redeploys; missing bundle is reported", () => {
  const a = activate({ agentsMonitorFolder: "~/somewhere" });
  assert.equal(a.ext._test.agentsMonitorFolder(), path.join(os.homedir(), "somewhere"));
  assert.match(a.rec.warnings.at(-1), /skills not deployed .*no skills bundled/);
  const ext = bundledExtension();
  const b = activate({}, [], ext, "2.0.0");
  b.conf.agentsMonitorFolder = path.join(MONITOR_ROOT, `moved${monitorCount++}`);
  b.rec.configListeners[0]({ affectsConfiguration: (s) => s === "agentStatus" || s === "agentStatus.agentsMonitorFolder" });
  assert.ok(fs.existsSync(path.join(b.conf.agentsMonitorFolder, "skills", "LICENSE")));
  assert.equal(b.rec.monitors.length, 2, "monitor restarted for non-file settings");
});

test("refresh command, configuration change restarts the monitor, dispose stops it", () => {
  const a = activate();
  a.rec.commands["agentStatus.refresh"]();
  assert.deepEqual(a.monitor().calls, ["refresh"]);
  const first = a.monitor();
  a.rec.configListeners[0]({ affectsConfiguration: (s) => s === "editor" });
  assert.equal(a.rec.monitors.length, 1, "unrelated change ignored");
  a.rec.configListeners[0]({ affectsConfiguration: (s) => s === "agentStatus" });
  assert.equal(first.disposed, true);
  assert.equal(a.rec.monitors.length, 2);
  for (const d of a.context.subscriptions) d.dispose();
  assert.equal(a.monitor().disposed, true);
  a.ext.deactivate();
});

/**
 * Load the bridge in jsdom with a fake acquireVsCodeApi.
 * @returns {{win: Window, posted: object[], send: Function}} Handles; send(data) delivers a message to the page.
 */
function bridge() {
  const posted = [];
  const win = loadPage("<!doctype html><body></body>", ["vscode/media/bridge.js"], {
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) }),
  });
  const send = (data) => win.dispatchEvent(new win.MessageEvent("message", { data }));
  return { win, posted, send };
}

test("bridge: onStatus says ready and delivers snapshots", () => {
  const { win, posted, send } = bridge();
  const got = [];
  win.statusApi.onStatus((s) => got.push(s.n));
  assert.deepEqual(posted, [{ type: "ready" }]);
  send({ type: "status", snapshot: { n: 1 } });
  send({ type: "other" });
  assert.deepEqual(got, [1]);
});

test("bridge: requests carry ids and resolve with their own result", async () => {
  const { win, posted, send } = bridge();
  const p1 = win.statusApi.saveSettings({ a: 1 });
  const p2 = win.statusApi.sendMessage("s", "t");
  const p3 = win.statusApi.openSession("s");
  const p4 = win.statusApi.copyText("c");
  assert.deepEqual(posted.map((m) => m.type), ["saveSettings", "sendMessage", "openSession", "copyText"]);
  assert.deepEqual(posted[0], { type: "saveSettings", id: posted[0].id, values: { a: 1 } });
  assert.deepEqual(posted[1], { type: "sendMessage", id: posted[1].id, session: "s", text: "t" });
  assert.equal(new Set(posted.map((m) => m.id)).size, 4, "distinct ids");
  send({ type: "result", id: posted[1].id, result: "second" });
  send({ type: "result", id: posted[0].id, result: "first" });
  send({ type: "result", id: posted[3].id, result: true });
  send({ type: "result", id: posted[2].id, result: { ok: true } });
  send({ type: "result", id: 999, result: "ignored" });
  assert.equal(await p1, "first");
  assert.equal(await p2, "second");
  assert.equal((await p3).ok, true);
  assert.equal(await p4, true);
});

test("bridge: openPath posts; refresh resolves with the next snapshot", async () => {
  const { win, posted, send } = bridge();
  win.statusApi.onStatus(() => {});
  win.statusApi.openPath("/p");
  assert.deepEqual(posted.at(-1), { type: "openPath", path: "/p" });
  const p = win.statusApi.refresh();
  assert.deepEqual(posted.at(-1), { type: "refresh" });
  send({ type: "status", snapshot: { n: 2 } });
  assert.equal((await p).n, 2);
});

/** Plan entries for agents lacking skills, as agent-skills.missing() returns them. */
const lacking = [
  { agent: { id: "vibe", name: "Mistral Vibe" }, missing: [{ name: "session-status" }, { name: "markdown" }] },
  { agent: { id: "codex", name: "Codex" }, missing: [{ name: "markdown" }] },
];

test("skills offer: asked after deployment; Add links them into every agent that lacks them", async () => {
  const a = activate({}, [], bundledExtension(), "1.0.0", { skillEntries: lacking, answer: "Add" });
  await tick();
  await tick();
  const offer = a.rec.infos.find((m) => /add the agent skills/.test(m));
  assert.match(offer, /\(session-status, markdown\) to Mistral Vibe, Codex\?/);
  assert.deepEqual(a.skillsModule.installed, ["vibe", "codex"]);
  assert.match(a.rec.infos.at(-1), /skills added \(Mistral Vibe: session-status, markdown; Codex: markdown\)/);
});

test("skills offer: Not now does nothing; Don't ask again is remembered", async () => {
  const later = activate({}, [], bundledExtension(), "1.0.0", { skillEntries: lacking, answer: "Not now" });
  await tick();
  assert.deepEqual(later.skillsModule.installed, []);
  const never = activate({}, [], bundledExtension(), "1.0.0", { skillEntries: lacking, answer: "Don't ask again" });
  await tick();
  assert.equal(never.context.globalState.get("agentStatus.skillsOfferDeclined"), true);
  const again = activate({}, [], bundledExtension(), "1.0.0", { skillEntries: lacking, globalState: [["agentStatus.skillsOfferDeclined", true]] });
  await tick();
  assert.equal(again.rec.infos.filter((m) => /add the agent skills/.test(m)).length, 0, "not asked again");
});

test("skills offer: nothing asked when every agent has the skills", async () => {
  const a = activate();
  await tick();
  assert.equal(a.rec.infos.filter((m) => /add the agent skills/.test(m)).length, 0);
});

test("Add Skills to Agents command: pick the agents, even after Don't ask again", async () => {
  const a = activate({}, [], "/ext", "1.0.0", { skillEntries: lacking, globalState: [["agentStatus.skillsOfferDeclined", true]] });
  a.rec.pick = (items) => items.filter((i) => i.label === "Codex");
  await a.rec.commands["agentStatus.addSkills"]();
  assert.deepEqual(a.rec.quickPick.map((i) => [i.label, i.description, i.picked]),
    [["Mistral Vibe", "session-status, markdown", true], ["Codex", "markdown", true]]);
  assert.deepEqual(a.skillsModule.installed, ["codex"]);
  a.skillsModule.entries = [];
  await a.rec.commands["agentStatus.addSkills"]();
  assert.match(a.rec.infos.at(-1), /every detected agent already has the skills/);
});

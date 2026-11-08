/**
 * Agent Status: VS Code extension.
 *
 * Shows the live status of the agent sessions on this machine (the
 * session-status board in ~/.agent-behaviors/status, joined with measured
 * token usage from usage.py) in a webview panel, plus a status-bar summary.
 * The monitor and UI are shared with the Electron viewer (media/ holds copies
 * synced from ../shared). Read-only towards the board.
 */

const vscode = require("vscode");
const crypto = require("crypto");
const path = require("path");
const { createMonitor, DEFAULT_SETTINGS_FILE } = require("./media/status");

/** The open webview panel, or null. */
let panel = null;
/** Every live webview showing the view (editor panel and activity-bar view). */
const webviews = new Set();
/** The Summary tree view: created at activation, so its badge shows from startup. */
let summaryView = null;
/** Data provider of the Summary tree view. */
let summary = null;
/** The running status monitor, or null. */
let monitor = null;
/** Status-bar item with the session summary. */
let statusItem = null;
/** Latest snapshot, to show immediately when the panel opens. */
let latest = null;

/**
 * Read this extension's settings.
 * @returns {vscode.WorkspaceConfiguration} The `agentStatus` section.
 */
function config() {
  return vscode.workspace.getConfiguration("agentStatus");
}

/**
 * Update the status-bar summary from a snapshot.
 * @param {object} snap Snapshot from the monitor.
 */
function updateStatusBar(snap) {
  if (!statusItem) return;
  if (!config().get("showStatusBar")) {
    statusItem.hide();
    return;
  }
  const states = snap.rows.map((r) => (r.entry && r.entry.state) || "unreported");
  const count = (s) => states.filter((x) => x === s).length;
  const blocked = snap.rows.filter((r) => r.entry && r.entry.blocker).length;
  const parts = [`${count("working")} working`];
  if (count("waiting")) parts.push(`${count("waiting")} waiting`);
  if (blocked) parts.push(`${blocked} blocked`);
  statusItem.text = `$(pulse) ${parts.join(" · ")}`;
  statusItem.tooltip = `${snap.rows.length} agent sessions (${snap.rows.length - count("unreported")} reporting). Click to open Agent Status.`;
  statusItem.backgroundColor = blocked || count("waiting")
    ? new vscode.ThemeColor("statusBarItem.warningBackground")
    : undefined;
  statusItem.show();
}

/**
 * Handle a new snapshot: remember it, refresh the status bar and every webview.
 * @param {object} snap Snapshot from the monitor.
 */
function onSnapshot(snap) {
  latest = snap;
  updateStatusBar(snap);
  updateBadge(snap);
  if (summary) summary.refresh();
  for (const webview of webviews) webview.postMessage({ type: "status", snapshot: snap });
}

/**
 * Show the number of reporting sessions (those with a board entry) as a badge
 * on the activity-bar icon, like Source Control's count of changes. No badge
 * when none report.
 * @param {object} snap Snapshot from the monitor.
 */
function updateBadge(snap) {
  if (!summaryView) return;
  const reporting = snap.rows.filter((r) => r.entry).length;
  summaryView.badge = reporting
    ? { value: reporting, tooltip: `${reporting} reporting agent session${reporting === 1 ? "" : "s"}` }
    : undefined;
}

/**
 * Open the agent's own chat in VS Code, if a chat command is configured for
 * it (agentStatus.chatCommands) and installed. A command whose config says
 * `withSession` gets the session id, so it reopens that very session
 * (Claude Code does); the others open their chat panel.
 * @param {string} session Session id.
 * @returns {Promise<{ok: boolean, note?: string}|null>} Null when no chat applies.
 */
async function openChat(session) {
  const info = monitor && monitor.sessionAgent(session);
  if (!info) return null;
  const map = config().get("chatCommands") || {};
  const key = Object.keys(map).find((k) => {
    const needle = k.toLowerCase();
    return (info.agent || "").toLowerCase().includes(needle) || (info.model || "").toLowerCase().includes(needle);
  });
  const spec = key && map[key];
  if (!spec || !spec.command) return null;
  const available = await vscode.commands.getCommands(true);
  if (!available.includes(spec.command)) return null;
  await vscode.commands.executeCommand(spec.command, ...(spec.withSession ? [session] : []));
  return { ok: true, note: spec.withSession ? "opened in its chat" : "opened its chat panel" };
}

/**
 * Open a session so the user can type to it: a terminal attached to a
 * background Claude Code session, else its project folder (a new window,
 * unless it is already open here).
 * @param {string} session Session id.
 * @returns {Promise<{ok: boolean, error?: string}>} The outcome.
 */
async function openSession(session) {
  const chat = await openChat(session);
  if (chat) return chat;
  const target = monitor && monitor.sessionTarget(session);
  if (!target) return { ok: false, error: "this session cannot be opened" };
  if (target.kind === "attach") {
    const terminal = vscode.window.createTerminal({ name: `claude ${target.id.slice(0, 8)}`, cwd: target.cwd || undefined });
    terminal.show();
    terminal.sendText(`claude attach ${target.id}`); // id matches [A-Za-z0-9._-]
    return { ok: true };
  }
  const here = (vscode.workspace.workspaceFolders || []).some((f) => f.uri.fsPath === target.path);
  if (here) {
    vscode.window.showInformationMessage("Agent Status: this session runs in this window's project; type to it in its chat or terminal.");
    return { ok: true };
  }
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(target.path), { forceNewWindow: true });
  return { ok: true };
}

/**
 * Set up a webview (panel or activity-bar view): options, HTML, messages.
 * @param {vscode.Webview} webview Target webview.
 * @param {vscode.ExtensionContext} context Extension context.
 * @returns {vscode.Disposable} Unregisters the webview; call when it is disposed.
 */
function attachWebview(webview, context) {
  const media = vscode.Uri.joinPath(context.extensionUri, "media");
  webview.options = { enableScripts: true, localResourceRoots: [media] };
  webview.html = html(webview, media);
  webviews.add(webview);
  const sub = webview.onDidReceiveMessage((msg) => {
    if (msg.type === "ready" && latest) webview.postMessage({ type: "status", snapshot: latest });
    if (msg.type === "openPath" && monitor && monitor.isOpenablePath(msg.path)) {
      // Folders open in Finder / the file manager, files in their default app.
      vscode.env.openExternal(vscode.Uri.file(msg.path));
    }
    if (msg.type === "saveSettings") {
      const result = monitor ? monitor.saveSettings(msg.values) : { ok: false, error: "not running" };
      webview.postMessage({ type: "result", id: msg.id, result });
    }
    if (msg.type === "sendMessage") {
      const result = monitor ? monitor.sendMessage(msg.session, msg.text) : { ok: false, error: "not running" };
      webview.postMessage({ type: "result", id: msg.id, result });
    }
    if (msg.type === "copyText") {
      const ok = typeof msg.text === "string" && msg.text.length <= 10000;
      (ok ? vscode.env.clipboard.writeText(msg.text) : Promise.resolve())
        .then(() => webview.postMessage({ type: "result", id: msg.id, result: ok }));
    }
    if (msg.type === "openSession") {
      openSession(msg.session).then((result) => webview.postMessage({ type: "result", id: msg.id, result }));
    }
    if (msg.type === "refresh" && monitor) {
      monitor.refresh();
      onSnapshot(monitor.snapshot());
    }
  });
  return new vscode.Disposable(() => {
    webviews.delete(webview);
    sub.dispose();
  });
}

/**
 * Provider of the activity-bar view: the same UI, in the sidebar.
 * @implements {vscode.WebviewViewProvider}
 */
class SidebarProvider {
  /**
   * @param {vscode.ExtensionContext} context Extension context.
   */
  constructor(context) {
    /** Extension context, for resource URIs. */
    this.context = context;
  }

  /**
   * Fill the view when VS Code shows it.
   * @param {vscode.WebviewView} view The view to fill.
   */
  resolveWebviewView(view) {
    const detach = attachWebview(view.webview, this.context);
    view.onDidDispose(() => detach.dispose());
  }
}

/** Sort rank per state in the Summary view; lower shows first. */
const SUMMARY_ORDER = { waiting: 0, working: 1, idle: 2, unreported: 3, done: 4 };

/**
 * Data of the Summary tree view: one line per session (state, project, task).
 * The view exists from activation, which is what lets the activity-bar badge
 * show the reporting count as soon as VS Code starts.
 * @implements {vscode.TreeDataProvider}
 */
class SummaryProvider {
  constructor() {
    /** Fires when the rows change. */
    this.emitter = new vscode.EventEmitter();
    /** Event VS Code listens to. */
    this.onDidChangeTreeData = this.emitter.event;
  }

  /** Tell VS Code the rows changed. */
  refresh() {
    this.emitter.fire();
  }

  /**
   * Rows of the latest snapshot, blocked and waiting first.
   * @returns {object[]} Rows.
   */
  getChildren() {
    if (!latest) return [];
    const state = (r) => (r.entry && r.entry.state) || "unreported";
    return latest.rows.slice().sort((a, b) => {
      const blocked = Number(Boolean(b.entry && b.entry.blocker)) - Number(Boolean(a.entry && a.entry.blocker));
      return blocked || (SUMMARY_ORDER[state(a)] ?? 2) - (SUMMARY_ORDER[state(b)] ?? 2);
    });
  }

  /**
   * One line for a session; clicking it opens the full view.
   * @param {object} row Joined row.
   * @returns {vscode.TreeItem} The item.
   */
  getTreeItem(row) {
    const e = row.entry || {};
    const u = row.usage || {};
    const state = e.state || "unreported";
    const project = (e.cwd || u.cwd || "").split(/[\\/]/).pop() || "?";
    const item = new vscode.TreeItem(`${project} · ${state}`);
    item.id = row.session;
    item.description = e.blocker ? `blocked: ${e.blocker}` : e.task || (u.title ? `(title) ${u.title}` : "");
    item.tooltip = `${e.agent || u.agent || "?"} · ${e.model || u.model || "?"}\n${row.session}${e.task ? `\n${e.task}` : ""}`;
    item.iconPath = new vscode.ThemeIcon(e.blocker ? "warning" : { working: "sync", waiting: "bell", idle: "debug-pause", done: "check" }[state] || "circle-outline");
    item.command = { command: "agentStatus.open", title: "Open Agent Status" };
    return item;
  }
}

/**
 * (Re)start the monitor with the current settings.
 * @param {vscode.ExtensionContext} context Extension context.
 */
function startMonitor(context) {
  if (monitor) monitor.dispose();
  const cfg = config();
  monitor = createMonitor({
    board: cfg.get("boardDirectory") || undefined,
    usagePy: cfg.get("usageScript") || path.join(context.extensionPath, "media", "usage.py"),
    python: cfg.get("python") || "python3",
    usageState: "vscode",
    onChange: onSnapshot,
  });
  // Show the counts right away: the board is read synchronously; usage follows.
  onSnapshot(monitor.snapshot());
}

/**
 * Build the webview HTML with a strict CSP and a per-load nonce.
 * @param {vscode.Webview} webview Target webview.
 * @param {vscode.Uri} media URI of the media folder.
 * @returns {string} HTML document.
 */
function html(webview, media) {
  const nonce = crypto.randomBytes(16).toString("base64");
  const uri = (name) => webview.asWebviewUri(vscode.Uri.joinPath(media, name));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${uri("styles.css")}">
  <title>Agent Status</title>
</head>
<body>
  <header>
    <div class="titleline">
      <h1>Agent Status</h1>
      <span id="meta">Loading…</span>
    </div>
    <div class="filters">
      <label><input type="checkbox" id="showUnreported" checked> show unreported</label>
      <label><input type="checkbox" id="hideDone"> hide done</label>
    </div>
    <button id="refresh">Refresh</button>
  </header>
  <div id="monitors"></div>
  <div id="error" hidden></div>
  <main id="cards"></main>
  <script nonce="${nonce}" src="${uri("bridge.js")}"></script>
  <script nonce="${nonce}" src="${uri("renderer.js")}"></script>
</body>
</html>`;
}

/**
 * Open the panel, or reveal it if it is already open.
 * @param {vscode.ExtensionContext} context Extension context.
 */
function openPanel(context) {
  if (panel) {
    panel.reveal();
    return;
  }
  const media = vscode.Uri.joinPath(context.extensionUri, "media");
  panel = vscode.window.createWebviewPanel("agentStatus", "Agent Status", vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [media],
  });
  panel.iconPath = {
    light: vscode.Uri.joinPath(media, "viewer.svg"),
    dark: vscode.Uri.joinPath(media, "viewer-dark.svg"),
  };
  const detach = attachWebview(panel.webview, context);
  panel.onDidDispose(() => {
    detach.dispose();
    panel = null;
  });
}

/**
 * Activate the extension: start the monitor, add the status bar and commands.
 * @param {vscode.ExtensionContext} context Extension context.
 */
function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = "agentStatus.open";
  summary = new SummaryProvider();
  summaryView = vscode.window.createTreeView("agentStatus.summary", { treeDataProvider: summary });
  context.subscriptions.push(
    statusItem,
    summaryView,
    vscode.commands.registerCommand("agentStatus.open", () => openPanel(context)),
    vscode.commands.registerCommand("agentStatus.refresh", () => monitor && monitor.refresh()),
    vscode.commands.registerCommand("agentStatus.openSettings", async () => {
      const file = (latest && latest.settingsFile) || DEFAULT_SETTINGS_FILE;
      try {
        await vscode.window.showTextDocument(vscode.Uri.file(file));
      } catch (err) {
        vscode.window.showErrorMessage(`Agent Status: cannot open ${file}: ${err.message}`);
      }
    }),
    vscode.window.registerWebviewViewProvider("agentStatus.sidebar", new SidebarProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentStatus")) startMonitor(context);
    }),
    { dispose: () => monitor && monitor.dispose() },
  );
  startMonitor(context);
}

/** Deactivate: everything is disposed through context.subscriptions. */
function deactivate() {}

module.exports = {
  activate,
  deactivate,
  /** Internals exposed for the unit tests only. */
  _test: {
    updateStatusBar,
    updateBadge,
    openChat,
    openSession,
    html,
    SidebarProvider,
    SummaryProvider,
    get summaryView() {
      return summaryView;
    },
    get monitor() {
      return monitor;
    },
    get latest() {
      return latest;
    },
    get panel() {
      return panel;
    },
    get webviews() {
      return webviews;
    },
  },
};

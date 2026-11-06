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
const { createMonitor } = require("./media/status");

/** The open webview panel, or null. */
let panel = null;
/** Every live webview showing the view (editor panel and activity-bar view). */
const webviews = new Set();
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
  for (const webview of webviews) webview.postMessage({ type: "status", snapshot: snap });
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
    usageIntervalMs: Math.max(10, cfg.get("usageIntervalSeconds") || 30) * 1000,
    onChange: onSnapshot,
  });
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
    <h1>Agent Status</h1>
    <span id="meta">Loading…</span>
    <label><input type="checkbox" id="showUnreported" checked> show unreported</label>
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
  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand("agentStatus.open", () => openPanel(context)),
    vscode.commands.registerCommand("agentStatus.refresh", () => monitor && monitor.refresh()),
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

module.exports = { activate, deactivate };

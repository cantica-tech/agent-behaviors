/**
 * Main process of the agent status viewer (Electron).
 *
 * Opens one window and feeds it snapshots from the shared status monitor
 * (shared/status.js), which reads ~/.agent-behaviors/status and runs
 * ../session-status/scripts/usage.py. Read-only towards the board.
 */

const { app, BrowserWindow, clipboard, ipcMain, nativeImage, shell } = require("electron");
const { execFile } = require("child_process");
const path = require("path");
const { createMonitor } = require("./shared/status");
const { openChatWindow } = require("./chat/chat-main");

/** Measured-usage script shipped with the session-status skill. */
const USAGE_PY = path.join(__dirname, "..", "session-status", "scripts", "usage.py");

/** App icon rendered from viewer.svg (npm run icons). */
const ICON = path.join(__dirname, "icons", "icon.png");

/** The viewer window, or null before it opens. */
let win = null;
/** The shared status monitor, started once the app is ready. */
let monitor = null;

/**
 * Send a snapshot to the window, if it is open.
 * @param {object} snap Snapshot from the monitor.
 */
function send(snap) {
  if (win && !win.isDestroyed()) win.webContents.send("status", snap);
}

/** Open the viewer window. */
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    title: "Agent Status",
    backgroundColor: "#111418",
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));
  win.webContents.on("did-finish-load", () => send(monitor.snapshot()));
}

ipcMain.handle("open-path", (_event, p) =>
  monitor.isOpenablePath(p) ? shell.openPath(p) : "not a context or memory path of the current status");

ipcMain.handle("copy-text", (_event, text) => {
  if (typeof text !== "string" || text.length > 10000) return false;
  clipboard.writeText(text);
  return true;
});

ipcMain.handle("send-message", (_event, session, text) => monitor.sendMessage(session, text));

ipcMain.handle("open-session", async (_event, session) => {
  // Claude Code sessions open in a chat window (resuming, forking when live).
  const info = monitor.sessionAgent(session);
  if (info && info.agent === "claude-code") {
    return openChatWindow({ sessionId: session, cwd: info.cwd, live: info.live,
      title: (info.cwd || "").split("/").pop() });
  }
  const target = monitor.sessionTarget(session);
  if (!target) return { ok: false, error: "this session cannot be opened" };
  if (target.kind === "attach") {
    if (process.platform !== "darwin") return { ok: false, error: `run: claude attach ${target.id}` };
    // target.id matches [A-Za-z0-9._-] (checked by the monitor), so it is safe in the script.
    return new Promise((resolve) => execFile("osascript", [
      "-e", 'tell application "Terminal" to activate',
      "-e", `tell application "Terminal" to do script "claude attach ${target.id}"`,
    ], (err) => resolve(err ? { ok: false, error: err.message } : { ok: true })));
  }
  const error = await shell.openPath(target.path);
  return error ? { ok: false, error } : { ok: true };
});

ipcMain.handle("save-settings", (_event, values) => monitor.saveSettings(values));

ipcMain.handle("refresh", () => {
  monitor.refresh();
  return monitor.snapshot();
});

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) app.dock.setIcon(nativeImage.createFromPath(ICON));
  monitor = createMonitor({
    usagePy: USAGE_PY,
    usageState: "viewer",
    skillPath: path.join(__dirname, "..", "session-status", "SKILL.md"),
    onChange: send,
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => monitor && monitor.dispose());

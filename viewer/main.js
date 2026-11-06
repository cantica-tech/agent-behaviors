/**
 * Main process of the agent status viewer (Electron).
 *
 * Opens one window and feeds it snapshots from the shared status monitor
 * (shared/status.js), which reads ~/.agent-behaviors/status and runs
 * ../session-status/scripts/usage.py. Read-only towards the board.
 */

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { createMonitor } = require("./shared/status");

/** Measured-usage script shipped with the session-status skill. */
const USAGE_PY = path.join(__dirname, "..", "session-status", "scripts", "usage.py");

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

ipcMain.handle("refresh", () => {
  monitor.refresh();
  return monitor.snapshot();
});

app.whenReady().then(() => {
  monitor = createMonitor({ usagePy: USAGE_PY, usageState: "viewer", onChange: send });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => monitor && monitor.dispose());

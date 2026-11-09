/**
 * Main process of the agent status viewer (Electron).
 *
 * Opens one window and feeds it snapshots from the shared status monitor
 * (shared/status.js), which reads ~/.agent-behaviors/status and runs
 * ../session-status/scripts/usage.py. Read-only towards the board.
 */

const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } = require("electron");
const fs = require("fs");
const os = require("os");
const agentSkills = require("./shared/agent-skills");
const deployer = require("./shared/deploy");
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

/** The repository the app runs from: source of the skills it deploys. */
const REPO = path.join(__dirname, "..");
/** The AgentsMonitor folder: AGENTS_MONITOR_FOLDER, else ~/.agent-behaviors. */
const AGENTS_MONITOR = process.env.AGENTS_MONITOR_FOLDER || path.join(os.homedir(), ".agent-behaviors");
/** The skills offered to agents: the deployed copy once deployed, else the repository. */
let SKILLS_ROOT = REPO;

/**
 * Deploy the repository's skills into the AgentsMonitor folder
 * (shared/deploy.js): skills/ with coding/, session-status/, LICENSE and the
 * generated skills README agents read, plus the technical README at the
 * folder's root. Once per app version; a skills folder that is a link is
 * left alone.
 * @returns {object} Outcome of deploy().
 */
function deploySkills() {
  const result = deployer.deploy({
    folder: AGENTS_MONITOR,
    version: require("./package.json").version,
    skills: ["coding", "session-status"].map((name) => ({ name, from: path.join(REPO, name) })),
    license: path.join(REPO, "LICENSE"),
    architecture: path.join(REPO, "docs", "architecture.md"),
  });
  if (result.status === "deployed" || result.status === "current") SKILLS_ROOT = result.target;
  if (result.status === "error") console.error(`skills not deployed to ${result.target}: ${result.error}`);
  return result;
}

/**
 * File remembering that the user chose "Don't ask again" for adding skills.
 * @returns {string} Path in the app's data folder.
 */
function skillsDeclinedFile() {
  return path.join(app.getPath("userData"), "skills-offer-declined");
}

/**
 * Offer to add the skills to the installed agents that lack them
 * (Add / Not now / Don't ask again), then add them and say what was done.
 * @param {Electron.BrowserWindow|null} parent Window the dialogs belong to.
 * @returns {Promise<object|null>} {added, errors} when skills were added, else null.
 */
async function offerSkills(parent) {
  if (fs.existsSync(skillsDeclinedFile())) return null;
  const entries = agentSkills.missing(SKILLS_ROOT);
  if (!entries.length) return null;
  const names = agentSkills.findSkills(SKILLS_ROOT).map((s) => s.name).join(", ");
  const { response } = await dialog.showMessageBox(parent, {
    type: "question",
    buttons: ["Add", "Not now", "Don't ask again"],
    defaultId: 0,
    cancelId: 1,
    message: "Add the agent skills to your agents?",
    detail: `${names}\n\nMissing in: ${agentSkills.summary(entries)}.\nEach skill is linked into the agent's skills folder; nothing there is replaced.`,
  });
  if (response === 2) {
    fs.mkdirSync(path.dirname(skillsDeclinedFile()), { recursive: true });
    fs.writeFileSync(skillsDeclinedFile(), new Date().toISOString());
  }
  if (response !== 0) return null;
  const added = [];
  const errors = [];
  for (const e of entries) {
    const r = agentSkills.install(e);
    if (r.added.length) added.push(`${e.agent.name}: ${r.added.join(", ")}`);
    errors.push(...r.errors.map((x) => `${e.agent.name}: ${x}`));
  }
  await dialog.showMessageBox(parent, {
    type: errors.length ? "warning" : "info",
    message: errors.length ? "Some skills were not added." : "Skills added.",
    detail: [...added, ...errors].join("\n") + "\n\nAgents pick them up in their next session.",
  });
  return { added, errors };
}

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
  deploySkills();
  offerSkills(win);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => monitor && monitor.dispose());

/**
 * Chat windows for Claude Code sessions (Electron main process).
 *
 * No agent accepts input into a session that is already running in another
 * process, so a chat window runs its own `claude -p --resume <id>` with
 * streaming JSON in and out. When the session is still live elsewhere, the
 * window forks it (`--fork-session`) so the two never write one conversation.
 * Each window owns one process; it is started on the first message and
 * restarted (resuming the current session id) after Stop or a mode change.
 */

const { BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MODES, claudeBin, buildArgs, localCommands, listFiles, toEvents, content } = require("./chat-core");

/** Chat state by webContents id: {win, origin, sessionId, cwd, fork, mode, proc, buf, files}. */
const chats = new Map();

/**
 * Send an event to a chat window.
 * @param {object} chat Chat state.
 * @param {object} event Event for the window's renderer.
 */
function emit(chat, event) {
  if (!chat.win.isDestroyed()) chat.win.webContents.send("chat-event", event);
}

/**
 * Start the chat's CLI process (resuming, and forking when the session is live).
 * @param {object} chat Chat state.
 */
function start(chat) {
  const args = buildArgs(chat);
  const env = { ...process.env, PATH: `${path.join(os.homedir(), ".local", "bin")}:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` };
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(claudeBin(), args, { cwd: chat.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  chat.proc = proc;
  chat.buf = "";
  emit(chat, { kind: "status", text: chat.fork ? "Forking the session (it is still live elsewhere)…" : "Resuming the session…" });
  proc.stdout.on("data", (chunk) => {
    chat.buf += chunk.toString();
    let nl;
    while ((nl = chat.buf.indexOf("\n")) >= 0) {
      const line = chat.buf.slice(0, nl).trim();
      chat.buf = chat.buf.slice(nl + 1);
      if (!line) continue;
      try {
        for (const ev of toEvents(chat, JSON.parse(line))) emit(chat, ev);
      } catch {
        /* not JSON: ignore */
      }
    }
  });
  proc.stderr.on("data", (chunk) => emit(chat, { kind: "stderr", text: chunk.toString().slice(0, 2000) }));
  proc.on("error", (err) => emit(chat, { kind: "status", text: `Could not start claude: ${err.message}` }));
  proc.on("exit", (code) => {
    if (chat.proc === proc) chat.proc = null;
    emit(chat, { kind: "exit", code });
  });
}

/**
 * Open a chat window on a Claude Code session.
 * @param {{sessionId: string, cwd: string, live: boolean, title?: string}} opts Session to chat with.
 * @returns {{ok: boolean, error?: string}} The outcome.
 */
function openChatWindow(opts) {
  if (!opts.cwd || !fs.existsSync(opts.cwd)) return { ok: false, error: "the session's folder is unknown or gone" };
  const win = new BrowserWindow({
    width: 920,
    height: 820,
    title: `Chat · ${opts.title || opts.sessionId.slice(0, 8)}`,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const chat = { win, origin: opts.sessionId, sessionId: opts.sessionId, cwd: opts.cwd, fork: Boolean(opts.live),
    mode: "manual", proc: null, buf: "", files: null };
  chats.set(win.webContents.id, chat);
  win.loadFile(path.join(__dirname, "chat.html"));
  win.on("closed", () => {
    if (chat.proc) chat.proc.kill();
    chats.delete(chat.id);
  });
  chat.id = win.webContents.id;
  return { ok: true };
}

/**
 * The chat state of the window that sent an IPC message.
 * @param {Electron.IpcMainInvokeEvent} event IPC event.
 * @returns {object|undefined} Chat state.
 */
function chatOf(event) {
  return chats.get(event.sender.id);
}

ipcMain.handle("chat-info", (event) => {
  const chat = chatOf(event);
  if (!chat) return null;
  return { sessionId: chat.sessionId, origin: chat.origin, cwd: chat.cwd, fork: chat.fork, mode: chat.mode,
    modes: MODES, commands: localCommands(chat.cwd) };
});

ipcMain.handle("chat-send", (event, text, files) => {
  const chat = chatOf(event);
  if (!chat) return { ok: false, error: "no chat" };
  const body = typeof text === "string" ? text.trim() : "";
  const attachments = Array.isArray(files) ? files.filter((f) => typeof f === "string" && path.isAbsolute(f)) : [];
  if (!body && !attachments.length) return { ok: false, error: "empty message" };
  if (!chat.proc) start(chat);
  const line = { type: "user", message: { role: "user", content: content(body || "(see attachments)", attachments) } };
  chat.proc.stdin.write(`${JSON.stringify(line)}\n`);
  return { ok: true };
});

ipcMain.handle("chat-stop", (event) => {
  const chat = chatOf(event);
  if (chat && chat.proc) chat.proc.kill("SIGINT");
  return true;
});

ipcMain.handle("chat-mode", (event, mode) => {
  const chat = chatOf(event);
  if (!chat || !MODES.includes(mode)) return false;
  chat.mode = mode;
  if (chat.proc) chat.proc.kill(); // the next message restarts with the new mode
  return true;
});

ipcMain.handle("chat-files", (event, query) => {
  const chat = chatOf(event);
  if (!chat) return [];
  if (!chat.files) chat.files = listFiles(chat.cwd);
  const q = String(query || "").toLowerCase();
  return chat.files.filter((f) => f.toLowerCase().includes(q)).slice(0, 50);
});

ipcMain.handle("chat-pick", async (event) => {
  const chat = chatOf(event);
  if (!chat) return [];
  const result = await dialog.showOpenDialog(chat.win, { defaultPath: chat.cwd, properties: ["openFile", "multiSelections"] });
  return result.canceled ? [] : result.filePaths;
});

module.exports = { openChatWindow };

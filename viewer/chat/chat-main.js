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

/** Where the `claude` command may be (apps started from the Dock lack ~/.local/bin on PATH). */
const CLAUDE_CANDIDATES = [path.join(os.homedir(), ".local", "bin", "claude"), "/usr/local/bin/claude", "/opt/homebrew/bin/claude"];
/** Permission modes offered in the window (the CLI's --permission-mode choices). */
const MODES = ["manual", "acceptEdits", "plan", "auto", "dontAsk"];
/** Largest image or PDF sent inline, in bytes. */
const MAX_INLINE = 20 * 1024 * 1024;
/** Image types sent as image blocks, by extension. */
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
/** Built-in Claude Code commands, offered before the session reports its own list. */
const BUILTIN_COMMANDS = ["clear", "compact", "context", "cost", "init", "memory", "model", "review", "security-review", "status", "todos"];
/** Folders skipped when listing files for @-context. */
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target"]);

/** Chat state by webContents id: {win, origin, sessionId, cwd, fork, mode, proc, buf, files}. */
const chats = new Map();

/**
 * Find the `claude` executable.
 * @returns {string} Absolute path, or "claude" to rely on PATH.
 */
function claudeBin() {
  return CLAUDE_CANDIDATES.find((p) => fs.existsSync(p)) || "claude";
}

/**
 * Commands offered for "/" completion before the session's own list arrives:
 * built-ins plus user and project commands and skills.
 * @param {string} cwd Session folder.
 * @returns {string[]} Command names, without the slash.
 */
function localCommands(cwd) {
  const names = new Set(BUILTIN_COMMANDS);
  for (const base of [path.join(os.homedir(), ".claude"), path.join(cwd, ".claude")]) {
    for (const sub of ["commands", "skills"]) {
      try {
        for (const n of fs.readdirSync(path.join(base, sub))) names.add(n.replace(/\.md$/, ""));
      } catch {
        /* folder absent */
      }
    }
  }
  return [...names].sort();
}

/**
 * Files under the session folder, for @-context (bounded walk).
 * @param {string} cwd Session folder.
 * @returns {string[]} Paths relative to cwd.
 */
function listFiles(cwd) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= 5000 || depth > 8) return;
    let items = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (it.name.startsWith(".") && it.name !== ".claude") continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (!SKIP_DIRS.has(it.name)) walk(full, depth + 1);
      } else {
        out.push(path.relative(cwd, full));
      }
    }
  };
  walk(cwd, 0);
  return out;
}

/**
 * Send an event to a chat window.
 * @param {object} chat Chat state.
 * @param {object} event Event for the window's renderer.
 */
function emit(chat, event) {
  if (!chat.win.isDestroyed()) chat.win.webContents.send("chat-event", event);
}

/**
 * Turn one stream-json line from the CLI into window events.
 * @param {object} chat Chat state.
 * @param {object} d Parsed line.
 */
function handleLine(chat, d) {
  if (d.type === "system" && d.subtype === "init") {
    if (d.session_id) chat.sessionId = d.session_id;
    chat.fork = false; // forked once; later restarts resume the new id
    emit(chat, { kind: "init", sessionId: chat.sessionId, origin: chat.origin, model: d.model,
      mode: d.permissionMode, commands: (d.slash_commands || []).slice().sort() });
  } else if (d.type === "assistant" && d.message) {
    const blocks = (d.message.content || []).filter((c) => c.type === "text" || c.type === "tool_use")
      .map((c) => (c.type === "text" ? { type: "text", text: c.text } : { type: "tool", name: c.name, input: c.input }));
    if (blocks.length) emit(chat, { kind: "assistant", blocks });
  } else if (d.type === "user" && d.message && Array.isArray(d.message.content)) {
    for (const c of d.message.content) {
      if (c.type !== "tool_result") continue;
      const text = Array.isArray(c.content) ? c.content.map((x) => x.text || "").join("\n") : String(c.content || "");
      emit(chat, { kind: "tool_result", error: Boolean(c.is_error), text: text.slice(0, 4000) });
    }
  } else if (d.type === "result") {
    emit(chat, { kind: "result", error: Boolean(d.is_error), text: d.result || "",
      ms: d.duration_ms, cost: d.total_cost_usd, denials: (d.permission_denials || []).map((x) => x.tool_name) });
  }
}

/**
 * Start the chat's CLI process (resuming, and forking when the session is live).
 * @param {object} chat Chat state.
 */
function start(chat) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--resume", chat.sessionId, "--permission-mode", chat.mode];
  if (chat.fork) args.push("--fork-session");
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
        handleLine(chat, JSON.parse(line));
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
 * Build the user message content: text, images and PDFs inline, other files
 * named so the agent can read them.
 * @param {string} text Typed text.
 * @param {string[]} files Absolute paths of attachments.
 * @returns {object[]} Content blocks.
 */
function content(text, files) {
  const blocks = [];
  const named = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    let size = 0;
    try {
      size = fs.statSync(f).size;
    } catch {
      continue;
    }
    if (IMAGE_TYPES[ext] && size <= MAX_INLINE) {
      blocks.push({ type: "image", source: { type: "base64", media_type: IMAGE_TYPES[ext], data: fs.readFileSync(f).toString("base64") } });
    } else if (ext === ".pdf" && size <= MAX_INLINE) {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: fs.readFileSync(f).toString("base64") } });
    } else {
      named.push(f);
    }
  }
  const body = named.length ? `${text}\n\nAttached files (read them):\n${named.map((f) => `- ${f}`).join("\n")}` : text;
  blocks.unshift({ type: "text", text: body });
  return blocks;
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

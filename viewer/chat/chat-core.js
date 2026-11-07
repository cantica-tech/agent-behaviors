/**
 * Electron-free core of the chat windows (see chat-main.js): finding the
 * `claude` CLI, its arguments, turning its stream-json output into window
 * events, building message content from text and attachments, and listing
 * commands and files for completion. Kept apart so it can be unit tested.
 */

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
/** Most files listed for @-context. */
const MAX_FILES = 5000;

/**
 * Find the `claude` executable.
 * @param {string[]} [candidates] Paths to try, in order.
 * @returns {string} The first existing one, or "claude" to rely on PATH.
 */
function claudeBin(candidates = CLAUDE_CANDIDATES) {
  return candidates.find((p) => fs.existsSync(p)) || "claude";
}

/**
 * Arguments of the chat's `claude` process: print mode with streaming JSON
 * in and out, resuming the session, forking it when it is live elsewhere.
 * @param {{sessionId: string, mode: string, fork: boolean}} chat Chat state.
 * @returns {string[]} Arguments.
 */
function buildArgs(chat) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--resume", chat.sessionId, "--permission-mode", chat.mode];
  if (chat.fork) args.push("--fork-session");
  return args;
}

/**
 * Commands offered for "/" completion before the session's own list arrives:
 * built-ins plus user and project commands and skills.
 * @param {string} cwd Session folder.
 * @param {string} [home] Home folder (for ~/.claude).
 * @returns {string[]} Command names without the slash, sorted.
 */
function localCommands(cwd, home = os.homedir()) {
  const names = new Set(BUILTIN_COMMANDS);
  for (const base of [path.join(home, ".claude"), path.join(cwd, ".claude")]) {
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
 * Files under the session folder, for @-context: a bounded walk that skips
 * hidden folders (except .claude) and build/dependency folders.
 * @param {string} cwd Session folder.
 * @returns {string[]} Paths relative to cwd.
 */
function listFiles(cwd) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= MAX_FILES || depth > 8) return;
    let items = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (out.length >= MAX_FILES) return;
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
 * Turn one stream-json line from the CLI into window events. Updates the
 * chat's session id from `init` (a fork gets a new one) and clears `fork`,
 * so later restarts resume the new id.
 * @param {object} chat Chat state (sessionId, origin, fork).
 * @param {object} d Parsed line.
 * @returns {object[]} Events for the window (possibly none).
 */
function toEvents(chat, d) {
  if (!d || typeof d !== "object") return [];
  if (d.type === "system" && d.subtype === "init") {
    if (d.session_id) chat.sessionId = d.session_id;
    chat.fork = false;
    return [{ kind: "init", sessionId: chat.sessionId, origin: chat.origin, model: d.model,
      mode: d.permissionMode, commands: (d.slash_commands || []).slice().sort() }];
  }
  if (d.type === "assistant" && d.message) {
    const blocks = (d.message.content || []).filter((c) => c.type === "text" || c.type === "tool_use")
      .map((c) => (c.type === "text" ? { type: "text", text: c.text } : { type: "tool", name: c.name, input: c.input }));
    return blocks.length ? [{ kind: "assistant", blocks }] : [];
  }
  if (d.type === "user" && d.message && Array.isArray(d.message.content)) {
    return d.message.content.filter((c) => c.type === "tool_result").map((c) => {
      const text = Array.isArray(c.content) ? c.content.map((x) => x.text || "").join("\n") : String(c.content || "");
      return { kind: "tool_result", error: Boolean(c.is_error), text: text.slice(0, 4000) };
    });
  }
  if (d.type === "result") {
    return [{ kind: "result", error: Boolean(d.is_error), text: d.result || "",
      ms: d.duration_ms, cost: d.total_cost_usd, denials: (d.permission_denials || []).map((x) => x.tool_name) }];
  }
  return [];
}

/**
 * Build the user message content: text first, images and PDFs inline (up to
 * MAX_INLINE), other files named so the agent can read them. Missing files
 * are skipped.
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

module.exports = {
  CLAUDE_CANDIDATES, MODES, MAX_INLINE, IMAGE_TYPES, BUILTIN_COMMANDS, SKIP_DIRS, MAX_FILES,
  claudeBin, buildArgs, localCommands, listFiles, toEvents, content,
};

/**
 * Host-agnostic status source shared by the Electron app and the VS Code
 * extension.
 *
 * Reads the session-status board in ~/.agent-behaviors/status (one
 * <session>.json per session, plus .<model>.status.json heartbeats), runs
 * usage.py for measured token usage, joins the two by session id and calls
 * back with a snapshot whenever something changes. Strictly read-only
 * towards the board: it never writes a session entry.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

/** Default directory holding the shared status board. */
const DEFAULT_BOARD = path.join(os.homedir(), ".agent-behaviors", "status");
/** Minutes without a heartbeat after which a <model>.status session is gone (as in board.py). */
const STALE_MINUTES = 15;
/** Deployed settings file of the session-status skill (see session-status/settings.json). */
const DEFAULT_SETTINGS_FILE = path.join(os.homedir(), ".agent-behaviors", "session-status.json");
/** Settings used when the file is missing or a value is invalid (same as the skill's settings.json). */
const DEFAULT_SETTINGS = {
  statusSessionSeconds: 300,
  viewerUsageSeconds: 30,
  viewerBoardSeconds: 5,
  doneVisibleHours: 12,
};
/** Allowed range (inclusive) of each setting, as in board.py; values outside it are ignored. */
const SETTING_RANGES = {
  statusSessionSeconds: [60, 3600],
  viewerUsageSeconds: [10, 3600],
  viewerBoardSeconds: [1, 300],
  doneVisibleHours: [0, 720],
};

/** Characters allowed in a session id used as an inbox folder name (as in board.py). */
const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/;
/** Longest message accepted, in characters (as in board.py). */
const MAX_MESSAGE = 8000;

/**
 * Inbox state of a session: unread messages, and when the last one was read.
 * @param {string} board Board directory.
 * @param {string} sid Session id.
 * @returns {{unread: number, lastRead: string|null}} Counts from inbox/<sid>/.
 */
function inboxState(board, sid) {
  if (!SAFE_ID.test(sid)) return { unread: 0, lastRead: null };
  const dir = path.join(board, "inbox", sid);
  let unread = 0;
  let lastRead = null;
  try {
    unread = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).length;
  } catch {
    /* no inbox yet */
  }
  try {
    const read = fs.readdirSync(path.join(dir, "read")).filter((n) => n.endsWith(".json")).sort();
    if (read.length) lastRead = (readJson(path.join(dir, "read", read[read.length - 1])) || {}).read_at || null;
  } catch {
    /* nothing read yet */
  }
  return { unread, lastRead };
}

/** Minutes since its last activity within which a session counts as live. */
const LIVE_MINUTES = 15;
/** The session-status skill, resolved through the ~/.agent-behaviors/skills link to its real path. */
function defaultSkillPath() {
  try {
    return fs.realpathSync(path.join(os.homedir(), ".agent-behaviors", "skills", "session-status", "SKILL.md"));
  } catch {
    return null;
  }
}

/** Where the `claude` command may be, for `claude agents --json`. */
const CLAUDE_CANDIDATES = ["claude", path.join(os.homedir(), ".local", "bin", "claude")];

/**
 * Find a session's context folder and memory by its id, for sessions with a
 * board entry but no usage record (usage.py reports paths for the others).
 * Only the stores laid out by session id can be found this way.
 * @param {string} agent Agent name from the board entry.
 * @param {string} sid Session id.
 * @returns {{context_dir: string|null, memory: string|null}} Paths, or nulls.
 */
function locateById(agent, sid) {
  const home = os.homedir();
  if (agent === "claude-code") {
    const projects = path.join(home, ".claude", "projects");
    let names = [];
    try {
      names = fs.readdirSync(projects);
    } catch {
      return { context_dir: null, memory: null };
    }
    for (const name of names) {
      const dir = path.join(projects, name);
      if (fs.existsSync(path.join(dir, `${sid}.jsonl`))) {
        return { context_dir: dir, memory: path.join(dir, "memory") };
      }
    }
  }
  if (agent === "copilot") {
    // Copilot's memory folder is shared by its sessions (same as usage.py's COPILOT_MEMORY).
    const memory = [
      path.join(home, "Library/Application Support/Code/User/globalStorage/github.copilot-chat/memory-tool/memories"),
      path.join(home, ".config/Code/User/globalStorage/github.copilot-chat/memory-tool/memories"),
    ].find((p) => fs.existsSync(p)) || null;
    return { context_dir: path.join(home, ".copilot", "session-state", sid), memory };
  }
  return { context_dir: null, memory: null };
}

/**
 * Describe a context or memory location for the viewers.
 * @param {string|null} p Path, or null when unknown.
 * @returns {{path: string|null, exists: boolean}} The path and whether it is still there.
 */
function location(p) {
  return { path: p || null, exists: Boolean(p) && fs.existsSync(p) };
}

/**
 * When a board entry reached "done", in epoch seconds: its done_epoch, else
 * (entries published before done_at existed) its last update.
 * @param {object} e Board entry.
 * @returns {number|null} Epoch seconds, or null when the entry is not done.
 */
function doneEpoch(e) {
  if (!e || e.state !== "done") return null;
  return e.done_epoch || e.updated_epoch || null;
}

/**
 * Keep the valid settings of a parsed settings file: known keys with
 * in-range numbers. Anything else falls back to its default.
 * @param {*} data Parsed JSON.
 * @returns {object} Defaults overlaid with the valid values.
 */
function validSettings(data) {
  const out = { ...DEFAULT_SETTINGS };
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  for (const [key, [low, high]] of Object.entries(SETTING_RANGES)) {
    const v = data[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= low && v <= high) out[key] = v;
  }
  return out;
}

/**
 * Parse a JSON file.
 * @param {string} file Absolute path.
 * @returns {object|null} The parsed object, or null when unreadable or invalid.
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read the board: session entries and <model>.status heartbeats.
 * @param {string} board Board directory.
 * @returns {{entries: object[], monitors: object[]}} Board contents.
 */
function readBoard(board) {
  let names = [];
  try {
    names = fs.readdirSync(board);
  } catch {
    return { entries: [], monitors: [] };
  }
  const now = Date.now() / 1000;
  const entries = [];
  const monitors = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const data = readJson(path.join(board, name));
    if (!data) continue;
    if (/^\.(?!usage-|request\.).+\.status\.json$/.test(name)) {
      const beat = data.beat_epoch || 0;
      monitors.push({
        model: data.model,
        session: data.session,
        beat: data.beat || null,
        alive: beat > 0 && now - beat < STALE_MINUTES * 60,
      });
    } else if (!name.startsWith(".") && data.session) {
      data.age_minutes = data.updated_epoch ? (now - data.updated_epoch) / 60 : null;
      entries.push(data);
    }
  }
  return { entries, monitors };
}

/**
 * Parse usage.py output: one JSON record per line.
 * @param {string} stdout Raw output.
 * @returns {Map<string, object>} Records keyed by session id.
 */
function parseUsage(stdout) {
  const records = new Map();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.session) records.set(rec.session, rec);
    } catch {
      /* skip a malformed line */
    }
  }
  return records;
}

/**
 * Start watching the board and polling usage.
 *
 * @param {object} options Monitor options.
 * @param {(snapshot: object) => void} options.onChange Called with each new snapshot.
 * @param {string} options.usagePy Path to usage.py.
 * @param {string} [options.board] Board directory (default ~/.agent-behaviors/status).
 * @param {string} [options.usageState] usage.py --state name, one per caller, so deltas stay apart.
 * @param {string} [options.python] Python interpreter (default "python3").
 * @param {string} [options.settingsFile] Settings file (default ~/.agent-behaviors/session-status.json).
 *   Its viewerUsageSeconds and viewerBoardSeconds set the refresh rates; it is
 *   watched, and every valid change applies at once, without a restart.
 * @returns {{snapshot: () => object, refresh: () => void, saveSettings: (values: object) => object, dispose: () => void}}
 *   `snapshot` returns the current state, `refresh` re-runs usage.py now,
 *   `saveSettings` writes new settings (validated, applied at once),
 *   `dispose` stops every watcher and timer.
 */
function createMonitor(options) {
  const board = options.board || DEFAULT_BOARD;
  const python = options.python || "python3";
  const usageState = options.usageState || "viewer";
  let usage = new Map();
  let usageError = null;
  let running = false;
  let pushTimer = null;
  let watcher = null;
  let disposed = false;
  const settingsFile = options.settingsFile || DEFAULT_SETTINGS_FILE;
  let settings = { ...DEFAULT_SETTINGS };
  let settingsError = null;
  let settingsMtime = -1;
  let settingsWatcher = null;
  let boardTimer = null;
  let usageTimer = null;
  /** Context and memory paths in the latest snapshot: the only ones openPath may open. */
  const paths = new Set();
  /** The session-status SKILL.md that "Onboard" asks agents to load. */
  const skillPath = options.skillPath || defaultSkillPath();
  /** Rows of the latest snapshot by session id: the only sessions that can be messaged or opened. */
  const known = new Map();
  /** Running Claude Code sessions from `claude agents --json`, by session id. */
  let claudeSessions = new Map();

  /**
   * Re-read the settings file if it changed. A file that is not valid JSON
   * (e.g. half-written) is ignored and the current settings are kept.
   * @returns {boolean} True when the refresh rates changed.
   */
  function reloadSettings() {
    let mtime = 0;
    try {
      mtime = fs.statSync(settingsFile).mtimeMs;
    } catch {
      mtime = 0; // missing: defaults
    }
    if (mtime === settingsMtime) return false;
    settingsMtime = mtime;
    let next = { ...DEFAULT_SETTINGS };
    if (mtime) {
      try {
        next = validSettings(JSON.parse(fs.readFileSync(settingsFile, "utf8")));
        settingsError = null;
      } catch (err) {
        settingsError = `${path.basename(settingsFile)} ignored: ${err.message}`;
        return false;
      }
    } else {
      settingsError = null;
    }
    const changed = JSON.stringify(next) !== JSON.stringify(settings);
    settings = next;
    return changed;
  }

  /**
   * Save new setting values to the settings file, at runtime.
   *
   * Every value must be a known key with an in-range number, or nothing is
   * written. The file is updated in place: its other keys (e.g. `_doc`) are
   * kept, and it is replaced atomically so no reader sees a half-written
   * file. A file that is not valid JSON is not overwritten. The new rates
   * apply at once.
   * @param {object} values Setting name -> number.
   * @returns {{ok: boolean, error?: string, settings?: object}} The outcome.
   */
  function saveSettings(values) {
    if (!values || typeof values !== "object") return { ok: false, error: "no values" };
    const clean = {};
    for (const [key, v] of Object.entries(values)) {
      const range = SETTING_RANGES[key];
      if (!range) return { ok: false, error: `unknown setting ${key}` };
      const n = typeof v === "string" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n) || n < range[0] || n > range[1]) {
        return { ok: false, error: `${key} must be a number from ${range[0]} to ${range[1]}` };
      }
      clean[key] = n;
    }
    let data = {};
    if (fs.existsSync(settingsFile)) {
      try {
        data = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      } catch (err) {
        return { ok: false, error: `${settingsFile} is not valid JSON; fix it first (${err.message})` };
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { ok: false, error: `${settingsFile} is not a JSON object; fix it first` };
      }
    }
    Object.assign(data, clean);
    try {
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      const tmp = `${settingsFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
      fs.renameSync(tmp, settingsFile);
    } catch (err) {
      return { ok: false, error: `could not write ${settingsFile}: ${err.message}` };
    }
    if (reloadSettings()) schedule();
    push();
    return { ok: true, settings: { ...settings } };
  }

  /** (Re)start the periodic timers with the current settings. */
  function schedule() {
    clearInterval(boardTimer);
    clearInterval(usageTimer);
    boardTimer = setInterval(tick, settings.viewerBoardSeconds * 1000);
    usageTimer = setInterval(refresh, settings.viewerUsageSeconds * 1000);
  }

  /** Board poll: pick up settings changes too, then push a snapshot. */
  function tick() {
    if (reloadSettings()) schedule();
    push();
  }

  /** Join board entries with measured usage into one row per session. */
  function snapshot() {
    const { entries, monitors } = readBoard(board);
    const rows = new Map();
    // Done sessions are shown for doneVisibleHours after reaching done, then
    // dropped entirely (their usage too, so they don't come back as unreported).
    const cutoff = Date.now() / 1000 - settings.doneVisibleHours * 3600;
    const expired = new Set();
    for (const e of entries) {
      const done = doneEpoch(e);
      if (done !== null && done <= cutoff) {
        expired.add(e.session);
        continue;
      }
      if (done !== null) e.done_epoch = done;
      rows.set(e.session, { session: e.session, entry: e, usage: null });
    }
    for (const [sid, u] of usage) {
      if (expired.has(sid)) continue;
      const row = rows.get(sid) || { session: sid, entry: null, usage: null };
      row.usage = u;
      rows.set(sid, row);
    }
    paths.clear();
    known.clear();
    for (const row of rows.values()) {
      const e = row.entry;
      const u = row.usage;
      known.set(row.session, row);
      row.inbox = inboxState(board, row.session);
      row.live = claudeSessions.get(row.session) || null;
      row.open = openTarget(row);
      // Live: active in the last LIVE_MINUTES, or listed by `claude agents` as running.
      row.liveNow = Boolean(row.live) || Boolean(u && u.idle_minutes != null && u.idle_minutes <= LIVE_MINUTES);
      // Context folder and memory: from usage.py, else looked up by session id.
      const found = u ? { context_dir: u.context_dir, memory: u.memory } :
        locateById(e && e.agent, row.session);
      row.links = { context: location(found.context_dir), memory: location(found.memory) };
      for (const link of Object.values(row.links)) if (link.exists) paths.add(link.path);
      // An entry is stale when the session has been active since it last
      // published. A done session is never stale: its activity after reporting
      // done (e.g. the final reply) doesn't make the entry out of date.
      row.stale = Boolean(
        e && e.state !== "done" && u && u.last && e.updated_epoch &&
          Date.parse(u.last) / 1000 > e.updated_epoch + 60,
      );
    }
    return {
      board,
      at: new Date().toISOString(),
      rows: [...rows.values()],
      monitors,
      usageError,
      settings: { ...settings },
      settingsError,
      settingsFile,
      settingRanges: SETTING_RANGES,
      skillPath,
    };
  }

  /** Send a snapshot to the host. */
  function push() {
    if (!disposed) options.onChange(snapshot());
  }

  /** Coalesce bursts of board events into one push. */
  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 200);
  }

  /**
   * How a session can be opened so the user can type to it: attach to a
   * background Claude Code session, else open its project folder.
   * @param {object} row Joined row.
   * @returns {{kind: "attach"|"folder", id?: string, path?: string}|null} The target.
   */
  function openTarget(row) {
    if (row.live && row.live.kind === "background" && SAFE_ID.test(row.session)) {
      return { kind: "attach", id: row.session, cwd: row.live.cwd || null };
    }
    const cwd = (row.entry && row.entry.cwd) || (row.usage && row.usage.cwd);
    return cwd && fs.existsSync(cwd) ? { kind: "folder", path: cwd } : null;
  }

  /** Refresh the list of running Claude Code sessions (ignored if `claude` is absent). */
  function refreshClaudeSessions(candidates = CLAUDE_CANDIDATES) {
    if (!candidates.length || disposed) return;
    execFile(candidates[0], ["agents", "--json"], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return refreshClaudeSessions(candidates.slice(1));
        try {
          const list = JSON.parse(stdout);
          claudeSessions = new Map(list.filter((x) => x.sessionId).map((x) => [x.sessionId, x]));
          schedulePush();
        } catch {
          /* unexpected output: keep the previous list */
        }
      });
  }

  /**
   * Leave a message in a session's inbox (same format as `board.py send`).
   * Only sessions in the latest snapshot can be messaged.
   * @param {string} sid Session id.
   * @param {string} text Message text.
   * @returns {{ok: boolean, error?: string, id?: string}} The outcome.
   */
  function sendMessage(sid, text) {
    if (typeof sid !== "string" || !SAFE_ID.test(sid) || !known.has(sid)) {
      return { ok: false, error: "unknown session" };
    }
    const body = typeof text === "string" ? text.trim() : "";
    if (!body) return { ok: false, error: "empty message" };
    if (body.length > MAX_MESSAGE) return { ok: false, error: `longer than ${MAX_MESSAGE} characters` };
    const epoch = Date.now() / 1000;
    const id = `${Date.now()}-${process.pid}`;
    const msg = { id, to: sid, sender: options.sender || "viewer", text: body, at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), epoch };
    try {
      const dir = path.join(board, "inbox", sid);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${id}.json`);
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(msg, null, 1));
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    schedulePush();
    return { ok: true, id };
  }

  /** Run usage.py (one run at a time), store its records, then push. */
  function refresh() {
    refreshClaudeSessions();
    if (running || disposed) return;
    running = true;
    execFile(
      python,
      ["-I", options.usagePy, "--state", usageState],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        running = false;
        if (err) {
          usageError = (stderr || err.message).trim().split("\n").pop();
        } else {
          usageError = null;
          usage = parseUsage(stdout);
        }
        push();
      },
    );
  }

  try {
    watcher = fs.watch(board, schedulePush);
  } catch {
    /* the directory may not exist yet; polling picks it up */
  }
  try {
    // Watch the folder, not the file: editors and board.py replace it atomically.
    settingsWatcher = fs.watch(path.dirname(settingsFile), (_event, name) => {
      if (!name || name === path.basename(settingsFile)) {
        if (reloadSettings()) schedule();
        schedulePush();
      }
    });
  } catch {
    /* folder missing; the board poll re-checks the file */
  }
  reloadSettings();
  schedule();
  refresh();

  return {
    snapshot,
    refresh,
    saveSettings,
    sendMessage,
    /**
     * How to open a session of the latest snapshot (see openTarget).
     * @param {string} sid Session id.
     * @returns {object|null} The target, or null when it cannot be opened.
     */
    sessionTarget(sid) {
      const row = known.get(sid);
      return row ? openTarget(row) : null;
    },
    /**
     * Whether ``p`` is a context or memory path of the latest snapshot that
     * still exists; hosts open only such paths.
     * @param {string} p Path asked for by the page.
     * @returns {boolean} True when it may be opened.
     */
    isOpenablePath(p) {
      return typeof p === "string" && paths.has(p) && fs.existsSync(p);
    },
    dispose() {
      disposed = true;
      clearTimeout(pushTimer);
      clearInterval(boardTimer);
      clearInterval(usageTimer);
      if (watcher) watcher.close();
      if (settingsWatcher) settingsWatcher.close();
    },
  };
}

module.exports = { createMonitor, readBoard, parseUsage, validSettings, DEFAULT_BOARD, DEFAULT_SETTINGS_FILE };

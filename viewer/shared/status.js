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
    for (const row of rows.values()) {
      const e = row.entry;
      const u = row.usage;
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

  /** Run usage.py (one run at a time), store its records, then push. */
  function refresh() {
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

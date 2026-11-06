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
 * @param {number} [options.usageIntervalMs] usage.py period (default 30 s).
 * @param {number} [options.boardIntervalMs] Fallback board poll (default 5 s).
 * @returns {{snapshot: () => object, refresh: () => void, dispose: () => void}}
 *   `snapshot` returns the current state, `refresh` re-runs usage.py now,
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

  /** Join board entries with measured usage into one row per session. */
  function snapshot() {
    const { entries, monitors } = readBoard(board);
    const rows = new Map();
    for (const e of entries) rows.set(e.session, { session: e.session, entry: e, usage: null });
    for (const [sid, u] of usage) {
      const row = rows.get(sid) || { session: sid, entry: null, usage: null };
      row.usage = u;
      rows.set(sid, row);
    }
    for (const row of rows.values()) {
      const e = row.entry;
      const u = row.usage;
      // An entry is stale when the session has been active since it last published.
      row.stale = Boolean(
        e && u && u.last && e.updated_epoch && Date.parse(u.last) / 1000 > e.updated_epoch + 60,
      );
    }
    return { board, at: new Date().toISOString(), rows: [...rows.values()], monitors, usageError };
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
  const boardTimer = setInterval(push, options.boardIntervalMs || 5_000);
  const usageTimer = setInterval(refresh, options.usageIntervalMs || 30_000);
  refresh();

  return {
    snapshot,
    refresh,
    dispose() {
      disposed = true;
      clearTimeout(pushTimer);
      clearInterval(boardTimer);
      clearInterval(usageTimer);
      if (watcher) watcher.close();
    },
  };
}

module.exports = { createMonitor, readBoard, parseUsage, DEFAULT_BOARD };

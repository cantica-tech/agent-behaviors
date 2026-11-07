/**
 * Test helpers shared by the viewer's unit tests (node:test).
 *
 * - tmp(): a fresh temporary folder, removed after the test.
 * - board(): a temporary board, settings file and fake usage.py.
 * - loadWithMocks(): require a module with some of its dependencies mocked
 *   (e.g. "electron", "vscode"), freshly, so module state doesn't leak.
 * - loadPage(): run browser scripts (renderer, bridge, chat) in jsdom.
 * - waitFor(): poll until a condition holds.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { JSDOM } = require("jsdom");

/** Viewer root (parent of test/). */
const ROOT = path.join(__dirname, "..");

/**
 * Create a temporary folder removed when the test ends.
 * @param {import("node:test").TestContext} t Test context.
 * @returns {string} Absolute path.
 */
function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Write a JSON file, creating its folder.
 * @param {string} file Path.
 * @param {*} data Value.
 */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

/**
 * A temporary board: folders for entries and settings, and a fake usage.py
 * printing the given records (one JSON line each).
 * @param {import("node:test").TestContext} t Test context.
 * @param {object[]} [usage] Usage records for the fake usage.py.
 * @returns {{dir: string, board: string, settingsFile: string, usagePy: string, entry: Function, setUsage: Function}}
 *   `entry(e)` writes a board entry; `setUsage(records)` changes the fake output.
 */
function board(t, usage = []) {
  const dir = tmp(t);
  const b = path.join(dir, "board");
  fs.mkdirSync(b);
  const settingsFile = path.join(dir, "cfg", "session-status.json");
  writeJson(settingsFile, {});
  const data = path.join(dir, "usage.json");
  const usagePy = path.join(dir, "usage.py");
  fs.writeFileSync(usagePy, `import json\nfor r in json.load(open(${JSON.stringify(data)})): print(json.dumps(r))\n`);
  const setUsage = (records) => fs.writeFileSync(data, JSON.stringify(records));
  setUsage(usage);
  const entry = (e) => writeJson(path.join(b, `${e.session}.json`), { agent: "test", task: "t", updated_epoch: Date.now() / 1000, ...e });
  return { dir, board: b, settingsFile, usagePy, entry, setUsage };
}

/**
 * Require a module freshly, with some dependencies replaced.
 * @param {string} file Module path (absolute, or relative to the viewer root).
 * @param {object} mocks Request string -> exported value, e.g. {vscode: fake}.
 * @returns {*} The module's exports.
 */
function loadWithMocks(file, mocks) {
  const full = path.isAbsolute(file) ? file : path.join(ROOT, file);
  const original = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(ROOT) && !key.includes(`${path.sep}node_modules${path.sep}`) && !key.includes(`${path.sep}test${path.sep}`)) {
        delete require.cache[key];
      }
    }
    return require(full);
  } finally {
    Module._load = original;
  }
}

/**
 * Load a page in jsdom and run browser scripts in it, after setting globals.
 * Top-level functions and variables of the scripts are reachable with
 * `win.eval("name")`.
 * @param {string} html Page HTML (or a file under the viewer root ending in .html).
 * @param {string[]} scripts Script files under the viewer root, run in order.
 * @param {object} [globals] Properties set on window before the scripts run.
 * @returns {Window} The jsdom window.
 */
function loadPage(html, scripts, globals = {}) {
  const markup = html.endsWith(".html") ? fs.readFileSync(path.join(ROOT, html), "utf8").replace(/<script[^>]*><\/script>/g, "") : html;
  const dom = new JSDOM(markup, { runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window;
  Object.assign(win, globals);
  win.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  for (const s of scripts) win.eval(fs.readFileSync(path.join(ROOT, s), "utf8"));
  return win;
}

/**
 * Poll until ``cond()`` is truthy.
 * @param {() => *} cond Condition.
 * @param {number} [ms] Timeout.
 * @returns {Promise<*>} The truthy value.
 */
async function waitFor(cond, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

module.exports = { ROOT, tmp, writeJson, board, loadWithMocks, loadPage, waitFor };

/**
 * Unit tests of the Electron chat window: chat/chat-core.js (CLI arguments,
 * stream-json parsing, message content, completion sources) and
 * chat/chat.js (the window's renderer, in jsdom with a fake chatApi).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmp, loadPage } = require("./helpers");
const core = require("../chat/chat-core");

test("claudeBin picks the first existing candidate, else relies on PATH", (t) => {
  const dir = tmp(t);
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, "");
  assert.equal(core.claudeBin([path.join(dir, "nope"), bin]), bin);
  assert.equal(core.claudeBin([path.join(dir, "nope")]), "claude");
});

test("buildArgs resumes with streaming JSON, the mode, and forks only when asked", () => {
  const args = core.buildArgs({ sessionId: "abc", mode: "plan", fork: false });
  assert.deepEqual(args, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--resume", "abc", "--permission-mode", "plan"]);
  assert.equal(core.buildArgs({ sessionId: "abc", mode: "manual", fork: true }).at(-1), "--fork-session");
});

test("toEvents: init updates the session id and stops forking", () => {
  const chat = { sessionId: "old", origin: "old", fork: true };
  const [ev] = core.toEvents(chat, { type: "system", subtype: "init", session_id: "new", model: "m", permissionMode: "plan", slash_commands: ["b", "a"] });
  assert.deepEqual(ev, { kind: "init", sessionId: "new", origin: "old", model: "m", mode: "plan", commands: ["a", "b"] });
  assert.equal(chat.sessionId, "new");
  assert.equal(chat.fork, false);
});

test("toEvents: assistant text and tool calls; thinking dropped", () => {
  const chat = { sessionId: "s" };
  const evs = core.toEvents(chat, { type: "assistant", message: { content: [
    { type: "thinking", thinking: "" }, { type: "text", text: "hi" }, { type: "tool_use", name: "Read", input: { file_path: "/a" } }] } });
  assert.deepEqual(evs, [{ kind: "assistant", blocks: [{ type: "text", text: "hi" }, { type: "tool", name: "Read", input: { file_path: "/a" } }] }]);
  assert.deepEqual(core.toEvents(chat, { type: "assistant", message: { content: [{ type: "thinking" }] } }), []);
});

test("toEvents: tool results (string or blocks, errors, truncated)", () => {
  const evs = core.toEvents({}, { type: "user", message: { content: [
    { type: "tool_result", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    { type: "tool_result", is_error: true, content: "x".repeat(5000) },
    { type: "text", text: "ignored" }] } });
  assert.equal(evs.length, 2);
  assert.deepEqual(evs[0], { kind: "tool_result", error: false, text: "a\nb" });
  assert.equal(evs[1].error, true);
  assert.equal(evs[1].text.length, 4000);
});

test("toEvents: result with cost, time and permission denials; unknown lines ignored", () => {
  const [ev] = core.toEvents({}, { type: "result", is_error: false, result: "ok", duration_ms: 1200, total_cost_usd: 0.01,
    permission_denials: [{ tool_name: "Bash" }] });
  assert.deepEqual(ev, { kind: "result", error: false, text: "ok", ms: 1200, cost: 0.01, denials: ["Bash"] });
  assert.deepEqual(core.toEvents({}, { type: "rate_limit_event" }), []);
  assert.deepEqual(core.toEvents({}, null), []);
});

test("content: text first, images and PDFs inline, other files named, missing skipped", (t) => {
  const dir = tmp(t);
  const png = path.join(dir, "a.PNG");
  const pdf = path.join(dir, "b.pdf");
  const txt = path.join(dir, "c.txt");
  fs.writeFileSync(png, Buffer.from([1, 2, 3]));
  fs.writeFileSync(pdf, "%PDF");
  fs.writeFileSync(txt, "hello");
  const blocks = core.content("look", [png, pdf, txt, path.join(dir, "missing.png")]);
  assert.equal(blocks[0].type, "text");
  assert.equal(blocks[0].text, `look\n\nAttached files (read them):\n- ${txt}`);
  assert.deepEqual(blocks[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } });
  assert.equal(blocks[2].type, "document");
  assert.equal(blocks[2].source.media_type, "application/pdf");
  assert.deepEqual(core.content("just text", []), [{ type: "text", text: "just text" }]);
});

test("localCommands: built-ins plus user and project commands and skills", (t) => {
  const home = tmp(t);
  const cwd = tmp(t);
  fs.mkdirSync(path.join(home, ".claude", "commands"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "commands", "deploy.md"), "");
  fs.mkdirSync(path.join(cwd, ".claude", "skills", "lint"), { recursive: true });
  const cmds = core.localCommands(cwd, home);
  for (const c of ["compact", "clear", "deploy", "lint"]) assert.ok(cmds.includes(c), c);
  assert.deepEqual(cmds, [...cmds].sort());
});

test("listFiles: relative paths, skipping hidden and dependency folders", (t) => {
  const cwd = tmp(t);
  for (const f of ["a.js", "src/b.js", "node_modules/x/y.js", ".git/HEAD", ".claude/settings.json", ".hidden/z", "build/out.js"]) {
    fs.mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true });
    fs.writeFileSync(path.join(cwd, f), "");
  }
  assert.deepEqual(core.listFiles(cwd).sort(), [".claude/settings.json", "a.js", "src/b.js"]);
  assert.deepEqual(core.listFiles(path.join(cwd, "missing")), []);
});

/**
 * A fake chatApi recording calls, with `emit(event)` to push chat events.
 * @returns {object} The fake.
 */
function fakeChatApi() {
  const api = {
    calls: [],
    sendResult: { ok: true },
    files: async (q) => (api.calls.push(["files", q]), ["notes.md", "src/notes.js"].filter((f) => f.includes(q))),
    info: async () => ({ sessionId: "s1", origin: "s1", cwd: "/p/proj", fork: true, mode: "manual",
      modes: ["manual", "plan"], commands: ["compact", "clear", "cost"] }),
    send: async (text, files) => (api.calls.push(["send", text, files]), api.sendResult),
    stop: async () => api.calls.push(["stop"]),
    setMode: async (m) => (api.calls.push(["setMode", m]), true),
    pickFiles: async () => ["/p/proj/a.png"],
    onEvent(cb) {
      api.emit = cb;
    },
  };
  return api;
}

const tick = () => new Promise((r) => setTimeout(r, 5));
/** Copy a value made in jsdom into this realm, for deep comparisons. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/**
 * Load the chat window with a fake API.
 * @returns {Promise<{win: Window, api: object, $: Function, $$: Function}>} Handles.
 */
async function chatPage() {
  const api = fakeChatApi();
  const win = loadPage("chat/chat.html", ["chat/chat.js"], { chatApi: api });
  await tick();
  const doc = win.document;
  return { win, api, $: (s) => doc.querySelector(s), $$: (s) => [...doc.querySelectorAll(s)] };
}

test("chat window: info fills the header, modes and fork notice", async () => {
  const { $, $$, win } = await chatPage();
  assert.equal(win.document.title, "Chat · proj");
  assert.match($("#meta").textContent, /s1 · \/p\/proj/);
  assert.deepEqual($$("#mode option").map((o) => [o.value, o.textContent]), [["manual", "ask (denied here)"], ["plan", "plan"]]);
  assert.match($(".status").textContent, /still live elsewhere: your first message forks it/);
  assert.equal($("#stop").disabled, true);
});

test("chat window: send shows the message, calls the API, clears and goes busy", async () => {
  const { $, $$, api, win } = await chatPage();
  $("#input").value = "hello";
  $("#send").click();
  await tick();
  assert.deepEqual(plain(api.calls.find((c) => c[0] === "send")), ["send", "hello", []]);
  assert.equal($$(".msg.user")[0].textContent, "hello");
  assert.equal($("#input").value, "");
  assert.equal($("#state").textContent, "Working…");
  assert.equal($("#stop").disabled, false);
  api.sendResult = { ok: false, error: "empty message" };
  $("#input").value = "x";
  $("#send").click();
  await tick();
  assert.equal($$(".status.error").at(-1).textContent, "empty message");
  win.document.getElementById("input").value = "";
});

test("chat window: Enter sends, Shift+Enter does not", async () => {
  const { $, api, win } = await chatPage();
  $("#input").value = "line";
  $("#input").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
  await tick();
  assert.equal(api.calls.filter((c) => c[0] === "send").length, 0);
  $("#input").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter" }));
  await tick();
  assert.equal(api.calls.filter((c) => c[0] === "send").length, 1);
});

test("chat window: attachments become chips, can be removed, and are sent", async () => {
  const { $, $$, api } = await chatPage();
  $("#attach").click();
  await tick();
  assert.deepEqual($$(".chip").map((c) => c.firstChild.textContent), ["a.png"]);
  $(".chip button").click();
  assert.equal($$(".chip").length, 0);
  $("#attach").click();
  await tick();
  $("#input").value = "see";
  $("#send").click();
  await tick();
  assert.deepEqual(plain(api.calls.find((c) => c[0] === "send")), ["send", "see", ["/p/proj/a.png"]]);
  assert.match($(".msg.user .files").textContent, /Attached: a.png/);
  assert.equal($$(".chip").length, 0, "chips cleared after sending");
});

test("chat window: / completes commands, @ completes files, keyboard picks", async () => {
  const { $, $$, win } = await chatPage();
  const input = $("#input");
  const type = async (text) => {
    input.value = text;
    input.selectionStart = input.selectionEnd = text.length;
    input.dispatchEvent(new win.Event("input"));
    await tick();
  };
  await type("/c");
  assert.deepEqual($$("#suggest div").map((d) => d.textContent), ["/compact", "/clear", "/cost"]);
  input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown" }));
  assert.equal($("#suggest .on").textContent, "/clear");
  input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Tab" }));
  assert.equal(input.value, "/clear ");
  assert.equal($("#suggest").hidden, true);
  await type("read @not");
  assert.deepEqual($$("#suggest div").map((d) => d.textContent), ["@notes.md", "@src/notes.js"]);
  input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter" }));
  assert.equal(input.value, "read @notes.md ", "Enter picks the completion instead of sending");
  await type("@zzz");
  assert.equal($("#suggest").hidden, true, "no matches: hidden");
  await type("plain text");
  assert.equal($("#suggest").hidden, true);
  await type("/c");
  input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal($("#suggest").hidden, true);
});

test("chat window: init updates commands and header, shows forks", async () => {
  const { $, $$, api, win } = await chatPage();
  api.emit({ kind: "init", sessionId: "s2", origin: "s1", model: "opus", commands: ["review"] });
  assert.match($("#meta").textContent, /s2 \(fork of s1\) · opus/);
  const input = $("#input");
  input.value = "/r";
  input.selectionStart = input.selectionEnd = 2;
  input.dispatchEvent(new win.Event("input"));
  await tick();
  assert.deepEqual($$("#suggest div").map((d) => d.textContent), ["/review"]);
});

test("chat window: renders assistant text with code, tools, results, status, stderr, exit", async () => {
  const { $, $$, api } = await chatPage();
  api.emit({ kind: "assistant", blocks: [{ type: "text", text: "Here:\n```js\nconst a = 1;\n```\ndone" },
    { type: "tool", name: "Bash", input: { command: "ls -la" } }] });
  const msg = $$(".msg.assistant")[0];
  assert.equal(msg.querySelector("pre").textContent, "const a = 1;");
  assert.match(msg.textContent, /^Here:/);
  assert.equal($("details.tool summary").textContent, "Bash ls -la");
  api.emit({ kind: "tool_result", error: true, text: "fail" });
  assert.equal($$("details.tool.error summary")[0].textContent, "tool error");
  api.emit({ kind: "result", error: false, ms: 1500, cost: 0.0123, denials: ["Write"] });
  assert.equal($(".result").textContent, "done · 1.5 s · $0.0123 · denied: Write (change Permissions to allow)");
  api.emit({ kind: "stderr", text: "warning\n" });
  assert.equal($$(".status.error").at(-1).textContent, "warning");
  api.emit({ kind: "status", text: "Resuming the session…" });
  assert.equal($$(".status").at(-1).textContent, "Resuming the session…");
});

test("chat window: text is never parsed as HTML", async () => {
  const { $$, api } = await chatPage();
  api.emit({ kind: "assistant", blocks: [{ type: "text", text: "<img src=x onerror=alert(1)>" }] });
  const msg = $$(".msg.assistant")[0];
  assert.equal(msg.querySelector("img"), null);
  assert.equal(msg.textContent, "<img src=x onerror=alert(1)>");
});

test("chat window: Stop and exit while busy; mode change", async () => {
  const { $, $$, api, win } = await chatPage();
  $("#input").value = "work";
  $("#send").click();
  await tick();
  $("#stop").click();
  assert.ok(api.calls.some((c) => c[0] === "stop"));
  api.emit({ kind: "exit", code: null });
  assert.equal($$(".status").at(-1).textContent, "Stopped. The next message resumes the session.");
  assert.equal($("#stop").disabled, true);
  $("#mode").value = "plan";
  $("#mode").dispatchEvent(new win.Event("change"));
  await tick();
  assert.deepEqual(api.calls.find((c) => c[0] === "setMode"), ["setMode", "plan"]);
  assert.equal($$(".status").at(-1).textContent, "Permissions: plan (from the next message).");
});

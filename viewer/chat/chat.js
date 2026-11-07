/**
 * Chat window renderer: message log, composer with "/" command and
 * "@" file completion, attachments, Stop and permission mode.
 * Talks to chat-main.js through window.chatApi.
 */

/** Element by id. */
const $ = (id) => document.getElementById(id);
/** Slash commands known for this session (names without "/"). */
let commands = [];
/** Attachments of the message being written (absolute paths). */
let attachments = [];
/** Current completion: {kind: "/"|"@", start, items, index} or null. */
let completion = null;
/** Whether the agent is working on a message. */
let busy = false;

/**
 * Create an element with optional class and text (text is never parsed as HTML).
 * @param {string} tag Tag name.
 * @param {string} [cls] Class name.
 * @param {string} [text] Text content.
 * @returns {HTMLElement} The element.
 */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/** Append a node to the log and keep the latest in view. */
function append(node) {
  $("log").append(node);
  node.scrollIntoView({ block: "end" });
}

/**
 * Render message text: fenced code blocks as <pre>, the rest as plain text.
 * @param {HTMLElement} box Target.
 * @param {string} text Message text.
 */
function renderText(box, text) {
  const parts = String(text).split(/```[^\n]*\n?/);
  parts.forEach((part, i) => box.append(i % 2 ? el("pre", null, part.replace(/\n$/, "")) : document.createTextNode(part)));
}

/** Show whether the agent is working. */
function setBusy(value, label) {
  busy = value;
  $("state").textContent = label || (value ? "Working…" : "");
  $("stop").disabled = !value;
}

/** Redraw the attachment chips. */
function drawChips() {
  const chips = $("chips");
  chips.replaceChildren(...attachments.map((f, i) => {
    const chip = el("span", "chip", f.split("/").pop());
    chip.title = f;
    const x = el("button", null, "×");
    x.addEventListener("click", () => {
      attachments.splice(i, 1);
      drawChips();
    });
    chip.append(x);
    return chip;
  }));
}

/** Send the composer's message. */
async function send() {
  const text = $("input").value;
  if (!text.trim() && !attachments.length) return;
  const box = el("div", "msg user");
  renderText(box, text);
  if (attachments.length) box.append(el("div", "files", `Attached: ${attachments.map((f) => f.split("/").pop()).join(", ")}`));
  append(box);
  const result = await window.chatApi.send(text, attachments);
  if (!result.ok) {
    append(el("div", "status error", result.error));
    return;
  }
  $("input").value = "";
  attachments = [];
  drawChips();
  hideSuggest();
  setBusy(true);
}

/** Hide the completion list. */
function hideSuggest() {
  completion = null;
  $("suggest").hidden = true;
}

/** Show the completion list for the current completion. */
function drawSuggest() {
  const box = $("suggest");
  if (!completion || !completion.items.length) {
    box.hidden = true;
    return;
  }
  box.replaceChildren(...completion.items.map((item, i) => {
    const row = el("div", i === completion.index ? "on" : null, (completion.kind === "/" ? "/" : "@") + item);
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      choose(i);
    });
    return row;
  }));
  box.hidden = false;
}

/**
 * Insert completion item ``i`` in place of the token being typed.
 * @param {number} i Item index.
 */
function choose(i) {
  const input = $("input");
  const item = completion.items[i];
  const before = input.value.slice(0, completion.start);
  const after = input.value.slice(input.selectionStart);
  const insert = `${completion.kind}${item} `;
  input.value = before + insert + after;
  input.selectionStart = input.selectionEnd = before.length + insert.length;
  hideSuggest();
  input.focus();
}

/** Update completion from the text before the caret: "/cmd" at the start, "@path" anywhere. */
async function updateCompletion() {
  const input = $("input");
  const upto = input.value.slice(0, input.selectionStart);
  const slash = /^\/([\w:.-]*)$/.exec(upto);
  const at = /(?:^|\s)@([^\s@]*)$/.exec(upto);
  if (slash) {
    const items = commands.filter((c) => c.startsWith(slash[1])).slice(0, 40);
    completion = { kind: "/", start: 0, items, index: 0 };
  } else if (at) {
    const items = await window.chatApi.files(at[1]);
    completion = { kind: "@", start: upto.length - at[1].length - 1, items, index: 0 };
  } else {
    completion = null;
  }
  drawSuggest();
}

window.chatApi.onEvent((ev) => {
  if (ev.kind === "init") {
    if (ev.commands && ev.commands.length) commands = ev.commands;
    const forked = ev.origin && ev.sessionId !== ev.origin;
    $("meta").textContent = `${ev.sessionId}${forked ? ` (fork of ${ev.origin})` : ""} · ${ev.model || ""}`;
  } else if (ev.kind === "assistant") {
    for (const b of ev.blocks) {
      if (b.type === "text") {
        const box = el("div", "msg assistant");
        renderText(box, b.text);
        append(box);
      } else {
        const d = el("details", "tool");
        d.append(el("summary", null, `${b.name} ${summarize(b.input)}`), el("pre", null, JSON.stringify(b.input, null, 2)));
        append(d);
      }
    }
  } else if (ev.kind === "tool_result") {
    const d = el("details", `tool${ev.error ? " error" : ""}`);
    d.append(el("summary", null, ev.error ? "tool error" : "tool result"), el("pre", null, ev.text));
    append(d);
  } else if (ev.kind === "result") {
    const parts = [ev.error ? "error" : "done"];
    if (ev.ms) parts.push(`${(ev.ms / 1000).toFixed(1)} s`);
    if (ev.cost) parts.push(`$${ev.cost.toFixed(4)}`);
    if (ev.denials && ev.denials.length) parts.push(`denied: ${ev.denials.join(", ")} (change Permissions to allow)`);
    append(el("div", `result${ev.error ? " error" : ""}`, parts.join(" · ")));
    setBusy(false);
  } else if (ev.kind === "status") {
    append(el("div", "status", ev.text));
  } else if (ev.kind === "stderr") {
    if (ev.text.trim()) append(el("div", "status error", ev.text.trim()));
  } else if (ev.kind === "exit") {
    if (busy) append(el("div", "status", "Stopped. The next message resumes the session."));
    setBusy(false);
  }
});

/**
 * One-line summary of a tool call's input.
 * @param {object} input Tool input.
 * @returns {string} Summary.
 */
function summarize(input) {
  if (!input || typeof input !== "object") return "";
  const v = input.file_path || input.path || input.command || input.pattern || input.url || input.description || "";
  return String(v).slice(0, 100);
}

$("input").addEventListener("input", updateCompletion);
$("input").addEventListener("keydown", (e) => {
  if (completion && completion.items.length) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = completion.items.length;
      completion.index = (completion.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      drawSuggest();
      return;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      choose(completion.index);
      return;
    }
    if (e.key === "Escape") {
      hideSuggest();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$("send").addEventListener("click", send);
$("stop").addEventListener("click", () => window.chatApi.stop());
$("attach").addEventListener("click", async () => {
  attachments = attachments.concat(await window.chatApi.pickFiles());
  drawChips();
});
$("mode").addEventListener("change", async () => {
  await window.chatApi.setMode($("mode").value);
  append(el("div", "status", `Permissions: ${$("mode").value} (from the next message).`));
});

window.chatApi.info().then((info) => {
  if (!info) return;
  commands = info.commands;
  document.title = `Chat · ${info.cwd.split("/").pop()}`;
  $("meta").textContent = `${info.sessionId} · ${info.cwd}`;
  $("mode").replaceChildren(...info.modes.map((m) => {
    const o = el("option", null, m === "manual" ? "ask (denied here)" : m);
    o.value = m;
    return o;
  }));
  $("mode").value = info.mode;
  append(el("div", "status", info.fork ?
    "This session is still live elsewhere: your first message forks it into a new session, so the two never overwrite each other." :
    "Your messages continue this session."));
  setBusy(false);
});

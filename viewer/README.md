# Agent status viewer

A small Electron window that shows the live status of the agent sessions on
this machine, from the [session-status](../session-status/SKILL.md) board.

It shows one card per session: state, project, task, blocker, items left,
ETA and projected tokens (self-reported in
`~/.agent-behaviors/status/<session>.json`), joined with measured token
usage from [usage.py](../session-status/scripts/usage.py). Sessions with
usage but no board entry appear as `unreported`. The header pills show
whether each `<model>.status` background session is alive.

Each card links to the session's context folder (where its agent keeps the
session) and its memory; when one is gone or unknown, the card says so.

**Message…** on a card sends a prompt to that agent, whatever it is
(Copilot, Claude, Codex, Gemini, Mistral, Grok, …): it lands in the
session's inbox (`~/.agent-behaviors/status/inbox/<session>/`), and the agent
reads it the next time it publishes its status. The card shows messages
still waiting and when the last one was read. **Open session** takes you to
the agent instead, to type to it directly. For a Claude Code session it opens
a **chat window**: your messages continue that session (`claude -p --resume`
with streaming JSON), with `/` for its slash commands, `@` to add a file of
the project as context, **Attach…** for documents and images, **Stop**, and a
Permissions menu (`ask` denies tools that need approval; pick `acceptEdits`,
`plan`, … to allow more). If the session is still live elsewhere, the first
message forks it into a new session, so the two never write one
conversation. Other agents: Terminal with `claude attach` for a background
Claude Code session, otherwise the project folder.

A live session that doesn't report (active in the last 15 minutes, or
running per `claude agents`) also gets **Onboard**: it copies a
prompt asking the agent to load the session-status skill and publish under
its own session id, and opens the session so you can paste it there (an
unreported agent doesn't read the inbox).

The board refreshes as soon as a file changes. How often it also polls the
board and re-measures usage is set in `~/.agent-behaviors/session-status.json`
(`viewerBoardSeconds`, `viewerUsageSeconds`); a valid edit applies at once.
The **Settings** button in the header edits that file in place while the
viewer runs: values are checked against their ranges, and they apply as
soon as they are saved.
The viewer only reads: it never writes a session entry. Its own `usage.py`
deltas are kept in `.usage-viewer.json`, apart from everyone else's.

The same view is available inside VS Code: see [vscode/](vscode/README.md).
Both share the status monitor, renderer and styles in [shared/](shared).

## Tools the skills use

Every tool a skill relies on must be allowed for the agents: an agent has to
be able to run it without being blocked or asked each time, or the skill
can't do its job. Today that means:

| Tool | Used by |
| --- | --- |
| [mado](https://github.com/akiomik/mado) | [coding/markdown](../coding/markdown/SKILL.md) |
| [Taplo](https://github.com/tamasfe/taplo) (`taplo`) | [coding/toml](../coding/toml/SKILL.md) |

When a skill is added or starts using a new tool, list the tool in the
skill's `tools.json` and in this table, then run
[setup/allow-tools.py](../setup/allow-tools.py): it allows every listed tool
in each agent it detects (Claude Code, Copilot in VS Code, Codex) and says
what to allow by hand in the others. The [Tools](../README.md#tools) section
of the main README says how to install them.

## Tests

```sh
cd viewer
npm install
npm test        # or: cd vscode && npm test
```

Unit tests (`node:test`, with jsdom for the pages) cover both viewers
without opening a window or running an agent:

| File | What it tests |
| --- | --- |
| [test/status.test.js](test/status.test.js) | Shared monitor: board, usage join, settings (validation, live reload, saving), done expiry, stale, links, inbox, messaging, session info |
| [test/renderer.test.js](test/renderer.test.js) | Card UI: header, order, cards, links, filters, messaging, Onboard, settings panel |
| [test/chat.test.js](test/chat.test.js) | Chat core (CLI args, stream-json events, attachments, completion) and chat window |
| [test/electron.test.js](test/electron.test.js) | Electron main process, IPC, chat process manager, preloads (Electron mocked) |
| [test/vscode.test.js](test/vscode.test.js) | VS Code extension (vscode API mocked) and webview bridge |

## Icon

[viewer.svg](viewer.svg) is the icon of both viewers. Electron window icons
and VS Code extension icons must be PNG, so `npm run icons` renders it into
[icons/](icons): `icon.png` (512 px, app and dock), `icon-128.png` (VS Code
extension) and `viewer-dark.svg` (white copy for dark themes). Run it again
after changing `viewer.svg`.

## Run

```sh
cd viewer
npm install
npm start
```

It needs Node.js and `python3` on the `PATH`. `npm start` clears
`ELECTRON_RUN_AS_NODE`, which VS Code's terminal sets and which would
otherwise make Electron run as plain Node.

If `npm install` leaves no Electron binary (recent npm versions skip install
scripts, and Electron's unzip can stop early on Node 26), run
`npm install-scripts approve electron`. If that is not enough, unzip the
cached `electron-v<version>-darwin-<arch>.zip` from `~/Library/Caches/electron`
into `node_modules/electron/dist` and write
`Electron.app/Contents/MacOS/Electron` to `node_modules/electron/path.txt`.

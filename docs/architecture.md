# agent-behaviors: how the skills and the viewers fit together

This folder (the AgentsMonitor folder, `~/.agent-behaviors` by default) is
shared by every coding agent on this machine and by the Agent Status
viewers. It is written by agents and viewers alike; only the skills'
scripts under `skills/` are ever run from it.

Source: <https://github.com/cantica-tech/agent-behaviors>
(Apache License 2.0).

## Layout

| Path | What it is | Written by |
| --- | --- | --- |
| `README.md` | This file | the viewers, at deployment |
| `skills/` | The skills, one folder each with a `SKILL.md` | the viewers, at deployment |
| `skills/README.md` | Skills registry agents read to register the skills | the viewers, at deployment |
| `session-status.json` | Settings: refresh rates, `doneVisibleHours` | `board.py`, the viewers' Settings |
| `status/<session>.json` | One status entry per agent session | each session (`board.py publish`) |
| `status/<model>.log` | Every entry published by a model, one JSON line each | `board.py publish` |
| `status/<model>.md` | Latest report of a model's background session | the `<model>.status` session |
| `status/.<model>.status.json` | Claim and heartbeat of that background session | `board.py claim` / `heartbeat` |
| `status/inbox/<session>/` | Messages for a session; read ones move to `read/` | `board.py send`, the viewers |
| `status/.usage-<name>.json` | Previous token counts of each `usage.py` caller | `usage.py` |

## The skills

- **session-status**: every session publishes what it is doing (task,
  state, items and time left, projected tokens) with
  `skills/session-status/scripts/board.py`, before and after each task;
  `usage.py` measures token usage from each agent's own session store
  (Claude Code, Copilot, Codex, Gemini). A background session per model,
  `<model>.status`, keeps a report up to date. Any session can report on
  all the others, and read messages left in its inbox.
- **docstrings**, **markdown**, **toml**: coding rules. The markdown and toml
  skills lint with `mado` and `taplo`; each skill lists the tools it needs in
  its `tools.json`.

Agents register the skills from `skills/README.md`: agents that load skill
folders get them linked into their own folder (`~/.claude/skills`,
`~/.copilot/skills`, `~/.codex/skills`, `~/.gemini/skills`,
`~/.vibe/skills`, `~/.agents/skills`), the others follow each `SKILL.md`
named there.

## The viewers

Two front ends share one core (`viewer/shared/` in the source):

- **status.js**, the monitor: reads `status/` (watching it), runs `usage.py`,
  joins both by session id, and pushes a snapshot to the UI. It applies the
  settings live, drops done sessions after `doneVisibleHours`, flags stale
  entries, resolves each session's context folder and memory, and writes
  messages and settings.
- **renderer.js**, the UI: one card per session, the header, filters,
  messaging, Onboard, and (Electron) the settings form.
- **deploy.js** and **agent-skills.js**: deploy the skills here, and add them
  to the agents installed on this machine.

The **Electron app** (`viewer/`) adds a chat window for Claude Code sessions
(`claude -p --resume`, forking a session that is still live). The **VS Code
extension** (Cantica Agent Status on the Marketplace) adds a status-bar
summary, a badge with the number of reporting sessions, a Summary view, and
opens each agent's own chat (Claude Code, Copilot Chat, Mistral Vibe, Codex).

Both deploy the skills into this folder at start (once per version) and
offer to add them to the agents that lack them.

## Data flow

1. An agent publishes its status: `board.py publish` writes
   `status/<session>.json`, appends to `status/<model>.log`, and prints the
   settings in force and any unread messages.
2. The viewers see the change at once (file watch), and re-measure usage
   every `viewerUsageSeconds`.
3. A message sent from a viewer lands in `status/inbox/<session>/`; the
   agent reads it at its next publish (`board.py inbox`). A done session takes
   no messages.

## Rules

- Agents write here; they run only the skills' scripts under `skills/`, with
  their interpreter, never anything else stored here.
- Status updates are silent and need no authorization.
- Every tool a skill uses must be allowed for the agents
  (`setup/allow-tools.py` in the source does it for Claude Code, Copilot in
  VS Code and Codex).

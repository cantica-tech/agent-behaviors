# Cantica Agent Status for VS Code

Shows the live status of the agent sessions on this machine, from the
[session-status](../../session-status/SKILL.md) board, inside VS Code. It is
the same view as the [Electron viewer](../README.md).

- **Agent Status: Open Agent Status** opens the panel: one card per session
  with state, project, task, blocker, items left, ETA, projected and measured
  tokens, items and notes.
- The **Agent Status** icon in the activity bar opens the sidebar:
  **Sessions**, the same view as the panel, with Refresh, "open in editor"
  and Settings buttons in its title bar, and below it a **Summary** (one line
  per session: project, state, task or blocker; click one to open the full
  view). The icon's badge shows the number of reporting sessions from the
  moment VS Code starts, and nothing when there are none.
- Each card links to the session's context folder and memory; a location
  that is gone or unknown is described instead.
- **Message…** on a card sends a prompt to that agent's inbox (any agent
  that follows the session-status skill reads it when it next publishes).
  **Open session** opens the agent's own chat when VS Code has one
  (`agentStatus.chatCommands`: Claude Code reopens that very session;
  Copilot Chat, Mistral Vibe and Codex open their chat panel), otherwise
  attaches a terminal to a background Claude Code session or opens the
  session's project folder.
- **Onboard**, on live sessions that don't report only, copies a
  prompt asking the agent to load the session-status skill and opens the
  session to paste it.
- The status bar shows how many sessions are working, waiting or blocked.
  Click it to open the panel.

The board refreshes as soon as a file changes. The refresh rates come from
`~/.agent-behaviors/session-status.json` (see the session-status skill) and
change as soon as that file is saved. Edit them with the **Settings** button
in the view, or open the file itself with **Agent Status: Open Settings
File** (also the gear button in the sidebar title bar). The extension only
reads the board. Its `usage.py` deltas are kept in `.usage-vscode.json`.

## Skills deployment

At activation, the extension copies the agent skills it ships into
`<AgentsMonitor>/skills/`: `README.md` (the viewer README), `LICENSE`,
`coding/` and `session-status/`. The AgentsMonitor folder is the setting
`agentStatus.agentsMonitorFolder` (default `~/.agent-behaviors`). It copies
once per extension version, overwriting the files it ships and keeping any
others. A `skills` folder that is a link (e.g. to a checkout of
agent-behaviors) is left alone.

## Adding the skills to your agents

After deploying the skills, the extension offers to add them to every agent
installed on this machine that lacks them: Claude Code (`~/.claude/skills`),
GitHub Copilot (`~/.copilot/skills`), Codex (`~/.codex/skills`), Gemini CLI
(`~/.gemini/skills`), Mistral Vibe (`~/.vibe/skills`) and the Agent Skills
folder (`~/.agents/skills`). Each skill is linked from `<AgentsMonitor>/skills`
into the agent's folder, so redeployments reach every agent; nothing already
there is replaced. Answer **Add**, **Not now** or **Don't ask again**; the
command **Agent Status: Add Skills to Agents** lets you pick the agents at
any time.

## Settings

**Settings** (the gear in the **Sessions** title bar, or the command
**Agent Status: Settings**) opens VS Code's settings on this extension. The
refresh settings there (`viewerBoardSeconds`, `viewerUsageSeconds`,
`statusSessionSeconds`, `doneVisibleHours`) are saved to
`~/.agent-behaviors/session-status.json`, which every viewer and agent
reads, and apply at once.

| Setting | Default | Meaning |
| --- | --- | --- |
| `agentStatus.boardDirectory` | `~/.agent-behaviors/status` | Board directory |
| `agentStatus.usageScript` | bundled copy | Path to `usage.py` |
| `agentStatus.python` | `python3` | Python 3 interpreter |
| `agentStatus.showStatusBar` | `true` | Show the status-bar summary |
| `agentStatus.agentsMonitorFolder` | `~/.agent-behaviors` | Where the skills are deployed (`skills/`) |

## Build and install

The status monitor, renderer and styles live in [../shared](../shared), and
`usage.py` in the session-status skill. `npm run sync` copies them into
`media/`; packaging runs it first.

```sh
cd viewer/vscode
./install.sh              # sync, package and install into VS Code
./install.sh --no-build   # install the existing .vsix only
```

`install.sh` finds the `code` CLI on the `PATH` or inside `VS Code.app`; set
`CODE_CLI` to use another one. Reload VS Code windows afterwards.

## Release to the Marketplace

The tasks in [../Taskfile.yml](../Taskfile.yml) (`task --list` in `viewer/`)
follow catalyst-ui's. The version lives in `viewer/version.txt`, and both
`package.json` files must agree with it.

```sh
cd viewer
task version:set VERSION=x.y.z   # version.txt and both package.json
task test
git commit -am "Agent Status x.y.z" && git push
git tag agent-status-vx.y.z && git push origin agent-status-vx.y.z
task publish:vscode-extension:release
```

`publish:vscode-extension:release` refuses unless HEAD is exactly the tag
`agent-status-v<version>` and the tests pass. Publishing needs a Marketplace
token for the `canticatech` publisher: `VSCE_PAT`, or a macOS keychain item
named by `VSCE_KEYCHAIN_SERVICE` and `VSCE_KEYCHAIN_ACCOUNT`, as for
catalyst-ui.

## License

Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE).

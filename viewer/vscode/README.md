# Agent Status for VS Code

Shows the live status of the agent sessions on this machine, from the
[session-status](../../session-status/SKILL.md) board, inside VS Code. It is
the same view as the [Electron viewer](../README.md).

- **Agent Status: Open Agent Status** opens the panel: one card per session
  with state, project, task, blocker, items left, ETA, projected and measured
  tokens, items and notes.
- The **Agent Status** icon in the activity bar opens the same view in the
  sidebar, with Refresh and "open in editor" buttons in its title bar. Its
  badge shows the number of reporting sessions, and nothing when there are
  none.
- The status bar shows how many sessions are working, waiting or blocked.
  Click it to open the panel.

The board refreshes as soon as a file changes. The refresh rates come from
`~/.agent-behaviors/session-status.json` (see the session-status skill) and
change as soon as that file is saved. Edit them with the **Settings** button
in the view, or open the file itself with **Agent Status: Open Settings
File** (also the gear button in the sidebar title bar). The extension only reads the board.
Its `usage.py` deltas are kept in `.usage-vscode.json`.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `agentStatus.boardDirectory` | `~/.agent-behaviors/status` | Board directory |
| `agentStatus.usageScript` | bundled copy | Path to `usage.py` |
| `agentStatus.python` | `python3` | Python 3 interpreter |
| `agentStatus.showStatusBar` | `true` | Show the status-bar summary |

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

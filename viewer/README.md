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

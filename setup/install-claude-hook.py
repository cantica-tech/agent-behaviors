#!/usr/bin/env python3
"""Install the Claude Code SessionStart hook kept in setup/hooks/.

The hook runs setup/allow-tools.py at every Claude Code start, so the tools
of newly added skills get allowed without anyone thinking of it. The hook's
template is setup/hooks/claude-session-start.json; this script fills in the
Python command and the script path for the OS (``python3`` on macOS and
Linux, ``py -3`` on Windows), and adds it to ~/.claude/settings.json:

- keeps every other setting and hook; adds the hook once (idempotent);
- backs the settings file up first (settings.json.bak-agent-behaviors);
- refuses to rewrite a settings file that is not plain JSON.

Usage: install-claude-hook.py [--print] [--os macos|linux|windows]
  --print  show the hook that would be added, change nothing
"""

import argparse
import json
import os
import platform
import shutil
import sys

#: Root of the agent-behaviors repository (parent of setup/).
ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
#: The saved hook template.
TEMPLATE = os.path.join(ROOT, "setup", "hooks", "claude-session-start.json")
#: Claude Code's user settings.
SETTINGS = os.path.join(os.path.expanduser("~"), ".claude", "settings.json")


def current_os():
    """Return 'macos', 'linux' or 'windows' for this machine."""
    return {"Darwin": "macos", "Windows": "windows"}.get(platform.system(), "linux")


def python_command(os_name):
    """Return the command that runs Python 3 on ``os_name``."""
    return "py -3" if os_name == "windows" else "python3"


def build_hook(os_name):
    """Return (matcher, hook entry) for ``os_name`` from the saved template."""
    t = json.load(open(TEMPLATE))
    script = os.path.join(ROOT, "setup", "allow-tools.py")
    if os_name == "windows":
        script = script.replace("/", "\\")
    kind = "windows" if os_name == "windows" else "unix"
    hook = dict(t["hook"], command=t["command"][kind].format(python=python_command(os_name), script=script))
    return t["matcher"], hook


def installed(settings):
    """Return True when ``settings`` already has a SessionStart hook running allow-tools.py."""
    for group in (settings.get("hooks") or {}).get("SessionStart") or []:
        for h in group.get("hooks") or []:
            if "allow-tools.py" in str(h.get("command", "")):
                return True
    return False


def main():
    """Add the hook to ~/.claude/settings.json (or print it)."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--print", action="store_true", dest="print_only")
    ap.add_argument("--os", choices=["macos", "linux", "windows"], default=current_os())
    a = ap.parse_args()
    matcher, hook = build_hook(a.os)
    if a.print_only:
        print(json.dumps({"hooks": {"SessionStart": [{"matcher": matcher, "hooks": [hook]}]}}, indent=2))
        return 0
    settings = {}
    if os.path.exists(SETTINGS):
        try:
            settings = json.load(open(SETTINGS))
        except ValueError:
            print(f"{SETTINGS} is not plain JSON; not changed. Add this hook by hand:")
            print(json.dumps(hook, indent=2))
            return 1
        if installed(settings):
            print("The allow-tools hook is already installed.")
            return 0
        shutil.copyfile(SETTINGS, f"{SETTINGS}.bak-agent-behaviors")
    groups = settings.setdefault("hooks", {}).setdefault("SessionStart", [])
    group = next((g for g in groups if g.get("matcher") == matcher), None)
    if group is None:
        group = {"matcher": matcher, "hooks": []}
        groups.append(group)
    group.setdefault("hooks", []).append(hook)
    os.makedirs(os.path.dirname(SETTINGS), exist_ok=True)
    tmp = f"{SETTINGS}.agent-behaviors.tmp"
    with open(tmp, "w") as fh:
        json.dump(settings, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, SETTINGS)
    print(f"Installed in {SETTINGS}: {hook['command']}")
    print("New Claude Code sessions run it at start; a running session picks it up after /hooks or a restart.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

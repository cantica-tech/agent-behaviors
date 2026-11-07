#!/usr/bin/env python3
"""Allow the tools the skills use, for every agent detected on this machine.

Each skill lists the command-line tools it runs in its ``tools.json``
(``{"tools": ["mado"]}``). This script collects them and adds them to the
allow-list of every agent it finds, so agents can run them without being
blocked or asked each time:

  Claude Code      ~/.claude/settings.json        permissions.allow "Bash(<tool> *)"
  Copilot (VS Code) VS Code user settings.json     chat.tools.terminal.autoApprove {"<tool>": true}
  Codex            ~/.codex/rules/default.rules   prefix_rule(pattern=["<tool>"], decision="allow")

Agents with no allow-list this script knows how to set (Copilot CLI, Gemini
CLI, Mistral Vibe, ...) are reported with what to do by hand (for Mistral
Vibe, the "Allow: <tool>" lines to add to the project's AGENTS.md). Nothing
is ever removed, and a settings file that is not plain JSON (e.g. has
comments) is left untouched and reported, rather than rewritten.

It also tells you, with commands for your OS:
- how to install a tool that is not installed (from the skill's tools.json);
- how to install the Claude Code hook that runs this script at every start
  (setup/install-claude-hook.py), when Claude Code is detected without it.

Usage: allow-tools.py [--dry-run] [--check] [--quiet] [--os macos|linux|windows]
  --dry-run  show what would change, change nothing
  --check    change nothing; exit 1 if any detected agent lacks a tool
  --quiet    print only changes and problems (for hooks: silent when all is fine)
  --os       give the commands for another OS than this one
"""

import argparse
import glob
import json
import os
import platform
import shutil
import sys

#: Root of the agent-behaviors repository (parent of setup/).
ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
#: The user's home folder.
HOME = os.path.expanduser("~")
#: Start and end markers of the block this script owns in Codex's rules file.
CODEX_BEGIN = "# >>> agent-behaviors: tools the skills use (managed by setup/allow-tools.py)"
CODEX_END = "# <<< agent-behaviors"


def current_os():
    """Return 'macos', 'linux' or 'windows' for this machine."""
    return {"Darwin": "macos", "Windows": "windows"}.get(platform.system(), "linux")


def valid_name(name):
    """True when ``name`` is a plain command name (safe in rules and shell lines)."""
    return isinstance(name, str) and bool(name) and all(c.isalnum() or c in "._-" for c in name)


def skill_catalog(root=ROOT):
    """Return {tool: install-by-OS} for every tool listed in a skill's tools.json under ``root``.

    A tools.json lists names, or objects {"name", "install": {"macos"|"linux"|
    "windows": [{"needs": cmd, "run": [lines]}]}}.
    """
    catalog = {}
    for f in sorted(glob.glob(os.path.join(root, "**", "tools.json"), recursive=True)):
        if f"{os.sep}node_modules{os.sep}" in f or f"{os.sep}viewer{os.sep}" in f:
            continue
        try:
            data = json.load(open(f))
        except (OSError, ValueError):
            continue
        for t in data.get("tools", []) if isinstance(data, dict) else []:
            name, install = (t, {}) if isinstance(t, str) else (t.get("name"), t.get("install") or {})
            if valid_name(name):
                catalog.setdefault(name, install)
    return catalog


def skill_tools(root=ROOT):
    """Return the sorted tools listed by every skill's tools.json under ``root``."""
    return sorted(skill_catalog(root))


def install_lines(install, os_name):
    """Return the shell lines that install a tool on ``os_name``.

    Picks the first alternative whose ``needs`` command is available on this
    machine; when none is (or another OS is asked for), returns every
    alternative, each introduced by a comment line.
    """
    alts = install.get(os_name) or []
    if os_name == current_os():
        for alt in alts:
            if shutil.which(alt.get("needs", "")):
                return list(alt.get("run", []))
    lines = []
    for alt in alts:
        lines.append(f"# with {alt.get('needs')}:")
        lines.extend(alt.get("run", []))
    return lines


def python_command(os_name):
    """Return the command that runs Python 3 on ``os_name``."""
    return "py -3" if os_name == "windows" else "python3"


def claude_hook_installed():
    """True when ~/.claude/settings.json has a SessionStart hook running allow-tools.py."""
    data, err = load_json(Claude.path)
    if err or not data:
        return False
    for group in (data.get("hooks") or {}).get("SessionStart") or []:
        for h in group.get("hooks") or []:
            if "allow-tools.py" in str(h.get("command", "")):
                return True
    return False


def mistral_lines(tools, os_name):
    """Shell lines adding "Allow: <tool>" to the project's AGENTS.md, once each, for ``os_name``."""
    if os_name == "windows":
        names = ", ".join(f"'{t}'" for t in tools)
        return [f"foreach ($t in {names}) {{ if (-not (Select-String -Quiet -Pattern \"^Allow: $t$\" AGENTS.md "
                f"-ErrorAction SilentlyContinue)) {{ Add-Content AGENTS.md \"Allow: $t\" }} }}"]
    return [f"for t in {' '.join(tools)}; do grep -qx \"Allow: $t\" AGENTS.md 2>/dev/null || echo \"Allow: $t\" >> AGENTS.md; done"]


def load_json(path):
    """Return (data, error): the JSON object at ``path`` ({} if missing), or an error text."""
    if not os.path.exists(path):
        return {}, None
    try:
        with open(path) as fh:
            data = json.load(fh)
    except ValueError:
        return None, "not plain JSON (comments or trailing commas?)"
    except OSError as err:
        return None, str(err)
    return (data, None) if isinstance(data, dict) else (None, "not a JSON object")


def write_json(path, data):
    """Write ``data`` to ``path`` atomically, with 2-space indentation."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.agent-behaviors.tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


class Claude:
    """Claude Code: permissions.allow in ~/.claude/settings.json."""

    name = "Claude Code"
    path = os.path.join(HOME, ".claude", "settings.json")

    def detected(self):
        """True when Claude Code is installed (its folder or command exists)."""
        return os.path.isdir(os.path.join(HOME, ".claude")) or bool(shutil.which("claude"))

    def missing(self, tools):
        """Return (tools not yet allowed, error)."""
        data, err = load_json(self.path)
        if err:
            return tools, err
        allow = (data.get("permissions") or {}).get("allow") or []
        return [t for t in tools if f"Bash({t} *)" not in allow], None

    def apply(self, tools):
        """Add ``Bash(<tool> *)`` for each tool to permissions.allow."""
        data, _ = load_json(self.path)
        allow = data.setdefault("permissions", {}).setdefault("allow", [])
        allow.extend(f"Bash({t} *)" for t in tools)
        write_json(self.path, data)


class VSCodeCopilot:
    """Copilot in VS Code: chat.tools.terminal.autoApprove in the user settings."""

    name = "Copilot (VS Code)"

    @property
    def path(self):
        """The VS Code user settings.json for this platform."""
        if platform.system() == "Darwin":
            return os.path.join(HOME, "Library", "Application Support", "Code", "User", "settings.json")
        if platform.system() == "Windows":
            return os.path.join(os.environ.get("APPDATA", ""), "Code", "User", "settings.json")
        return os.path.join(HOME, ".config", "Code", "User", "settings.json")

    def detected(self):
        """True when VS Code has a user settings folder."""
        return os.path.isdir(os.path.dirname(self.path))

    def missing(self, tools):
        """Return (tools not yet auto-approved, error)."""
        data, err = load_json(self.path)
        if err:
            return tools, err
        approve = data.get("chat.tools.terminal.autoApprove") or {}
        return [t for t in tools if approve.get(t) is not True], None

    def apply(self, tools):
        """Set ``"<tool>": true`` for each tool in chat.tools.terminal.autoApprove."""
        data, _ = load_json(self.path)
        approve = data.setdefault("chat.tools.terminal.autoApprove", {})
        for t in tools:
            approve[t] = True
        write_json(self.path, data)


class Codex:
    """Codex: a prefix_rule per tool in ~/.codex/rules/default.rules (a block this script owns)."""

    name = "Codex"
    path = os.path.join(HOME, ".codex", "rules", "default.rules")

    def detected(self):
        """True when Codex is installed (its folder or command exists)."""
        return os.path.isdir(os.path.join(HOME, ".codex")) or bool(shutil.which("codex"))

    def _read(self):
        """Return the rules file text ('' if missing)."""
        try:
            with open(self.path) as fh:
                return fh.read()
        except OSError:
            return ""

    def _block_tools(self, text):
        """Return the tools allowed in this script's block of ``text``."""
        if CODEX_BEGIN not in text:
            return []
        block = text.split(CODEX_BEGIN, 1)[1].split(CODEX_END, 1)[0]
        return [line.split('"')[1] for line in block.splitlines() if line.strip().startswith("pattern = [")]

    def missing(self, tools):
        """Return (tools not yet allowed, error)."""
        have = self._block_tools(self._read())
        return [t for t in tools if t not in have], None

    def apply(self, tools):
        """Rewrite this script's block with every tool (old ones kept); leave the rest of the file alone."""
        text = self._read()
        keep = sorted(set(self._block_tools(text)) | set(tools))
        rules = "".join(f'prefix_rule(\n    pattern = ["{t}"],\n    decision = "allow",\n)\n' for t in keep)
        block = f"{CODEX_BEGIN}\n{rules}{CODEX_END}\n"
        if CODEX_BEGIN in text:
            before, rest = text.split(CODEX_BEGIN, 1)
            after = rest.split(CODEX_END, 1)[1].lstrip("\n") if CODEX_END in rest else ""
            text = before + block + after
        else:
            text = (text.rstrip("\n") + "\n\n" if text.strip() else "") + block
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w") as fh:
            fh.write(text)


#: Agents this script can configure.
AGENTS = [Claude(), VSCodeCopilot(), Codex()]

#: Agents detected but not configurable here: (name, detection paths/commands, what to do).
MANUAL = [
    ("Copilot CLI", ["copilot"], "start it with --allow-tool 'shell(<tool>)' for each tool, or approve each once"),
    ("Gemini CLI", ["gemini", os.path.join(HOME, ".gemini", "settings.json")], "add the tools to its settings' allowed shell commands"),
]
#: How Mistral Vibe is detected (its command, its folder, or its VS Code extension).
MISTRAL_PROBES = ["vibe", os.path.join(HOME, ".vibe")]


def mistral_detected():
    """True when Mistral Vibe is installed (CLI, folder, or VS Code extension)."""
    if any(shutil.which(p) if os.sep not in p else os.path.exists(p) for p in MISTRAL_PROBES):
        return True
    return bool(glob.glob(os.path.join(HOME, ".vscode", "extensions", "mistralai.mistral-vibe*")))


def main():
    """Detect agents, allow the skills' tools in each, and report."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--os", choices=["macos", "linux", "windows"], default=current_os())
    a = ap.parse_args()
    catalog = skill_catalog()
    tools = sorted(catalog)
    say = (lambda *x: None) if a.quiet else print
    say(f"Tools the skills use: {', '.join(tools) or 'none'}")
    lacking = False
    for agent in AGENTS:
        if not agent.detected():
            say(f"- {agent.name}: not detected")
            continue
        todo, err = agent.missing(tools)
        if err:
            print(f"- {agent.name}: {agent.path} {err}; not changed. Allow by hand: {', '.join(todo)}")
            lacking = True
        elif not todo:
            say(f"- {agent.name}: all allowed")
        elif a.check or a.dry_run:
            print(f"- {agent.name}: would allow {', '.join(todo)} in {agent.path}")
            lacking = True
        else:
            agent.apply(todo)
            print(f"- {agent.name}: allowed {', '.join(todo)} in {agent.path}")
    for name, probes, how in MANUAL:
        if any(shutil.which(p) if os.sep not in p else os.path.exists(p) for p in probes):
            say(f"- {name}: detected; no allow-list set automatically: {how} ({', '.join(tools)})")
    if mistral_detected() and tools:
        say("- Mistral Vibe: detected; in each project where you use it, add the tools to AGENTS.md:")
        for line in mistral_lines(tools, a.os):
            say(f"    {line}")
    # Tools that are not installed: how to install them on this OS.
    for name in tools:
        if a.os == current_os() and shutil.which(name):
            continue
        lines = install_lines(catalog[name], a.os)
        print(f"! {name} is not installed. Install it ({a.os}):" if a.os == current_os() else f"Install {name} ({a.os}):")
        for line in lines or ["(no install command known; see the skill's README)"]:
            print(f"    {line}")
    # The Claude Code hook that runs this script at every start.
    if Claude().detected() and not claude_hook_installed():
        print("! Claude Code: to allow new skills' tools at every start, install the hook once:")
        print(f"    {python_command(a.os)} \"{os.path.join(ROOT, 'setup', 'install-claude-hook.py')}\"")
    return 1 if a.check and lacking else 0


if __name__ == "__main__":
    sys.exit(main())

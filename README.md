# agent-behaviors

Agent-neutral behaviours (skills) that any coding agent and any model can use.
Each skill is a folder with a `SKILL.md`: YAML front matter (`name`,
`description`) followed by plain-markdown instructions, plus the scripts those
instructions call. They need only a shell and Python 3, plus the optional
tools listed under [Tools](#tools).

| Skill | What it does |
|---|---|
| [session-status](session-status/SKILL.md) | Each session publishes its status (task, items/time left, projected tokens) to `~/.agent-behaviors/status/` and sends its activities to a background session `<model>.status` (created if missing), which writes its findings to `~/.agent-behaviors/status/`; any session reports on all of them, combining those entries with token usage measured from each agent's own session store. |
| [coding/docstrings](coding/docstrings/SKILL.md) | **Do not forget docstrings**, especially on public properties, methods, classes, etc., in every language and in configuration files. |
| [coding/markdown](coding/markdown/SKILL.md) | Lint every Markdown file you produce with [mado](https://github.com/akiomik/mado) and fix it, using the project's own `mado.toml` when it has one; if mado is not available, say so in the session status. |
| [coding/toml](coding/toml/SKILL.md) | Lint every TOML file you produce with [Taplo](https://github.com/tamasfe/taplo) and fix it, using the project's own `.taplo.toml` / `taplo.toml` when it has one; if Taplo is not available, say so in the session status. |

## Tools

Optional tools some skills use. A skill whose tool is missing still works and
says so in the session status.

| Tool | Used by | What for | Install |
|---|---|---|---|
| [mado](https://github.com/akiomik/mado) | [coding/markdown](coding/markdown/SKILL.md) | Markdown linter (markdownlint rules). Config: the project's `mado.toml` / `.mado.toml`, else `~/.config/mado/mado.toml`, else [coding/markdown/mado.toml](coding/markdown/mado.toml). | see below |
| [Taplo](https://github.com/tamasfe/taplo) | [coding/toml](coding/toml/SKILL.md) | TOML linter and formatter (syntax, duplicate keys, JSON Schema, formatting). Config: the project's `.taplo.toml` / `taplo.toml`, else `TAPLO_CONFIG`, else the minimal [coding/toml/taplo.toml](coding/toml/taplo.toml). | see below |

Install mado:

```sh
# macOS / Linux (Homebrew)
brew tap akiomik/mado https://github.com/akiomik/mado.git
brew install mado

# Nix
nix profile install github:akiomik/mado

# Arch Linux
pacman -S mado
```

Windows (Scoop), or pre-built binaries from the
[release page](https://github.com/akiomik/mado/releases/latest):

```sh
scoop install https://raw.githubusercontent.com/akiomik/mado/refs/heads/main/pkg/scoop/mado.json
```

Check it with `mado --version`.

Install Taplo:

```sh
# macOS / Linux (Homebrew)
brew install taplo

# Any platform with Rust
cargo install taplo-cli --locked

# Any platform with Node.js
npm install -g @taplo/cli
```

Or pre-built binaries from the
[release page](https://github.com/tamasfe/taplo/releases/latest). Check it
with `taplo --version`.

## Installing

Link each skill into every agent's skills folder:

```sh
for d in ~/.claude/skills ~/.copilot/skills ~/.codex/skills ~/.gemini/skills; do
  mkdir -p "$d"
  ln -sfn ~/sources/agent-behaviors/session-status "$d/session-status"
  ln -sfn ~/sources/agent-behaviors/coding/docstrings "$d/docstrings"
  ln -sfn ~/sources/agent-behaviors/coding/markdown "$d/markdown"
  ln -sfn ~/sources/agent-behaviors/coding/toml "$d/toml"
done
```

If an agent doesn't load skill folders, add one line to its global
instructions file (`AGENTS.md`, `GEMINI.md`, `copilot-instructions.md`, …):

> For session status (yours or others'), follow ~/sources/agent-behaviors/session-status/SKILL.md.
>
> When writing or editing code or configuration, follow ~/sources/agent-behaviors/coding/docstrings/SKILL.md.
>
> When writing or editing Markdown, follow ~/sources/agent-behaviors/coding/markdown/SKILL.md.
>
> When writing or editing TOML, follow ~/sources/agent-behaviors/coding/toml/SKILL.md.

## Running it on a loop

- Claude Code: `/loop 5m /session-status`
- Other agents: use their own scheduler, or ask the session to check
  `board.py pending` at natural breaks (SKILL.md, Role 1).

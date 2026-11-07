# Instructions for agents working on agent-behaviors

Allow: mado
Allow: taplo

The `Allow:` lines let Mistral Vibe run the tools the skills use, without
asking each time. They list every tool in the skills' `tools.json` files;
when a skill adds a tool, run the `AGENTS.md` command that
`setup/allow-tools.py` prints for Mistral Vibe here, or add the line by hand.

## Skills to follow

- Publish your status, and read your inbox, as described in
  [session-status/SKILL.md](session-status/SKILL.md).
- When writing or editing code or configuration, follow
  [coding/docstrings/SKILL.md](coding/docstrings/SKILL.md).
- When writing or editing Markdown, follow
  [coding/markdown/SKILL.md](coding/markdown/SKILL.md) (lint with `mado`).
- When writing or editing TOML, follow
  [coding/toml/SKILL.md](coding/toml/SKILL.md) (lint with `taplo`).

## Rules

- Write in `~/.agent-behaviors`, never execute anything stored there: run
  the skills' scripts from this repository.
- Status updates are silent and need no authorization.

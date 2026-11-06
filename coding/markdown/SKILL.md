---
name: markdown
description: Lint every Markdown file you create or change with mado and fix what it reports, if mado is installed; if it is not, record that in your session status. Use whenever you write or edit a Markdown file (.md, .markdown), in any agent and with any model.
---

# markdown

Works for any coding agent and any model. `<skill>` below is the directory
this file is in.

**Lint every Markdown file you produce with mado and fix it, if mado is
available.**

## 1. Is mado available?

```sh
command -v mado
```

- Found: go to step 2.
- Not found: go to step 4. Do not install it unless the user asks.

## 2. Lint the files you created or changed

Lint only your own files, with the first configuration found:

1. **The project's own config, if it exists:** a `mado.toml` or
   `.mado.toml` in the project you are working on (its root, or the nearest
   directory above the files). Always use it when there is one:
   `mado --config <project>/mado.toml check <files>`.
2. Otherwise the user's global `~/.config/mado/mado.toml`:
   `mado check <files>`, run from the project root.
3. Neither exists: this skill's default,
   `mado --config <skill>/mado.toml check <files>`.

Pass `--config` explicitly in cases 1 and 3: on its own, mado only looks in
the current directory.

Never change the project's or the user's mado configuration to make a file
pass.

## 3. Fix and lint again

mado does not rewrite files. Fix each reported line yourself, then run the
same command again until it reports no problems. If a rule can't be met
without breaking the content (a long URL, a required HTML element, front
matter), leave it and say which rule and line in your reply. Don't disable
rules.

## 4. mado is not available

Say it in your session status, so whoever reads the board sees the files
went unlinted. With the session-status skill:

```sh
python3 <session-status skill>/scripts/board.py publish --session <id> \
  --agent <agent> --model <exact model id> --task "<current task>" \
  --note "mado not available: <files> not linted"
```

Without it, say the same in your reply to the user. Either way, still check
the files by eye against the rules in `<skill>/mado.toml`.

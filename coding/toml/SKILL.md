---
name: toml
description: Lint every TOML file you create or change with Taplo (syntax, duplicate keys, schema, formatting) and fix what it reports, if Taplo is installed; if it is not, record that in your session status. Use whenever you write or edit a .toml file, in any agent and with any model.
---

# toml

Works for any coding agent and any model. `<skill>` below is the directory
this file is in.

**Lint every TOML file you produce with Taplo and fix it, if Taplo is
available.**

## 1. Is Taplo available?

```sh
command -v taplo
```

- Found: go to step 2.
- Not found: go to step 4. Do not install it unless the user asks.

## 2. Lint the files you created or changed

Lint only your own files, with the first configuration found:

1. **The project's own config, if it exists:** a `.taplo.toml` or
   `taplo.toml` in the project you are working on (its root, or the nearest
   directory above the files). Always use it when there is one; it
   replaces this skill's default entirely.
2. Otherwise `TAPLO_CONFIG`, if the user has set it: no `--config` flag.
3. Neither exists: this skill's minimal default, `<skill>/taplo.toml`.

```sh
taplo check --config <config> <file.toml> [...]        # syntax, keys, schema
taplo fmt --check --config <config> <file.toml> [...]  # formatting
```

In case 2, drop `--config <config>`. Pass `--config` explicitly in cases 1
and 3: on its own, Taplo only looks in the current directory.

Never change the project's Taplo configuration to make a file pass.

## 3. Fix and lint again

- Formatting: `taplo fmt --config <config> <file.toml> [...]` rewrites your
  files in place. Run it only on files you created or changed.
- Errors from `taplo check` (invalid syntax, duplicate keys, schema
  violations): fix them yourself.

Run both commands again until they report no problems. If something can't
be fixed without changing what the file means, leave it and say which file
and line in your reply.

## 4. Taplo is not available

Say it in your session status, so whoever reads the board sees the files
went unlinted. With the session-status skill:

```sh
python3 <session-status skill>/scripts/board.py publish --session <id> \
  --agent <agent> --model <exact model id> --task "<current task>" \
  --note "taplo not available: <files> not linted"
```

Without it, say the same in your reply to the user. Either way, still check
the files parse (Python 3.11+): `python3 -c "import tomllib,sys;tomllib.load(open(sys.argv[1],'rb'))" <file.toml>`.

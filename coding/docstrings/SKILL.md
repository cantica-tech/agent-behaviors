---
name: docstrings
description: Always write docstrings / doc comments when writing or changing code or configuration files, especially on public properties, methods, functions, classes, modules and configuration keys. Use whenever you write or edit code or configuration in any language.
---

# docstrings

Works for any coding agent and any model.

**DO NOT FORGET DOCSTRINGS, ESPECIALLY ON PUBLIC PROPERTIES, METHODS, ETC.**

This applies to every language and to configuration files.

## What to document

Whenever you add or change any of these, give it a docstring or doc comment
in the same change:

- **Public API first:** public classes, interfaces, types, functions,
  methods, properties, fields, constants, enums and their members, modules
  and packages.
- **Non-trivial private code:** private code whose purpose or constraints
  are not obvious from its name.
- **Configuration files:** each non-obvious key, section or setting gets a
  comment saying what it does, its allowed values or units, and its default
  (YAML, TOML, INI, `.env`, Dockerfiles, CI files, …). Use a sibling
  `README`, a schema `description` field, or `$comment`/`//` where the format
  allows it when it has no comment syntax (e.g. plain JSON).

## How to write them

- Use the language's own convention so tools pick them up: Python
  docstrings (PEP 257), JSDoc/TSDoc, Javadoc/KDoc, C# XML `///`, Go doc
  comments, Rust `///` and `//!`, Swift/Obj-C `///`, PHPDoc, Ruby YARD,
  Doxygen for C/C++, and so on.
- Follow the project's existing style (Google, NumPy, reST, …) when there is
  one.
- Say what it does and why, not how. Cover parameters, return value, errors
  or exceptions raised, side effects, units, and non-obvious constraints.
  Keep a one-line summary first.
- When you change behaviour, update the docstring in the same edit. A stale
  docstring is worse than none.
- Don't restate the name (`/** Gets the name. */ getName()` adds nothing);
  say what a reader can't tell from the signature.

## Before you finish

Check your diff: every new or changed public symbol and every new
configuration key has an accurate docstring or comment. Add any that are
missing before reporting the work as done.

#!/usr/bin/env python3
"""Measured token usage of recent agent sessions on this machine, any agent.

Readers: Claude Code, GitHub Copilot CLI / VS Code agent host, Codex CLI,
Gemini CLI. A reader whose store is absent is skipped silently.

Usage: usage.py [--exclude <session-id-prefix>] [--hours N] [--agent NAME]
                [--model MODEL] [--state NAME]

Prints one JSON object per session, most recent first, with: agent, session,
model, cwd, title, first, last, idle_minutes, calls, output, input,
cache_read, cache_write, context (latest context size, when the store gives
it), total, delta_output / delta_total / delta_calls since the previous run.
Previous-run state: ~/.agent-behaviors/status/.usage-<NAME>.json (default
NAME: "last"), so each caller gets its own deltas. --model keeps only the
sessions whose model has the same key as board.py model-key.
"""

import argparse
import glob
import json
import os
import re
import sqlite3
import time

#: The user's home directory, root of every agent store read here.
HOME = os.path.expanduser("~")
#: Directory holding the previous-run state files.
STATE_DIR = os.path.join(HOME, ".agent-behaviors", "status")


def model_key(model):
    """Return the canonical key for a model id (same rule as board.py)."""
    m = (model or "").strip().lower().rsplit("/", 1)[-1]
    m = re.sub(r"[^a-z0-9-]+", "-", m).strip("-")
    return m or "unknown"


def blank(agent, sid, path):
    """Return an empty usage record for session ``sid`` read from ``path``."""
    return dict(agent=agent, session=sid, model=None, cwd=None, title="",
                first=None, last=None, mtime=os.path.getmtime(path), calls=0,
                output=0, input=0, cache_read=0, cache_write=0, context=None)


def jsonl(path):
    """Yield each JSON object of a JSON-lines file, skipping unreadable lines."""
    with open(path, errors="replace") as fh:
        for line in fh:
            try:
                yield json.loads(line)
            except ValueError:
                continue


def stamp(s, ts):
    """Record timestamp ``ts`` as the first (if unset) and last seen in ``s``."""
    if ts:
        s["first"] = s["first"] or ts
        s["last"] = ts


# --- Claude Code: ~/.claude/projects/<project>/<session>.jsonl --------------
def claude_code(since):
    """Yield usage records of Claude Code sessions modified after ``since``."""
    for f in glob.glob(f"{HOME}/.claude/projects/*/*.jsonl"):
        if os.path.getmtime(f) < since:
            continue
        s = blank("claude-code", os.path.basename(f)[:-6], f)
        seen = set()
        for d in jsonl(f):
            s["cwd"] = s["cwd"] or d.get("cwd")
            stamp(s, d.get("timestamp"))
            m = d.get("message") or {}
            if d.get("type") == "assistant":
                mid = m.get("id")
                if not mid or mid in seen or m.get("model") == "<synthetic>":
                    continue
                seen.add(mid)
                u = m.get("usage") or {}
                s["model"] = m.get("model") or s["model"]
                s["input"] += u.get("input_tokens", 0)
                s["output"] += u.get("output_tokens", 0)
                s["cache_read"] += u.get("cache_read_input_tokens", 0)
                s["cache_write"] += u.get("cache_creation_input_tokens", 0)
                s["context"] = (u.get("input_tokens", 0)
                                + u.get("cache_read_input_tokens", 0)
                                + u.get("cache_creation_input_tokens", 0))
                s["calls"] += 1
            elif d.get("type") == "user":
                c = m.get("content")
                if isinstance(c, str) and c.strip() and not c.startswith("<"):
                    s["title"] = s["title"] or c[:120].replace("\n", " ")
        yield s


# --- Copilot: ~/.copilot/session-state/<session>/events.jsonl --------------
def copilot(since):
    """Yield usage records of Copilot sessions modified after ``since``."""
    for f in glob.glob(f"{HOME}/.copilot/session-state/*/events.jsonl"):
        if os.path.getmtime(f) < since:
            continue
        s = blank("copilot", os.path.basename(os.path.dirname(f)), f)
        for d in jsonl(f):
            stamp(s, d.get("timestamp"))
            t, data = d.get("type"), d.get("data") or {}
            if t == "session.start":
                s["cwd"] = (data.get("context") or {}).get("cwd")
                s["model"] = data.get("selectedModel")
            elif t == "user.message" and not s["title"]:
                s["title"] = str(data.get("content", ""))[:120].replace("\n", " ")
            elif t == "session.usage_record":
                u = data.get("usage") or {}
                s["model"] = u.get("model") or s["model"]
                s["input"] += u.get("inputTokens", 0)
                s["output"] += u.get("outputTokens", 0)
                s["cache_read"] += u.get("cacheReadTokens", 0)
                s["cache_write"] += u.get("cacheWriteTokens", 0)
                s["context"] = u.get("inputTokens", 0)
                s["calls"] += 1
        yield s


# --- Codex: ~/.codex/state_*.sqlite, table threads (cumulative tokens) -----
def codex(since):
    """Yield usage records of Codex threads updated after ``since``.

    Codex stores only a cumulative token count, returned as ``total``.
    """
    for db in glob.glob(f"{HOME}/.codex/state_*.sqlite"):
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            rows = con.execute(
                "select id, cwd, title, model, tokens_used, created_at, updated_at"
                " from threads where archived = 0 and updated_at >= ?",
                (int(since),)).fetchall()
        except sqlite3.Error:
            continue
        for sid, cwd, title, model, tokens, created, updated in rows:
            iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
            yield dict(agent="codex", session=sid, model=model, cwd=cwd,
                       title=(title or "")[:120], first=iso(created),
                       last=iso(updated), mtime=updated, calls=None,
                       output=None, input=None, cache_read=None,
                       cache_write=None, context=None, total=tokens)


# --- Gemini CLI: ~/.gemini/tmp/<hash>/chats/session-*.json (untested) -------
def gemini(since):
    """Yield usage records of Gemini CLI chats modified after ``since`` (best-effort)."""
    for f in glob.glob(f"{HOME}/.gemini/tmp/*/chats/*.json"):
        if os.path.getmtime(f) < since:
            continue
        try:
            doc = json.load(open(f))
        except (OSError, ValueError):
            continue
        s = blank("gemini", doc.get("sessionId") or os.path.basename(f)[:-5], f)
        stamp(s, doc.get("startTime"))
        stamp(s, doc.get("lastUpdated"))
        for m in doc.get("messages", []):
            if m.get("type") == "user" and not s["title"]:
                s["title"] = str(m.get("content", ""))[:120].replace("\n", " ")
            tok = m.get("tokens")
            if tok:
                s["model"] = m.get("model") or s["model"]
                s["input"] += tok.get("input", 0)
                s["output"] += tok.get("output", 0)
                s["cache_read"] += tok.get("cached", 0)
                s["context"] = tok.get("input", 0)
                s["calls"] += 1
        yield s


#: Store readers by agent name; each takes a cutoff epoch and yields records.
READERS = dict(claude_code=claude_code, copilot=copilot, codex=codex, gemini=gemini)


def main():
    """Print one JSON usage record per recent session and save state for deltas."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--exclude", default="", help="your own session id (prefix)")
    ap.add_argument("--hours", type=float, default=3)
    ap.add_argument("--agent", choices=sorted(READERS), action="append")
    ap.add_argument("--model", help="keep only sessions of this model")
    ap.add_argument("--state", default="last",
                    help="name of the previous-run state, one per caller")
    a = ap.parse_args()
    state = os.path.join(STATE_DIR, f".usage-{re.sub(r'[^A-Za-z0-9._-]+', '-', a.state)}.json")
    want = model_key(a.model) if a.model else None

    try:
        prev = json.load(open(state))
    except (OSError, ValueError):
        prev = {}
    now = time.time()
    since = now - a.hours * 3600
    out = []
    for name in a.agent or READERS:
        try:
            for s in READERS[name](since):
                if a.exclude and s["session"].startswith(a.exclude):
                    continue
                if want and model_key(s.get("model")) != want:
                    continue
                if s.get("total") is None:
                    s["total"] = sum(s[k] or 0 for k in
                                     ("input", "output", "cache_read", "cache_write"))
                if not s["total"] and not s["calls"]:
                    continue
                s["idle_minutes"] = round((now - s.pop("mtime")) / 60, 1)
                p = prev.get(s["session"], {})
                for k in ("output", "total", "calls"):
                    if s.get(k) is not None:
                        s[f"delta_{k}"] = s[k] - p.get(k, 0)
                out.append(s)
        except Exception as e:  # a broken store never hides the others
            out.append(dict(agent=name, error=str(e)))
    out.sort(key=lambda s: s.get("idle_minutes", 1e9))
    for s in out:
        print(json.dumps(s))
    os.makedirs(STATE_DIR, exist_ok=True)
    keep = {s["session"]: {k: s.get(k) for k in ("output", "total", "calls")}
            for s in out if "session" in s}
    with open(state, "w") as fh:
        json.dump({**prev, **keep}, fh)


if __name__ == "__main__":
    main()

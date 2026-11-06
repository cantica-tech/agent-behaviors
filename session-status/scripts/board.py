#!/usr/bin/env python3
"""Shared status board for agent sessions on this machine, any agent or model.

Everything lives in ~/.agent-behaviors/status/:

  <session>.json            one entry per session: what it is doing, what is left
  <model>.log               every published entry of that model, one JSON line each
  <model>.md                the latest report, written by the <model>.status session
  .<model>.status.json      claim + heartbeat of the <model>.status session
  .request.json             the latest "please publish now" request

`<model>` is always the key given by `board.py model-key <model id>`.

  board.py publish --session ID --agent NAME [--model M] [--cwd DIR]
                   --task TEXT [--items-left N] [--items TEXT ...]
                   [--eta TEXT] [--tokens-left N] [--blocker TEXT]
                   [--state working|idle|waiting|done] [--note TEXT ...]
  board.py request [--from NAME]     ask every session to publish now
  board.py read [--hours N] [--model M]
                                     print board entries, newest first
  board.py pending --session ID      exit 0 if a request is newer than your entry
  board.py model-key MODEL           print the canonical key for a model id
  board.py claim --model M --by ID   exit 0 if you must start <model>.status
  board.py heartbeat --model M --by NAME
                                     the <model>.status session is alive
  board.py status --model M          print the <model>.status claim; exit 0 if alive
"""

import argparse
import glob
import json
import os
import re
import time

#: Directory holding the board, the logs, the reports and the heartbeats.
BOARD = os.path.expanduser("~/.agent-behaviors/status")
#: File holding the latest "please publish now" request.
REQUEST = os.path.join(BOARD, ".request.json")
#: Minutes without a heartbeat after which a <model>.status session counts as gone.
STALE_MINUTES = 15


def now_iso():
    """Return the current UTC time as an ISO-8601 string ending in ``Z``."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def model_key(model):
    """Return the canonical key for a model id, shared by every agent.

    Lowercases the id, drops a provider prefix such as ``anthropic/`` and
    replaces anything other than letters, digits and dashes with a dash, so
    ``Claude-Opus-5.5`` and ``anthropic/claude-opus-5-5`` both give
    ``claude-opus-5-5``. Returns ``"unknown"`` for an empty id.
    """
    m = (model or "").strip().lower().rsplit("/", 1)[-1]
    m = re.sub(r"[^a-z0-9-]+", "-", m).strip("-")
    return m or "unknown"


def write_json(path, data):
    """Write ``data`` as JSON to ``path`` atomically (temp file + rename)."""
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=1)
    os.replace(tmp, path)


def load_json(path):
    """Return the JSON object stored at ``path``, or ``None`` if unreadable."""
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def claim_path(model):
    """Return the claim/heartbeat file of the ``<model>.status`` session."""
    return os.path.join(BOARD, f".{model_key(model)}.status.json")


def publish(a):
    """Write this session's entry and append it to its model's activity log."""
    os.makedirs(BOARD, exist_ok=True)
    entry = dict(session=a.session, agent=a.agent, model=a.model,
                 cwd=a.cwd or os.getcwd(), state=a.state, task=a.task,
                 items_left=a.items_left, items=a.items or [], eta=a.eta,
                 tokens_left=a.tokens_left, blocker=a.blocker,
                 notes=a.note or [],
                 updated=now_iso(), updated_epoch=time.time())
    path = os.path.join(BOARD, f"{a.session}.json")
    write_json(path, entry)
    with open(os.path.join(BOARD, f"{model_key(a.model)}.log"), "a") as fh:
        fh.write(json.dumps(entry) + "\n")
    print(path)


def request(a):
    """Record a request asking every session to publish its entry now."""
    os.makedirs(BOARD, exist_ok=True)
    write_json(REQUEST, dict(by=a.from_, at=now_iso(), epoch=time.time()))
    print(REQUEST)


def read(a):
    """Print every entry updated in the last ``--hours``, newest first.

    With ``--model``, print only the entries whose model has the same key.
    """
    since = time.time() - a.hours * 3600
    want = model_key(a.model) if a.model else None
    rows = []
    for f in glob.glob(os.path.join(BOARD, "*.json")):
        e = load_json(f)
        if not isinstance(e, dict) or "session" not in e:
            continue
        if want and model_key(e.get("model")) != want:
            continue
        if e.get("updated_epoch", 0) >= since:
            e["age_minutes"] = round((time.time() - e["updated_epoch"]) / 60, 1)
            rows.append(e)
    for e in sorted(rows, key=lambda e: e["age_minutes"]):
        print(json.dumps(e))


def pending(a):
    """Exit 0 if a publish request is newer than this session's entry, else 1."""
    req = (load_json(REQUEST) or {}).get("epoch")
    if req is None:
        raise SystemExit(1)
    mine = (load_json(os.path.join(BOARD, f"{a.session}.json")) or {}).get(
        "updated_epoch", 0)
    raise SystemExit(0 if req > mine else 1)


def alive(c):
    """Return True if claim ``c`` has a heartbeat newer than STALE_MINUTES."""
    return bool(c) and time.time() - c.get("beat_epoch", 0) < STALE_MINUTES * 60


def claim(a):
    """Claim the job of starting ``<model>.status``.

    Exits 0 when the caller now holds the claim and must start the session,
    1 when a live session (or a fresh claim by someone else) already exists.
    Uses an exclusive create, so of two sessions racing only one wins.
    """
    os.makedirs(BOARD, exist_ok=True)
    path = claim_path(a.model)
    current = load_json(path)
    if alive(current):
        print(json.dumps(current))
        raise SystemExit(1)
    if current is not None:
        try:
            os.remove(path)  # stale: the session that held it is gone
        except FileNotFoundError:
            pass
    mine = dict(model=model_key(a.model), session=f"{model_key(a.model)}.status",
                claimed_by=a.by, beat_by=a.by, at=now_iso(),
                beat_epoch=time.time())
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        print(json.dumps(load_json(path)))
        raise SystemExit(1)
    with os.fdopen(fd, "w") as fh:
        json.dump(mine, fh, indent=1)
    print(json.dumps(mine))


def heartbeat(a):
    """Mark the ``<model>.status`` session as alive now."""
    os.makedirs(BOARD, exist_ok=True)
    c = load_json(claim_path(a.model)) or dict(
        model=model_key(a.model), session=f"{model_key(a.model)}.status",
        claimed_by=a.by)
    c.update(beat_by=a.by, beat=now_iso(), beat_epoch=time.time())
    write_json(claim_path(a.model), c)


def status(a):
    """Print the ``<model>.status`` claim; exit 0 if that session is alive."""
    c = load_json(claim_path(a.model))
    if c:
        c["beat_age_minutes"] = round((time.time() - c.get("beat_epoch", 0)) / 60, 1)
        print(json.dumps(c))
    raise SystemExit(0 if alive(c) else 1)


def main():
    """Parse the command line and run the chosen subcommand."""
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("publish")
    p.add_argument("--session", required=True)
    p.add_argument("--agent", required=True)
    p.add_argument("--model")
    p.add_argument("--cwd")
    p.add_argument("--state", default="working",
                   choices=["working", "idle", "waiting", "done"])
    p.add_argument("--task", required=True)
    p.add_argument("--items-left", type=int)
    p.add_argument("--items", nargs="*")
    p.add_argument("--eta")
    p.add_argument("--tokens-left", type=int)
    p.add_argument("--blocker")
    p.add_argument("--note", action="append",
                   help="something readers should know, e.g. a missing tool")
    p.set_defaults(fn=publish)
    r = sub.add_parser("request")
    r.add_argument("--from", dest="from_", default="")
    r.set_defaults(fn=request)
    g = sub.add_parser("read")
    g.add_argument("--hours", type=float, default=3)
    g.add_argument("--model")
    g.set_defaults(fn=read)
    q = sub.add_parser("pending")
    q.add_argument("--session", required=True)
    q.set_defaults(fn=pending)
    k = sub.add_parser("model-key")
    k.add_argument("model")
    k.set_defaults(fn=lambda a: print(model_key(a.model)))
    for name, fn in (("claim", claim), ("heartbeat", heartbeat)):
        c = sub.add_parser(name)
        c.add_argument("--model", required=True)
        c.add_argument("--by", required=True)
        c.set_defaults(fn=fn)
    s = sub.add_parser("status")
    s.add_argument("--model", required=True)
    s.set_defaults(fn=status)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()

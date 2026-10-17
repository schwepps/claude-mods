"""Incrementally reads Claude Code transcripts and prints live agents plus hourly usage as one JSON line.

Usage: scan.py <projects_dir> <state_path> <exclude_session_id> <live_minutes>
"""

import fcntl
import json
import os
import sys
import re
import time
from datetime import datetime, timedelta

HISTORY_DAYS = 760
DETAIL_DAYS = 62
STATE_VERSION = 5

# Anthropic first-party list prices in USD per million tokens (input, output, cache read), as of 2026-10-06.
# Matched in order, so a more specific id comes before its prefix. Cache writes are priced from input:
# 1.25x for the 5-minute TTL, 2x for the 1-hour TTL.
PRICES = (
    ("fable-5-1", 10.0, 50.0, 0.25),
    ("mythos-5-1", 10.0, 50.0, 0.25),
    ("fable-5", 10.0, 50.0, 1.0),
    ("mythos-5", 10.0, 50.0, 1.0),
    ("opus-5-5", 4.0, 20.0, 0.20),
    ("opus-5", 5.0, 25.0, 0.50),
    ("opus-4-8", 5.0, 25.0, 0.50),
    ("opus-4-7", 5.0, 25.0, 0.50),
    ("opus-4-6", 5.0, 25.0, 0.50),
    ("opus-4-5", 5.0, 25.0, 0.50),
    ("sonnet-5-5", 2.0, 10.0, 0.20),
    ("sonnet-5", 2.0, 10.0, 0.20),
    ("sonnet-4-5", 3.0, 15.0, 0.30),
    ("sonnet-4", 3.0, 15.0, 0.30),
    ("haiku-5-5", 0.10, 0.50, 0.01),
    ("haiku-4-5", 1.0, 5.0, 0.10),
)
HAIKU_55_LONG = (0.50, 2.50, 0.05)
HAIKU_55_LONG_PROMPT = 100_000
RECENT_IDS = 64
FAMILIES = ("opus", "sonnet", "haiku", "fable")
ARG_KEYS = ("file_path", "path", "command", "pattern", "url", "query", "description", "prompt", "skill")


def family(model):
    m = (model or "").lower()
    for f in FAMILIES:
        if f in m:
            return f
    return "other"


def model_key(model):
    """Bucket key for a model id: family plus version ("opus-5-5"), the bare family when no version is found, else "other"."""
    m = re.sub(r"-\d{8}$", "", re.sub(r"\[.*\]$", "", (model or "").lower()))
    fam = family(m)
    if fam == "other":
        return "other"
    after = re.match(r"-(\d{1,2})(?:-(\d{1,2}))?(?!\d)", m.split(fam, 1)[1])
    before = re.search(r"claude-(\d{1,2})(?:-(\d{1,2}))?-" + fam, m)
    hit = after or before
    if not hit:
        return fam
    return "-".join([fam] + [g for g in hit.groups() if g])


def fold_days(hours, detail_cutoff):
    """Hours older than the detail window collapse into one bucket per day at noon."""
    out = {}
    for key, bucket in hours.items():
        slot = key if key[:10] >= detail_cutoff else key[:10] + "T12"
        into = out.setdefault(slot, {})
        for k, vec in bucket.items():
            cur = into.get(k, [0] * len(vec))
            into[k] = [round(a + b, 6) for a, b in zip(cur + [0] * (len(vec) - len(cur)), vec)]
    return out


def merge_legacy(state, legacy):
    """Family-keyed history from before per-version buckets, kept only for days the transcripts on disk no longer cover."""
    if not legacy or not state["hist"]:
        return
    floor = min(state["hist"])[:10]
    for k, bucket in legacy.get("hist", {}).items():
        if k[:10] < floor:
            state["hist"][k] = bucket
    for repo, hours in legacy.get("phist", {}).items():
        for k, bucket in hours.items():
            if k[:10] < floor:
                state["phist"].setdefault(repo, {})[k] = bucket
    for repo, days in legacy.get("psess", {}).items():
        for d, ids in days.items():
            if d < floor:
                state["psess"].setdefault(repo, {})[d] = ids


def hour_key(ts):
    try:
        d = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone()
    except (ValueError, AttributeError):
        d = datetime.now()
    return d.strftime("%Y-%m-%dT%H")


def epoch_ms(ts):
    try:
        return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, AttributeError):
        return 0


def describe(name, inp):
    label = name.split("__", 1)[1].replace("__", " · ") if name.startswith("mcp__") else name
    if isinstance(inp, dict):
        for k in ARG_KEYS:
            v = inp.get(k)
            if isinstance(v, str) and v.strip():
                arg = " ".join(v.split())
                if k in ("file_path", "path"):
                    arg = "/".join(arg.split("/")[-2:])
                return f"{label} {arg[:79] + '…' if len(arg) > 80 else arg}"
    return label


def price_of(model, prompt_tokens):
    """(price or None, matched table key or None, exact). Not exact: the id carries a version the table does not list."""
    m = re.sub(r"-\d{8}$", "", re.sub(r"\[.*\]$", "", (model or "").lower()))
    for key, i, o, r in PRICES:
        at = m.find(key)
        if at < 0:
            continue
        exact = not re.match(r"-\d{1,2}(?!\d)", m[at + len(key):])
        if key == "haiku-5-5" and prompt_tokens > HAIKU_55_LONG_PROMPT:
            return HAIKU_55_LONG, key, exact
        return (i, o, r), key, exact
    return None, None, False


def usage_vector(model, usage):
    """[input incl. cache writes, output, cache read, usd, usd input, usd output, usd cache write, usd cache read]."""
    plain = int(usage.get("input_tokens") or 0)
    written = int(usage.get("cache_creation_input_tokens") or 0)
    out = int(usage.get("output_tokens") or 0)
    read = int(usage.get("cache_read_input_tokens") or 0)
    vec = [plain + written, out, read, 0.0, 0.0, 0.0, 0.0, 0.0]
    price = price_of(model, plain + written + read)[0]
    if price is None:
        return vec
    p_in, p_out, p_read = (x / 1e6 for x in price)
    split = usage.get("cache_creation") or {}
    one_hour = int(split.get("ephemeral_1h_input_tokens") or 0)
    five_min = int(split.get("ephemeral_5m_input_tokens") or 0) if split else written
    speed = 2.0 if usage.get("speed") == "fast" else 1.0
    cost_in = plain * p_in * speed
    cost_out = out * p_out * speed
    cost_write = (five_min * 1.25 + one_hour * 2.0) * p_in * speed
    cost_read = read * p_read * speed
    vec[3:] = [cost_in + cost_out + cost_write + cost_read, cost_in, cost_out, cost_write, cost_read]
    return vec


def new_record(path):
    return {
        "offset": 0, "ids": [], "title": None, "model": None, "effort": None,
        "in": 0, "out": 0, "cache": 0, "first": 0, "last": 0, "steps": 0,
        "activity": "", "stop": None, "cwd": None, "branch": None, "session": None,
        "agentId": None, "todo": None, "tasks": [0, 0], "usd": 0.0, "lastMid": None, "lastVec": None,
    }


def repo_of(cwd):
    root = (cwd or "").split("/.claude/worktrees/")[0]
    return os.path.basename(root) or "unknown"


def apply_line(rec, o, state):
    hist = state["hist"]
    t = o.get("type")
    if t in ("custom-title", "agent-name"):
        rec["title"] = o.get("customTitle") or o.get("agentName") or rec["title"]
        return
    ts = o.get("timestamp")
    if ts:
        ms = epoch_ms(ts)
        rec["first"] = rec["first"] or ms
        rec["last"] = max(rec["last"], ms)
    rec["cwd"] = o.get("cwd") or rec["cwd"]
    rec["branch"] = o.get("gitBranch") or rec["branch"]
    rec["session"] = o.get("sessionId") or rec["session"]
    rec["agentId"] = o.get("agentId") or rec["agentId"]
    if t == "user":
        msg = o.get("message") or {}
        content = msg.get("content")
        if isinstance(content, list) and any(isinstance(c, dict) and c.get("type") == "tool_result" for c in content):
            rec["stop"] = "tool_result"
        elif not o.get("isMeta"):
            rec["stop"] = "prompt"
        return
    if t != "assistant":
        return
    msg = o.get("message") or {}
    rec["model"] = msg.get("model") or o.get("requestedModel") or rec["model"]
    rec["effort"] = o.get("effort") or rec["effort"]
    for c in msg.get("content") or []:
        if not isinstance(c, dict):
            continue
        if c.get("type") == "tool_use":
            name, inp = c.get("name", ""), c.get("input") or {}
            rec["activity"] = describe(name, inp)
            rec["stop"] = "tool_use"
            if name == "TodoWrite" and isinstance(inp.get("todos"), list):
                todos = inp["todos"]
                rec["todo"] = [sum(1 for x in todos if isinstance(x, dict) and x.get("status") == "completed"), len(todos)]
            elif name == "TaskCreate":
                rec["tasks"][1] += 1
            elif name == "TaskUpdate" and inp.get("status") == "completed":
                rec["tasks"][0] += 1
        elif c.get("type") == "text" and c.get("text"):
            rec["activity"] = "Writing a reply"
        elif c.get("type") == "thinking":
            rec["activity"] = "Thinking…"
    if msg.get("stop_reason"):
        rec["stop"] = msg["stop_reason"]
    mid = msg.get("id") or o.get("requestId")
    usage = msg.get("usage")
    if not usage or not mid:
        return
    vec = usage_vector(rec["model"], usage)
    # One response is written as several lines (one per content block), each carrying the usage so far:
    # count only what grew since the previous line of the same response.
    if mid == rec.get("lastMid") and rec.get("lastVec"):
        delta = [a - b for a, b in zip(vec, rec["lastVec"])]
    elif mid in rec["ids"]:
        return
    else:
        delta = vec
        rec["ids"] = (rec["ids"] + [mid])[-RECENT_IDS:]
        rec["steps"] += 1
    rec["lastMid"], rec["lastVec"] = mid, vec
    if not any(delta):
        return
    _price, matched, exact = price_of(rec["model"], 0)
    if not exact and rec["model"] and delta[0] + delta[1] + delta[2] > 0:
        note = state["pricing"].setdefault(rec["model"], {"as": matched, "tokens": 0, "last": ""})
        note["as"] = matched
        note["tokens"] += delta[0] + delta[1] + delta[2]
        note["last"] = max(note["last"], hour_key(ts)[:10]) if ts else note["last"]
    rec["in"] += delta[0]
    rec["out"] += delta[1]
    rec["cache"] += delta[2]
    rec["usd"] = rec.get("usd", 0.0) + delta[3]
    hour = hour_key(ts)
    fam = model_key(rec["model"])
    repo = repo_of(rec["cwd"])
    for bucket in (hist.setdefault(hour, {}), state["phist"].setdefault(repo, {}).setdefault(hour, {})):
        cur = bucket.get(fam, [0] * 8)
        cur = cur + [0] * (8 - len(cur))
        bucket[fam] = [round(a + b, 6) for a, b in zip(cur, delta)]
    if rec["session"]:
        day_sessions = state["psess"].setdefault(repo, {}).setdefault(hour[:10], [])
        if rec["session"] not in day_sessions:
            day_sessions.append(rec["session"])


def read_new(path, rec, state):
    size = os.path.getsize(path)
    if size < rec["offset"]:
        rec.update(new_record(path))
    if size == rec["offset"]:
        return
    with open(path, "rb") as f:
        f.seek(rec["offset"])
        data = f.read()
    end = data.rfind(b"\n")
    if end < 0:
        return
    rec["offset"] += end + 1
    for raw in data[: end + 1].split(b"\n"):
        if not raw or (b'"assistant"' not in raw and b'"user"' not in raw and b"-title" not in raw and b"agent-name" not in raw):
            continue
        try:
            apply_line(rec, json.loads(raw), state)
        except (ValueError, TypeError, KeyError):
            continue


def meta_for(path):
    meta_path = path[: -len(".jsonl")] + ".meta.json"
    try:
        with open(meta_path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def session_title(path, rec_by_path):
    parts = path.split(os.sep)
    if "subagents" in parts:
        i = parts.index("subagents")
        main_path = os.sep.join(parts[: i]) + ".jsonl"
        main = rec_by_path.get(main_path)
        return main.get("title") if main else None
    return None


def status_of(rec, now_ms, is_sub):
    age = (now_ms - rec["last"]) / 1000
    if is_sub and (age > 90 or rec["activity"].startswith("SubagentHandback")):
        return "done"
    if rec["stop"] in ("end_turn", "stop_sequence", "max_tokens", "refusal"):
        return "done" if is_sub else "idle"
    if rec["stop"] == "tool_use" and age > 20:
        return "waiting"
    if age > 300:
        return "idle"
    return "running"


def project_history(phist, psess):
    """Per repo: today's hours as recorded, every earlier day folded into one bucket at noon, plus the session ids active each day."""
    today = datetime.now().strftime("%Y-%m-%d")
    out = {}
    for repo, hours in phist.items():
        hist = {}
        for key, bucket in hours.items():
            slot = key if key[:10] == today else key[:10] + "T12"
            into = hist.setdefault(slot, {})
            for fam, vec in bucket.items():
                cur = into.get(fam, [0] * len(vec))
                into[fam] = [round(a + b, 4) for a, b in zip(cur + [0] * (len(vec) - len(cur)), vec)]
        out[repo] = {"hist": hist, "sessions": psess.get(repo, {})}
    return out


def main():
    projects, state_path, exclude, live_minutes = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    with open(state_path + ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with open(state_path) as f:
                state = json.load(f)
        except (OSError, ValueError):
            state = {}
        legacy = None
        if state.get("v") != STATE_VERSION:
            legacy = state if state.get("v") in (3, 4) else None
            state = {"v": STATE_VERSION, "files": {}, "hist": {}, "phist": {}, "psess": {}, "pricing": {}}
        files, hist = state["files"], state["hist"]

        now = time.time()
        live = []
        for root, _dirs, names in os.walk(projects):
            for name in names:
                if not name.endswith(".jsonl"):
                    continue
                path = os.path.join(root, name)
                try:
                    mtime = os.path.getmtime(path)
                except OSError:
                    continue
                rec = files.get(path)
                if rec is None:
                    rec = files[path] = new_record(path)
                read_new(path, rec, state)
                if now - mtime <= live_minutes * 60:
                    live.append(path)

        merge_legacy(state, legacy)
        cutoff = (datetime.now() - timedelta(days=HISTORY_DAYS)).strftime("%Y-%m-%d")
        detail = (datetime.now() - timedelta(days=DETAIL_DAYS)).strftime("%Y-%m-%d")
        state["hist"] = hist = fold_days({k: v for k, v in state["hist"].items() if k[:10] >= cutoff}, detail)
        state["phist"] = {r: fold_days({k: v for k, v in h.items() if k[:10] >= cutoff}, detail) for r, h in state["phist"].items()}
        state["psess"] = {r: {d: v for d, v in h.items() if d >= cutoff} for r, h in state["psess"].items()}
        state["pricing"] = {k: v for k, v in state["pricing"].items() if v["last"] >= cutoff and not price_of(k, 0)[2]}
        state["files"] = {p: r for p, r in files.items() if os.path.exists(p)}
        tmp = state_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state, f, separators=(",", ":"))
        os.replace(tmp, state_path)

    now_ms = int(now * 1000)
    self_usd = sum(r.get("usd", 0.0) for r in files.values() if r["session"] == exclude)
    agents = []
    for path in live:
        rec = files[path]
        if rec["session"] == exclude or not rec["last"]:
            continue
        is_sub = "subagents" in path.split(os.sep)
        status = status_of(rec, now_ms, is_sub)
        if is_sub and status == "done" and now_ms - rec["last"] > 120_000:
            continue
        meta = meta_for(path) if is_sub else {}
        project = repo_of(rec["cwd"])
        title = rec["title"] if not is_sub else (meta.get("description") or "Subagent")
        todo = rec["todo"] or ([min(rec["tasks"]), rec["tasks"][1]] if rec["tasks"][1] else None)
        agents.append({
            "id": f"{rec['session']}:{rec['agentId'] or 'main'}",
            "name": title or (rec["branch"] or project),
            "type": meta.get("agentType", "subagent") if is_sub else "session",
            "session": session_title(path, files) if is_sub else None,
            "project": project + (f" · {rec['branch']}" if rec["branch"] and rec["branch"] != "HEAD" else ""),
            "repo": project,
            "status": status,
            "model": rec["model"], "effort": rec["effort"],
            "tokensIn": rec["in"], "tokensOut": rec["out"], "cacheRead": rec["cache"],
            "costUsd": round(rec.get("usd", 0.0), 4),
            "progress": {"done": todo[0], "total": todo[1]} if todo else None,
            "steps": rec["steps"], "activity": rec["activity"] or "Starting",
            "startedAt": rec["first"], "lastAt": rec["last"],
        })
    print(json.dumps({
        "agents": agents,
        "hist": hist,
        "projects": project_history(state["phist"], state["psess"]),
        "selfUsd": round(self_usd, 4),
        "pricing": [{"model": k, "as": v["as"], "tokens": v["tokens"]} for k, v in state["pricing"].items()],
        "at": now_ms,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()

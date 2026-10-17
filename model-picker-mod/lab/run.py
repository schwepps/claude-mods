#!/usr/bin/env python3
"""Live battle test for model-router: real headless Claude Code sessions, real models.

Each scenario runs as one session in its own throwaway git repo, its turns fed
through stdin so the router keeps its session state between them. The models
that actually answered are read from the stream and checked against the
scenario's expectations. This spends real tokens.

  python3 lab/run.py                  # every scenario
  python3 lab/run.py -k pin -k shadow # scenarios whose name contains a filter
  python3 lab/run.py --workers 1      # one session at a time
"""

import argparse
import concurrent.futures
import datetime
import json
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_FILES = [".claude-plugin/plugin.json", "hooks", "types"]
TIERS = ["haiku", "sonnet", "opus", "fable"]
TURN_TIMEOUT_S = 300

SANDBOX_FILES = {
    "calc.py": "def add(a, b):\n    return a + b\n",
    "test_calc.py": "from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n",
    "README.md": "# calc\n\nA tiny calculator used to battle-test the model router.\n",
}


def tier_of(model):
    model = (model or "").lower()
    if "mythos" in model:
        return "fable"
    return next((t for t in TIERS if t in model), "other")


def copy_plugin(dest):
    """The lab loads a snapshot, so editing the mod mid-run cannot change a running scenario."""
    for rel in PLUGIN_FILES:
        src, dst = ROOT / rel, dest / rel
        if src.is_dir():
            shutil.copytree(src, dst)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    return dest


def make_sandbox(dest):
    dest.mkdir(parents=True)
    for name, text in SANDBOX_FILES.items():
        (dest / name).write_text(text)
    git = ["git", "-c", "user.email=lab@localhost", "-c", "user.name=lab"]
    subprocess.run(["git", "init", "-q"], cwd=dest, check=True)
    subprocess.run(["git", "add", "."], cwd=dest, check=True)
    subprocess.run([*git, "commit", "-qm", "init"], cwd=dest, check=True)
    return dest


def run_session(scenario, plugin_dir, sandbox, home):
    """Sends each turn only after the previous one's result, as a person at the prompt would."""
    cmd = [
        "claude", "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--model", home,
        "--plugin-dir", str(plugin_dir),
    ]
    if scenario.get("allowedTools"):
        cmd += ["--allowedTools", scenario["allowedTools"]]
    if scenario.get("options"):
        settings = {"pluginConfigs": {"model-router@inline": {"options": scenario["options"]}}}
        cmd += ["--settings", json.dumps(settings)]

    prompts = [t["prompt"] for t in scenario["turns"]]
    stderr_file = sandbox / ".lab-stderr"
    lines = []
    with open(stderr_file, "w") as err:
        proc = subprocess.Popen(cmd, cwd=sandbox, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err, text=True)
        watchdog = threading.Timer(TURN_TIMEOUT_S * len(prompts), proc.kill)
        watchdog.start()

        def send(prompt):
            proc.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": prompt}}) + "\n")
            proc.stdin.flush()

        send(prompts[0])
        sent = 1
        for line in proc.stdout:
            lines.append(line)
            if '"type":"result"' in line.replace(" ", ""):
                if sent < len(prompts):
                    send(prompts[sent])
                    sent += 1
                else:
                    proc.stdin.close()
        proc.wait()
        watchdog.cancel()
    return parse_stream("".join(lines)), stderr_file.read_text()


def parse_stream(stdout):
    """Splits the event stream into turns: each `result` event closes one."""
    turns, current = [], {"main": [], "sub": [], "status": [], "notices": []}
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind, subtype = event.get("type"), event.get("subtype")
        message = event.get("message") if isinstance(event.get("message"), dict) else {}
        if kind == "assistant":
            bucket = "sub" if event.get("parent_tool_use_id") else "main"
            current[bucket].append(tier_of(message.get("model")))
        elif kind == "system" and subtype == "ui_status":
            text = event.get("text") or event.get("status") or ""
            if text.startswith("⇢"):
                current["status"].append(text)
        elif kind == "system" and subtype == "informational":
            current["notices"].append(event.get("content", ""))
        elif kind == "result":
            current["answer"] = str(event.get("result") or "")
            current["cost"] = event.get("total_cost_usd") or 0
            current["is_error"] = event.get("is_error")
            turns.append(current)
            current = {"main": [], "sub": [], "status": [], "notices": []}
    return turns


def collapse(tiers):
    out = []
    for t in tiers:
        if not out or out[-1] != t:
            out.append(t)
    return out


def check(expect, observed):
    problems = []
    if observed is None:
        return ["no result for this turn (session ended early)"]
    main, sub = observed["main"], observed["sub"]
    dropped = any("dropped" in n for n in observed["notices"]) or observed["answer"].startswith("Prompt dropped")
    if expect.get("dropped") and not dropped:
        problems.append("prompt was not dropped")
    if "main" in expect:
        if not main:
            problems.append("no main-loop response")
        elif set(main) - set(expect["main"]):
            problems.append(f"main ran on {collapse(main)}, expected only {expect['main']}")
    if "mainStartsWith" in expect and (not main or main[0] != expect["mainStartsWith"]):
        problems.append(f"main started on {main[:1]}, expected {expect['mainStartsWith']}")
    if "mainEndsWith" in expect and (not main or main[-1] != expect["mainEndsWith"]):
        problems.append(f"main ended on {main[-1:]}, expected {expect['mainEndsWith']}")
    if "sub" in expect:
        if not sub:
            problems.append("no subagent ran")
        elif set(sub) - set(expect["sub"]):
            problems.append(f"subagent ran on {collapse(sub)}, expected only {expect['sub']}")
    if "status" in expect and not any(expect["status"] in s for s in observed["status"]):
        problems.append(f"status never mentioned {expect['status']!r}: {observed['status'][-1:]}")
    if "answerExcludes" in expect and expect["answerExcludes"] in observed["answer"]:
        problems.append(f"answer contains {expect['answerExcludes']!r}")
    if "answerIncludes" in expect and expect["answerIncludes"] not in observed["answer"]:
        problems.append(f"answer lacks {expect['answerIncludes']!r}")
    return problems


def run_scenario(scenario, plugin_dir, work, home, index):
    sandbox = make_sandbox(work / f"sandbox-{index:02d}")
    turns, stderr = run_session(scenario, plugin_dir, sandbox, home)
    rows = []
    for i, turn in enumerate(scenario["turns"]):
        observed = turns[i] if i < len(turns) else None
        problems = check(turn.get("expect", {}), observed)
        rows.append({"turn": turn, "observed": observed, "problems": problems})
    return {"scenario": scenario, "rows": rows, "stderr": stderr.strip()[-600:]}


def report(results, path, store_log):
    passed = sum(1 for r in results for row in r["rows"] if not row["problems"])
    total = sum(len(r["rows"]) for r in results)
    cost = sum((row["observed"] or {}).get("cost", 0) for r in results for row in r["rows"])
    lines = [
        f"# model-router live lab — {datetime.datetime.now():%Y-%m-%d %H:%M}",
        "",
        f"**{passed}/{total} turns passed** · Claude Code's reported cost ${cost:.2f} "
        "(it prices Haiku 5.5 as an unknown model, so this overstates Haiku turns)",
        "",
        "| | Scenario | Turn | Main loop | Subagents | Router status | Problems |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in results:
        for i, row in enumerate(r["rows"]):
            o = row["observed"] or {"main": [], "sub": [], "status": []}
            mark = "✅" if not row["problems"] else "❌"
            prompt = row["turn"]["prompt"].replace("|", "\\|")[:60]
            status = (o["status"][-1] if o["status"] else "").replace("|", "\\|")
            lines.append(
                f"| {mark} | {r['scenario']['name'] if i == 0 else ''} | {prompt} | "
                f"{' → '.join(collapse(o['main'])) or '-'} | {' → '.join(collapse(o['sub'])) or '-'} | "
                f"{status} | {'; '.join(row['problems'])} |"
            )
    failing = [r for r in results if any(row["problems"] for row in r["rows"]) and r["stderr"]]
    if failing:
        lines += ["", "## stderr of failing scenarios", ""]
        for r in failing:
            lines += [f"**{r['scenario']['name']}**", "```", r["stderr"], "```"]
    if store_log:
        lines += ["", "## Router decision log", "", "```"]
        for d in store_log:
            when = datetime.datetime.fromtimestamp(d["at"] / 1000).strftime("%H:%M:%S")
            shadow = " (shadow)" if not d.get("isApplied", True) else ""
            lines.append(f"{when} {d['scope']:<8} {d['from']} → {d['to']}{shadow}  {d['reason']}  “{d.get('prompt', '')}”")
        lines.append("```")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n")
    return passed, total


STORE = Path.home() / ".claude" / "plugins" / "store"


def read_store_log(since_ms):
    """The router's own decision log since the run started (every --plugin-dir copy shares one store)."""
    entries = []
    for f in STORE.glob("model-router_inline-*.json"):
        try:
            entries += json.loads(f.read_text()).get("log", [])
        except (OSError, json.JSONDecodeError):
            continue
    return sorted((e for e in entries if e["at"] >= since_ms), key=lambda e: e["at"])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-k", action="append", default=[], help="run scenarios whose name contains this")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--keep", action="store_true", help="keep the sandboxes for inspection")
    args = parser.parse_args()

    spec = json.loads((ROOT / "lab" / "scenarios.json").read_text())
    scenarios = [s for s in spec["scenarios"] if not args.k or any(k in s["name"] for k in args.k)]
    if not scenarios:
        sys.exit("no scenario matches")

    started_ms = datetime.datetime.now().timestamp() * 1000
    work = Path(tempfile.mkdtemp(prefix="model-router-lab-"))
    plugin_dir = copy_plugin(work / "plugin")
    print(f"{len(scenarios)} scenarios, {sum(len(s['turns']) for s in scenarios)} turns, sandboxes in {work}")

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(run_scenario, s, plugin_dir, work, spec["home"], i) for i, s in enumerate(scenarios)]
        results = []
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            ok = all(not row["problems"] for row in result["rows"])
            print(f"  {'PASS' if ok else 'FAIL'}  {result['scenario']['name']}")
            results.append(result)
    results.sort(key=lambda r: scenarios.index(r["scenario"]))

    out = ROOT / "lab" / "reports" / f"{datetime.datetime.now():%Y%m%d-%H%M%S}.md"
    passed, total = report(results, out, read_store_log(started_ms))
    print(f"{passed}/{total} turns passed — report: {out}")
    if not args.keep:
        shutil.rmtree(work, ignore_errors=True)
    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()

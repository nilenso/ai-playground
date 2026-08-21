#!/usr/bin/env python3
"""Live dashboard for the three-arm autoresearch experiment.

Two views. `/` is the overview: what every arm is doing right now and the
constraints they share. `/arm/<name>` is one arm in depth: its live terminal
tail, its commits, and the full diff of everything it has changed since its
base commit.

Everything is re-read on each request. Only the OpenRouter balance is cached,
because it costs a network round trip and moves slowly.

Run:  python3 dashboard.py [--port 8765]
Then: http://localhost:8765
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import unquote

import trajectory

HOME = Path.home()
SHARED = HOME / "nilenso/ai-playground/autoresearch"
AIPLAY = HOME / "nilenso/ai-playground"
ARM_C_ROOT = HOME / "nilenso/ar-c-autoresearch"
ARM_C_TREE = ARM_C_ROOT / "autoresearch"
ARM_A_REPO = HOME / "workspace/ar-a/botmap"
CACHE_DIR = HOME / ".cache/botmap"

REFRESH_SECONDS = 15
MAX_DIFF_BYTES = 400_000

# Each arm: where its code lives, what commit it started from, and which paths
# are actually its work (the rest of the repo is noise we must not render).
ARMS: dict[str, dict] = {
    "arm-a": {
        "title": "Arm A — loop as a skill",
        "thesis": "Can an instructed agent match GEPA's coded scaffolding?",
        "repo": ARM_A_REPO,
        "base": "3009509",
        "paths": ["botmap", ".claude", "AUTORESEARCH-REPORT.md", "evals"],
        "baseline_root": None,
        # Arm A edits the tool in place, so its lever tree IS its repo.
        "lever_tree": ARM_A_REPO,
        "lever_files": ["botmap/data/skill.md"],
        "lever_base": "3009509",
        "run_root": None,
        # Arm A's loop puts each competing candidate on its own cand/* branch.
        "cand_base": "arm-a-base",
    },
    "arm-b": {
        "title": "Arm B — prompt lever",
        "thesis": "Does optimising skill.md alone improve the tool?",
        "repo": AIPLAY,
        "base": "f990ef7",
        "paths": ["autoresearch"],
        "baseline_root": SHARED,
        # GEPA never edits BOTMAP_REPO. Candidates are written into a pool
        # worktree per evaluation and reset between them, so this is the only
        # place the lever is ever visible while a run is in flight.
        "lever_tree": HOME / "workspace/ar-b/botmap-oa-3009509-0",
        "lever_files": ["botmap/data/skill.md"],
        "lever_base": "3009509",
        "run_root": SHARED,
        "tool_repo": HOME / "workspace/ar-b/botmap",
        "tool_base": "3009509",
    },
    "arm-c": {
        "title": "Arm C — repo context + struggle scorer",
        "thesis": "Does seeing the whole repo, and scoring agent struggle, help?",
        "repo": ARM_C_ROOT,
        "base": "f990ef7",
        "paths": ["autoresearch"],
        "baseline_root": ARM_C_TREE,
        "lever_tree": HOME / "workspace/ar-c/botmap-oa-3009509-0",
        "lever_files": ["botmap/cli.py", "botmap/filters.py",
                        "botmap/geocoding.py", "botmap/introspection.py"],
        "lever_base": "3009509",
        "run_root": ARM_C_TREE,
        "waits_for": "arm-b",
        "tool_repo": HOME / "workspace/ar-c/botmap",
        "tool_base": "3009509",
    },
}

ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")

# GEPA writes one candidate into the pool worktree, evaluates it, then resets
# the tree before the next. Each version therefore exists for seconds only. A
# dashboard that reads on request would show an empty diff almost every time,
# so we sample continuously and keep every distinct version we see.
HISTORY = Path(__file__).resolve().parent / "lever-history"
SAMPLE_SECONDS = 4


def _base_text(tree: Path, base: str, rel: str, _c: dict = {}) -> str:
    k = (str(tree), base, rel)
    if k not in _c:
        _c[k] = git(tree, "show", f"{base}:{rel}")
    return _c[k]


def sample_levers() -> None:
    """One pass: snapshot any lever file whose contents we have not seen."""
    import hashlib
    for key, arm in ARMS.items():
        tree = arm.get("lever_tree")
        if not tree or not Path(tree).exists():
            continue
        for rel in arm["lever_files"]:
            f = Path(tree) / rel
            if not f.is_file():
                continue
            try:
                text = f.read_text(errors="replace")
            except Exception:
                continue
            base_txt = _base_text(Path(tree), arm.get("lever_base", arm["base"]), rel)
            if not base_txt or text == base_txt:
                continue  # unchanged from base is not a candidate
            digest = hashlib.sha256(text.encode()).hexdigest()[:12]
            out_dir = HISTORY / key / rel.replace("/", "__")
            out_dir.mkdir(parents=True, exist_ok=True)
            if any(p.name.endswith(f"-{digest}.txt") for p in out_dir.iterdir()):
                continue  # already captured this exact version
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            (out_dir / f"{stamp}-{digest}.txt").write_text(text)


def sampler_loop() -> None:
    while True:
        try:
            sample_levers()
        except Exception:
            pass
        time.sleep(SAMPLE_SECONDS)


def lever_history(arm_key: str, arm: dict) -> list[tuple[str, str, str]]:
    """Captured candidates, newest first: (when, file, diff-vs-base)."""
    import difflib
    root = HISTORY / arm_key
    if not root.exists():
        return []
    rows = []
    for sub in sorted(root.iterdir()):
        rel = sub.name.replace("__", "/")
        for snap in sorted(sub.iterdir(), reverse=True):
            try:
                new = snap.read_text(errors="replace")
            except Exception:
                continue
            old = _base_text(Path(arm["lever_tree"]),
                             arm.get("lever_base", arm["base"]), rel)
            diff = "\n".join(difflib.unified_diff(
                old.splitlines(), new.splitlines(),
                fromfile=f"{rel} @{arm.get('lever_base', arm['base'])}",
                tofile=f"{rel} @{snap.name.split('-')[1][:6]}", lineterm=""))
            when = snap.name[:15].replace("-", " ")
            rows.append((when, rel, diff))
    return rows


def run(cmd: list[str], timeout: float = 15.0) -> str:
    """Best-effort shell out. A dashboard must never die on a flaky probe."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout
    except Exception:
        return ""


def git(repo: Path, *args: str) -> str:
    return run(["git", "-C", str(repo), *args])


def herdr_agents() -> dict[str, dict]:
    try:
        agents = json.loads(run(["herdr", "agent", "list"]))["result"]["agents"]
    except Exception:
        return {}
    by_name = {
        (a.get("name") or "orchestrator"): {
            "status": a.get("agent_status", "unknown"),
            "pane": a.get("pane_id", ""),
        }
        for a in agents
    }
    # The Claude arms were replaced by Pi arms after the subscription ran out.
    # Keep the dashboard's stable arm-a/b/c keys live by preferring pi-arm-* when
    # those replacement sessions exist.
    for arm in ("a", "b", "c"):
        pi_name = f"pi-arm-{arm}"
        arm_name = f"arm-{arm}"
        if pi_name in by_name:
            by_name[arm_name] = by_name[pi_name]
    return by_name


_STATUS_LINE = re.compile(r"\|\s*([\d.]+)k tok\s*\|.*?\|\s*\$([\d.]+)")


def pane_text(name: str, lines: int = 6) -> str:
    """Visible viewport, not scrollback — scrollback is refused while working."""
    return ANSI.sub("", run(["herdr", "agent", "read", name,
                             "--source", "visible", "--lines", str(lines)]))


def pane_vitals(name: str) -> dict:
    m = _STATUS_LINE.search(pane_text(name, 6))
    return {"tokens": f"{m.group(1)}k", "spend": f"${m.group(2)}"} if m else {}


def cached_release() -> tuple[str, list[str]]:
    if not CACHE_DIR.exists():
        return ("no cache", [])
    rel = sorted(p.name.removeprefix("divisions-index-").removesuffix(".parquet")
                 for p in CACHE_DIR.glob("divisions-index-*.parquet"))
    return (rel[-1] if rel else "none", rel)


def baseline_state(root: Path | None) -> dict:
    """What the yardstick is doing, not merely whether the file is there.

    baseline.measure() writes the canonical file only when all 30 questions
    finish, so "the file is absent" covers two opposite situations: nothing is
    happening, or a measurement is most of the way through. Reporting both as
    MISSING is how a healthy run looks broken.
    """
    if root is None:
        return {}
    d = root / "experiments" / "baselines"
    if not d.exists():
        return {"state": "no directory", "detail": "", "history": []}

    history = [p.name for p in sorted(d.glob("*.json"))
               if p.name != "3009509.json"]

    canonical = d / "3009509.json"
    if canonical.exists():
        try:
            rec = json.loads(canonical.read_text())
            skipped = len(rec.get("skipped") or [])
            return {
                "state": "VALID" if skipped == 0 else f"INCOMPLETE ({skipped} skipped)",
                "detail": f"release {rec.get('release', 'unrecorded')}",
                "history": history,
            }
        except Exception:
            return {"state": "unreadable", "detail": "", "history": history}

    # No canonical file. Is one being measured right now?
    total = len(trajectory.question_names(root)) or 30
    runs = root / "experiments" / "runs"
    best = None
    if runs.exists():
        for run_dir in runs.glob("baseline*"):
            att = run_dir / "attempts"
            if not att.is_dir():
                continue
            done = len({p.name.rsplit("__r", 1)[0] for p in att.iterdir()
                        if p.is_dir()})
            if best is None or done > best[1]:
                best = (run_dir.name, done)
    if best:
        name, done = best
        return {"state": f"MEASURING {done}/{total}",
                "detail": f"in flight — {name}",
                "progress": (done, total), "history": history}

    return {"state": "not yet measured",
            "detail": "no run in flight; nothing to load",
            "history": history}


def openrouter_balance(_c: dict = {}) -> str:
    if _c.get("at", 0) > time.time() - 60:
        return _c["value"]
    key = os.environ.get("OPENROUTER_API_KEY")
    env = SHARED / ".env"
    if not key and env.exists():
        for line in env.read_text().splitlines():
            if line.strip().startswith("OPENROUTER_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
    value = "unknown"
    if key:
        import urllib.request
        try:
            req = urllib.request.Request(
                "https://openrouter.ai/api/v1/credits",
                headers={"Authorization": f"Bearer {key}"})
            with urllib.request.urlopen(req, timeout=10) as r:
                d = json.load(r)["data"]
                value = f"${d['total_credits'] - d['total_usage']:.2f}"
        except Exception:
            value = "unreachable"
    _c.update(at=time.time(), value=value)
    return value


def arm_a_progress() -> dict[str, int]:
    runs = ARM_A_REPO / "evals" / "runs"
    if not runs.exists():
        return {}
    return {d.name: len(list(d.glob("**/record.json")))
            for d in sorted(runs.iterdir()) if d.is_dir()}


# ---------------------------------------------------------------- diffs

def commits(arm: dict) -> list[tuple[str, str]]:
    out = git(arm["repo"], "log", "--oneline", f"{arm['base']}..HEAD",
              "--", *arm["paths"])
    rows = []
    for line in out.splitlines():
        sha, _, msg = line.partition(" ")
        rows.append((sha, msg))
    return rows


def diff_text(arm: dict) -> str:
    """Everything changed since the base: committed and uncommitted alike."""
    return git(arm["repo"], "diff", arm["base"], "--", *arm["paths"])


# Editor and tooling droppings that are untracked but are nobody's work.
# Without this the arm pages fill with .idea/ XML instead of the actual change.
NOISE = re.compile(r"(^|/)(\.DS_Store|\.idea|\.vscode|node_modules|__pycache__"
                   r"|\.pytest_cache|\.venv|\.claude/worktrees|docs/wiki)(/|$)"
                   r"|\.min\.js$")
INLINE_LIMIT = 40_000  # bigger than this and we link rather than render


def untracked(arm: dict) -> list[str]:
    out = git(arm["repo"], "ls-files", "--others", "--exclude-standard",
              "--", *arm["paths"])
    return [f for f in out.splitlines() if f.strip() and not NOISE.search(f)]


def diffstat(arm: dict) -> tuple[int, int, int]:
    """Files changed, insertions, deletions — cheap enough for the overview."""
    out = git(arm["repo"], "diff", "--numstat", arm["base"], "--", *arm["paths"])
    files = adds = dels = 0
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            files += 1
            if parts[0].isdigit():
                adds += int(parts[0])
            if parts[1].isdigit():
                dels += int(parts[1])
    return files, adds, dels


def split_by_file(diff: str) -> list[tuple[str, str]]:
    """Break a unified diff into (path, hunk-text) so each file can collapse."""
    if not diff.strip():
        return []
    chunks, name, buf = [], None, []
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            if name:
                chunks.append((name, "\n".join(buf)))
            m = re.search(r" b/(.+)$", line)
            name, buf = (m.group(1) if m else line), []
        else:
            buf.append(line)
    if name:
        chunks.append((name, "\n".join(buf)))
    return chunks


def render_hunk(text: str) -> str:
    rows = []
    for line in text.splitlines():
        cls = ""
        if line.startswith("+++") or line.startswith("---"):
            cls = "meta"
        elif line.startswith("@@"):
            cls = "hunk"
        elif line.startswith("+"):
            cls = "add"
        elif line.startswith("-"):
            cls = "del"
        elif line.startswith(("index ", "new file", "deleted file", "similarity")):
            cls = "meta"
        rows.append(f'<div class="l {cls}">{html.escape(line) or "&nbsp;"}</div>')
    return "".join(rows)


def lever_live(arm: dict) -> tuple[str, str]:
    """The candidate currently sitting in the pool worktree, if any.

    Returns (diff, note). GEPA writes one candidate at a time here and resets
    between them, so an empty diff is normal and means "unchanged files are
    being evaluated right now" — not "nothing has happened".
    """
    tree = arm.get("lever_tree")
    if not tree or not Path(tree).exists():
        return ("", "Pool worktree does not exist yet — no run has started.")
    # Diff against the BASE, not HEAD: Arm A commits its candidates, so a
    # HEAD-relative diff would show nothing the moment it commits one.
    base = arm.get("lever_base", arm["base"])
    if not git(Path(tree), "cat-file", "-t", base).strip():
        return ("", f"Cannot diff: {base} is not a commit in {tree}. "
                    "Fix the dashboard config rather than trusting this.")
    d = git(Path(tree), "diff", base, "--", *arm["lever_files"])
    if d.strip():
        return (d, "")
    return ("", "Lever files are unmodified right now. During a run this means "
                "the baseline or an unchanged candidate is being evaluated; "
                "GEPA resets the tree between candidates.")


def lever_best(arm: dict) -> list[tuple[str, str]]:
    """Best-so-far candidates that finished runs wrote to <run>/best/."""
    root = arm.get("run_root")
    tree = arm.get("lever_tree")
    if not root or not tree:
        return []
    runs = Path(root) / "experiments" / "runs"
    if not runs.exists():
        return []
    import difflib
    out = []
    for run_dir in sorted(runs.iterdir(), key=lambda p: p.stat().st_mtime,
                          reverse=True)[:3]:
        best = run_dir / "best"
        if not best.is_dir():
            continue
        for f in sorted(best.iterdir()):
            if not f.is_file():
                continue
            rel = next((L for L in arm["lever_files"]
                        if Path(L).name == f.name), None)
            if rel is None:
                continue
            original = git(Path(tree), "show",
                           f"{arm.get('lever_base', arm['base'])}:{rel}")
            try:
                new = f.read_text(errors="replace")
            except Exception:
                continue
            diff = "\n".join(difflib.unified_diff(
                original.splitlines(), new.splitlines(),
                fromfile=f"{rel} @{arm.get('lever_base', arm['base'])}",
                tofile=f"{rel} (best)",
                lineterm=""))
            if diff.strip():
                out.append((f"{run_dir.name} → {rel}", diff))
    return out


def candidate_branches(arm: dict) -> list[tuple[str, str, str]]:
    """Competing candidates, one per branch. Returns (branch, subject, diff).

    Only Arm A works this way — the GEPA arms write candidates into the pool
    worktree instead, which lever_live() covers.
    """
    base = arm.get("cand_base")
    if not base:
        return []
    repo = Path(arm["lever_tree"])
    names = [b.strip().lstrip("* ").strip()
             for b in git(repo, "branch", "--list", "cand/*").splitlines()
             if b.strip()]
    out = []
    for b in names:
        subject = git(repo, "log", "--oneline", f"{base}..{b}").strip()
        diff = git(repo, "diff", f"{base}..{b}")
        if diff.strip():
            out.append((b, subject, diff))
    return out


TARGET_REPO = HOME / "workspace/botmap"   # your real checkout, the adoption target


def adoptable() -> dict[str, list[dict]]:
    """Every change that could actually be applied to botmap, in one place.

    Three sources, deliberately kept apart because they carry different
    weight: candidates an arm has built and can test, patches a finished run
    produced, and known bugs nobody has acted on yet.
    """
    live, from_runs, known = [], [], []

    for key, arm in ARMS.items():
        for branch, subject, diff in candidate_branches(arm):
            files = [n for n, _ in split_by_file(diff)]
            live.append({
                "who": key, "title": subject or branch, "files": files,
                "diff": diff,
                "apply": f"git -C {TARGET_REPO} fetch {arm['lever_tree']} "
                         f"{branch} && git -C {TARGET_REPO} cherry-pick FETCH_HEAD",
            })
        hist = lever_history(key, arm)
    if hist:
        body += (f"<p class='thesis'><b>{len(hist)} candidate version(s) "
                 f"captured</b> by the sampler while runs were in flight. "
                 f"GEPA resets the tree between candidates, so these would "
                 f"otherwise have been unobservable.</p>")
        for when, rel, diff in hist:
            n_add = sum(1 for l in diff.splitlines()
                        if l.startswith("+") and not l.startswith("+++"))
            n_del = sum(1 for l in diff.splitlines()
                        if l.startswith("-") and not l.startswith("---"))
            body += (f'<details class="f"><summary><span>{esc(when)} · '
                     f'{esc(rel)}</span><span class="pill">'
                     f'<span class="ok">+{n_add}</span> '
                     f'<span class="bad">-{n_del}</span></span></summary>'
                     f'<div class="code">{render_hunk(diff)}</div></details>')

    for label, diff in lever_best(arm):
            live.append({"who": key, "title": f"best so far — {label}",
                         "files": [label], "diff": diff, "apply": ""})

    for root in (SHARED, ARM_C_TREE):
        runs = Path(root) / "experiments" / "runs"
        if not runs.exists():
            continue
        for run_dir in sorted(runs.iterdir(), key=lambda x: x.stat().st_mtime,
                              reverse=True):
            patch = run_dir / "change.patch"
            if not patch.is_file() or patch.stat().st_size == 0:
                continue
            invalid = (run_dir / "INVALID.md").is_file()
            try:
                diff = patch.read_text(errors="replace")
            except Exception:
                continue
            from_runs.append({
                "who": run_dir.name, "invalid": invalid,
                "files": [n for n, _ in split_by_file(diff)],
                "diff": diff if len(diff) < MAX_DIFF_BYTES else "",
                "apply": f"git -C {TARGET_REPO} apply {patch}",
            })

    pj = SHARED / "experiments" / "proposals.json"
    if pj.is_file():
        try:
            for item in json.loads(pj.read_text()):
                known.append({
                    "title": item.get("title", "(untitled)"),
                    "target": item.get("target", ""),
                    "evidence": (item.get("evidence") or "")[:900],
                })
        except Exception:
            pass
    return {"live": live, "runs": from_runs, "known": known}


def esc(x) -> str:
    return html.escape(str(x))


# ---------------------------------------------------------------- chrome

def nav(active: str) -> str:
    items = [("overview", "/", "Overview")]
    items += [(k, f"/arm/{k}", ARMS[k]["title"].split(" — ")[0]) for k in ARMS]
    items += [("tree", "/tree", "Trajectories"),
              ("proposals", "/proposals", "Proposals")]
    return "".join(
        f'<a class="tab{" on" if k == active else ""}" href="{href}">{esc(label)}</a>'
        for k, href, label in items)


STYLE = """
:root{--bg:#f7f7f8;--panel:#fff;--ink:#16161a;--muted:#6b6b76;--line:#e4e4e9;
--ok:#0a7f5f;--warn:#b25000;--bad:#b3261e;--work:#1a56db;--idle:#6b6b76;
--addbg:#e6f5ec;--addfg:#0a5c3f;--delbg:#fdeaea;--delfg:#8f1d16;--hunkbg:#eef1f6}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
--bg:#131316;--panel:#1c1c21;--ink:#ececf1;--muted:#9a9aa6;--line:#2c2c34;
--ok:#3ddc9a;--warn:#ffab5e;--bad:#ff6b60;--work:#7aa2ff;--idle:#9a9aa6;
--addbg:#102a1e;--addfg:#7ee2b0;--delbg:#331a19;--delfg:#ff9c93;--hunkbg:#22222a}}
:root[data-theme="dark"]{--bg:#131316;--panel:#1c1c21;--ink:#ececf1;--muted:#9a9aa6;
--line:#2c2c34;--ok:#3ddc9a;--warn:#ffab5e;--bad:#ff6b60;--work:#7aa2ff;--idle:#9a9aa6;
--addbg:#102a1e;--addfg:#7ee2b0;--delbg:#331a19;--delfg:#ff9c93;--hunkbg:#22222a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);padding:20px 24px 40px;
font:15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
h1{font-size:19px;margin:0 0 2px}
.sub{color:var(--muted);font-size:13px;margin-bottom:14px}
.tabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:18px;border-bottom:1px solid var(--line)}
.tab{padding:7px 13px;font-size:13px;text-decoration:none;color:var(--muted);
border:1px solid transparent;border-bottom:none;border-radius:7px 7px 0 0}
.tab:hover{color:var(--ink)}
.tab.on{background:var(--panel);border-color:var(--line);color:var(--ink);font-weight:600}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));margin-bottom:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card header{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.card h2{font-size:14px;margin:0;flex:1}
.status{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.dot{width:9px;height:9px;border-radius:50%;background:var(--idle);flex:none}
.working .dot{background:var(--work);animation:pulse 1.6s ease-in-out infinite}
.working .status{color:var(--work)}
.blocked .dot,.gone .dot{background:var(--bad)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.thesis{color:var(--muted);font-size:12.5px;margin:0 0 10px}
.kv{display:flex;justify-content:space-between;gap:10px;font-size:13px;
padding:3px 0;border-top:1px solid var(--line)}
.kv span{color:var(--muted)} .kv i{color:var(--muted);font-size:12px;font-style:normal}
.work{color:var(--work)}\n.ok{color:var(--ok)} .warn{color:var(--warn)} .bad{color:var(--bad)}
a.more{font-size:12px;color:var(--work);text-decoration:none;display:inline-block;margin-top:9px}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:4px 0;border-top:1px solid var(--line)}
td:last-child{text-align:right;color:var(--muted)}
pre.term{background:var(--panel);border:1px solid var(--line);border-radius:10px;
padding:12px 14px;overflow-x:auto;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;
white-space:pre;margin:0 0 16px;max-height:340px;overflow-y:auto}
details.f{background:var(--panel);border:1px solid var(--line);border-radius:9px;
margin-bottom:9px;overflow:hidden}
details.f>summary{cursor:pointer;padding:9px 13px;font:12.5px ui-monospace,Menlo,monospace;
list-style:none;display:flex;justify-content:space-between;gap:12px}
details.f>summary::-webkit-details-marker{display:none}
details.f>summary:hover{background:var(--hunkbg)}
.code{overflow-x:auto;border-top:1px solid var(--line)}
.l{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;
padding:0 13px;min-width:max-content}
.l.add{background:var(--addbg);color:var(--addfg)}
.l.del{background:var(--delbg);color:var(--delfg)}
.l.hunk{background:var(--hunkbg);color:var(--muted)}
.l.meta{color:var(--muted)}
.pill{font-size:11px;color:var(--muted);white-space:nowrap}
footer{color:var(--muted);font-size:12px;margin-top:20px}
.tree{list-style:none;margin:0;padding:0 0 0 6px}
.tree li{position:relative;padding:0 0 0 26px;margin:0}
.tree li::before{content:"";position:absolute;left:6px;top:0;bottom:0;
border-left:1.5px solid var(--line)}
.tree li:last-child::before{bottom:calc(100% - 20px)}
.tree li::after{content:"";position:absolute;left:6px;top:20px;width:16px;
border-top:1.5px solid var(--line)}
.node{background:var(--panel);border:1px solid var(--line);border-radius:9px;
margin:6px 0;overflow:hidden}
.node>summary{cursor:pointer;padding:9px 12px;list-style:none;display:flex;
align-items:center;gap:10px;flex-wrap:wrap}
.node>summary::-webkit-details-marker{display:none}
.node>summary:hover{background:var(--hunkbg)}
.node.keep{border-left:3px solid var(--ok)}
.node.drop{border-left:3px solid var(--line)}
.node.zero{border-left:3px solid var(--bad)}
.ix{font:11px ui-monospace,Menlo,monospace;color:var(--muted);min-width:34px}
.arrow{font:12px ui-monospace,Menlo,monospace}
.delta{font:12px ui-monospace,Menlo,monospace;font-weight:600}
.tag{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;
padding:2px 7px;border-radius:20px;border:1px solid var(--line);color:var(--muted)}
.tag.keep{color:var(--ok);border-color:var(--ok)}
.tag.zero{color:var(--bad);border-color:var(--bad)}
.tag.lever{color:var(--work);border-color:var(--work)}
.bars{padding:4px 12px 12px}
.bar{display:grid;grid-template-columns:190px 1fr 52px;gap:9px;
align-items:center;font-size:12px;padding:2px 0}
.bar .n{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track{height:7px;background:var(--hunkbg);border-radius:4px;position:relative}
.fill{position:absolute;left:0;top:0;bottom:0;border-radius:4px;background:var(--work)}
.fill.was{background:var(--muted);opacity:.45}
.bar .v{text-align:right;font:11px ui-monospace,Menlo,monospace;color:var(--muted)}
.seed{background:var(--panel);border:1px dashed var(--line);border-radius:9px;
padding:9px 12px;font-size:13px;margin-bottom:2px}
.runhead{display:flex;align-items:center;gap:10px;margin:22px 0 6px;flex-wrap:wrap}
.runhead h3{font-size:14px;margin:0}

"""


def page(title: str, active: str, body: str) -> str:
    now = datetime.now(timezone.utc).astimezone().strftime("%H:%M:%S")
    return f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="{REFRESH_SECONDS}">
<title>{esc(title)}</title><style>{STYLE}</style></head><body>
<h1>{esc(title)}</h1>
<div class="sub">live · refreshes every {REFRESH_SECONDS}s · updated {now}</div>
<nav class="tabs">{nav(active)}</nav>
{body}
<footer>Sources: <code>herdr agent list</code>, <code>git diff &lt;base&gt;</code> per arm,
experiments/baselines, ~/.cache/botmap, OpenRouter credits.
Spend is each agent's own session cost, not evaluation cost.</footer>
</body></html>"""


# ---------------------------------------------------------------- views

def view_overview() -> str:
    agents = herdr_agents()
    release, all_rel = cached_release()
    cards = []
    for key, arm in ARMS.items():
        a = agents.get(key, {})
        status = a.get("status", "absent")
        cls = status if status in ("working", "idle", "blocked") else "gone"
        v = pane_vitals(key) if status != "absent" else {}
        files, adds, dels = diffstat(arm)
        nc = len(commits(arm))
        extra = ""
        b = baseline_state(arm["baseline_root"])
        if b:
            st = b["state"]
            bc = "ok" if st == "VALID" else ("work" if st.startswith("MEASURING")
                                             else "warn")
            extra = (f"<div class='kv'><span>baseline</span>"
                     f"<b class='{bc}'>{esc(st)}</b></div>")
            if b.get("detail"):
                extra += f"<div class='kv'><span></span><i>{esc(b['detail'])}</i></div>"
            if b.get("history"):
                extra += (f"<div class='kv'><span>withdrawn</span>"
                          f"<i>{len(b['history'])} earlier</i></div>")
        elif arm.get("waits_for"):
            extra = (f"<div class='kv'><span>baseline</span>"
                     f"<b class='work'>shared — from {esc(arm['waits_for'])}</b>"
                     f"</div>")
        cards.append(f"""
        <article class="card {cls}">
          <header><span class="dot"></span><h2>{esc(arm['title'])}</h2>
          <span class="status">{esc(status)}</span></header>
          <p class="thesis">{esc(arm['thesis'])}</p>
          <div class="kv"><span>tokens</span><b>{esc(v.get('tokens','—'))}</b></div>
          <div class="kv"><span>spend</span><b>{esc(v.get('spend','—'))}</b></div>
          <div class="kv"><span>changes</span><b>{files} files
            <span class="ok">+{adds}</span> <span class="bad">-{dels}</span></b></div>
          <div class="kv"><span>commits</span><b>{nc}</b></div>
          {extra}
          <a class="more" href="/arm/{key}">View diffs and live output →</a>
        </article>""")

    runs_dir = SHARED / "experiments" / "runs"
    rows = ""
    if runs_dir.exists():
        for p in sorted(runs_dir.iterdir(), key=lambda x: x.stat().st_mtime,
                        reverse=True)[:5]:
            flag = "INVALID" if (p / "INVALID.md").exists() else "ok"
            rows += (f"<tr><td>{esc(p.name)}</td>"
                     f"<td class='{'bad' if flag=='INVALID' else ''}'>{flag}</td></tr>")
    rows = rows or "<tr><td colspan=2><i>none</i></td></tr>"
    rel_cls = "ok" if release == "2026-08-19.0" else "warn"

    return f"""<div class="grid">{''.join(cards)}</div>
<div class="grid">
  <article class="card"><header><h2>Shared constraints</h2></header>
    <div class="kv"><span>OpenRouter left</span><b>{esc(openrouter_balance())}</b></div>
    <div class="kv"><span>map release cached</span><b class="{rel_cls}">{esc(release)}</b></div>
    <div class="kv"><span>indexes on disk</span><b>{len(all_rel)}</b></div>
    <div class="kv"><span>orchestrator</span>
      <b>{esc(agents.get('orchestrator',{}).get('status','—'))}</b></div>
  </article>
  <article class="card"><header><h2>Recent runs (shared)</h2></header>
    <table>{rows}</table></article>
</div>"""


def view_arm(key: str) -> str:
    arm = ARMS[key]
    agents = herdr_agents()
    a = agents.get(key, {})
    status = a.get("status", "absent")
    cls = status if status in ("working", "idle", "blocked") else "gone"
    v = pane_vitals(key)
    files, adds, dels = diffstat(arm)

    head = f"""<div class="grid"><article class="card {cls}">
      <header><span class="dot"></span><h2>{esc(arm['title'])}</h2>
      <span class="status">{esc(status)}</span></header>
      <p class="thesis">{esc(arm['thesis'])}</p>
      <div class="kv"><span>repo</span><i>{esc(arm['repo'])}</i></div>
      <div class="kv"><span>base commit</span><b>{esc(arm['base'])}</b></div>
      <div class="kv"><span>tokens / spend</span>
        <b>{esc(v.get('tokens','—'))} · {esc(v.get('spend','—'))}</b></div>
      <div class="kv"><span>changed</span><b>{files} files
        <span class="ok">+{adds}</span> <span class="bad">-{dels}</span></b></div>
    </article>"""
    cl = commits(arm)
    rows = "".join(f"<tr><td><code>{esc(s)}</code> {esc(m)}</td></tr>" for s, m in cl) \
        or "<tr><td><i>no commits yet — work is uncommitted</i></td></tr>"
    head += (f"""<article class="card"><header><h2>Commits since {esc(arm['base'])}
      </h2></header><table>{rows}</table></article></div>""")

    # The lever comes first: it is what the experiment is actually optimising.
    body = ("<h2 style='font-size:14px;margin:18px 0 8px'>Lever — "
            "the files being optimised</h2>")
    tree = arm.get("lever_tree")
    body += (f"<p class='thesis'>{esc(', '.join(arm['lever_files']))}"
             f"<br>in <code>{esc(tree)}</code></p>")
    live, note = lever_live(arm)
    if live:
        for name, hunk in split_by_file(live):
            body += (f'<details class="f" open><summary><span>candidate · '
                     f'{esc(name)}</span><span class="pill">live</span></summary>'
                     f'<div class="code">{render_hunk(hunk)}</div></details>')
    else:
        body += f"<p class='thesis'>{esc(note)}</p>"
    hist = lever_history(key, arm)
    if hist:
        body += (f"<p class='thesis'><b>{len(hist)} candidate version(s) "
                 f"captured</b> by the sampler while runs were in flight. "
                 f"GEPA resets the tree between candidates, so these would "
                 f"otherwise have been unobservable.</p>")
        for when, rel, diff in hist:
            n_add = sum(1 for l in diff.splitlines()
                        if l.startswith("+") and not l.startswith("+++"))
            n_del = sum(1 for l in diff.splitlines()
                        if l.startswith("-") and not l.startswith("---"))
            body += (f'<details class="f"><summary><span>{esc(when)} · '
                     f'{esc(rel)}</span><span class="pill">'
                     f'<span class="ok">+{n_add}</span> '
                     f'<span class="bad">-{n_del}</span></span></summary>'
                     f'<div class="code">{render_hunk(diff)}</div></details>')

    for label, diff in lever_best(arm):
        body += (f'<details class="f"><summary><span>{esc(label)}</span>'
                 f'<span class="pill">best so far</span></summary>'
                 f'<div class="code">{render_hunk(diff)}</div></details>')

    cands = candidate_branches(arm)
    if cands:
        body += ("<h2 style='font-size:14px;margin:18px 0 8px'>Competing "
                 f"candidates ({len(cands)})</h2>")
        for branch, subject, diff in cands:
            n_add = sum(1 for l in diff.splitlines()
                        if l.startswith("+") and not l.startswith("+++"))
            n_del = sum(1 for l in diff.splitlines()
                        if l.startswith("-") and not l.startswith("---"))
            body += (f'<details class="f"><summary><span><b>{esc(branch)}</b>'
                     f' — {esc(subject)}</span><span class="pill">'
                     f'<span class="ok">+{n_add}</span> '
                     f'<span class="bad">-{n_del}</span></span></summary>'
                     f'<div class="code">{render_hunk(diff)}</div></details>')

    term = esc(pane_text(key, 44).rstrip()) or "<i>no output captured</i>"
    body += "<h2 style='font-size:14px;margin:18px 0 8px'>Live terminal</h2>"
    body += f'<pre class="term">{term}</pre>'

    # The botmap clone itself. GEPA should never touch this — anything here is
    # a hand-edit to the tool under test, which would invalidate comparisons.
    tool_repo = arm.get("tool_repo")
    if tool_repo:
        body += ("<h2 style='font-size:14px;margin:18px 0 8px'>botmap repo "
                 "(tool under test)</h2>")
        body += f"<p class='thesis'><code>{esc(tool_repo)}</code></p>"
        traw = git(Path(tool_repo), "diff", arm.get("tool_base", "3009509"))
        tcommits = git(Path(tool_repo), "log", "--oneline",
                       f"{arm.get('tool_base','3009509')}..HEAD").strip()
        tun = [f for f in git(Path(tool_repo), "ls-files", "--others",
                              "--exclude-standard").splitlines()
               if f.strip() and not NOISE.search(f)]
        if tcommits:
            body += ("<p class='thesis warn'>Commits since base: "
                     f"{esc(tcommits)}</p>")
        if traw.strip():
            for name, hunk in split_by_file(traw):
                body += (f'<details class="f"><summary><span>{esc(name)}</span>'
                         f'<span class="pill warn">hand-edit</span></summary>'
                         f'<div class="code">{render_hunk(hunk)}</div></details>')
        if tun:
            body += ("<p class='thesis'>New files: "
                     + esc(", ".join(tun[:10])) + "</p>")
        if not traw.strip() and not tcommits and not tun:
            body += ("<p class='thesis ok'>Clean at base — as expected. "
                     "GEPA writes candidates to the pool worktree above, "
                     "never to this clone.</p>")

    raw = diff_text(arm)
    label = "Harness changes (autoresearch)" if arm.get("tool_repo") \
        else "Repo diff vs base"
    body += f"<h2 style='font-size:14px;margin:18px 0 8px'>{label}</h2>"
    if len(raw) > MAX_DIFF_BYTES:
        body += (f"<p class='thesis'>Diff is {len(raw):,} bytes — too large to render. "
                 f"Run <code>git -C {esc(arm['repo'])} diff {esc(arm['base'])}</code>.</p>")
    else:
        chunks = split_by_file(raw)
        if not chunks:
            body += "<p class='thesis'>No tracked changes yet.</p>"
        for name, hunk in chunks:
            n_add = sum(1 for l in hunk.splitlines()
                        if l.startswith("+") and not l.startswith("+++"))
            n_del = sum(1 for l in hunk.splitlines()
                        if l.startswith("-") and not l.startswith("---"))
            body += (f'<details class="f"><summary><span>{esc(name)}</span>'
                     f'<span class="pill"><span class="ok">+{n_add}</span> '
                     f'<span class="bad">-{n_del}</span></span></summary>'
                     f'<div class="code">{render_hunk(hunk)}</div></details>')

    un = untracked(arm)
    if un:
        body += "<h2 style='font-size:14px;margin:18px 0 8px'>New files (untracked)</h2>"
        for f in un[:20]:
            p = arm["repo"] / f
            try:
                size = p.stat().st_size
                if size > INLINE_LIMIT:
                    lines = (f'<div class="l meta">{size:,} bytes — too large to '
                             f'inline. Open {esc(p)}</div>')
                else:
                    lines = "".join(
                        f'<div class="l add">{html.escape(l) or "&nbsp;"}</div>'
                        for l in p.read_text(errors="replace").splitlines())
            except Exception:
                lines = '<div class="l meta">(binary or unreadable)</div>'
            body += (f'<details class="f"><summary><span>{esc(f)}</span>'
                     f'<span class="pill">new</span></summary>'
                     f'<div class="code">{lines}</div></details>')
    return head + body


def view_proposals() -> str:
    data = adoptable()
    out = ("<p class='thesis'>Changes that could be applied to "
           f"<code>{esc(TARGET_REPO)}</code>. Nothing here is applied "
           "automatically — this is the shortlist, you decide.</p>")

    out += ("<h2 style='font-size:14px;margin:20px 0 8px'>Ready now — built and "
            f"testable ({len(data['live'])})</h2>")
    if not data["live"]:
        out += ("<p class='thesis'>No candidates built yet. Arm A produces these "
                "as cand/* branches; the GEPA arms produce them once their runs "
                "start.</p>")
    for c in data["live"]:
        out += (f'<details class="f"><summary><span><b>{esc(c["who"])}</b> — '
                f'{esc(c["title"])}</span><span class="pill">'
                f'{esc(", ".join(c["files"])[:60])}</span></summary>'
                f'<div class="code">{render_hunk(c["diff"])}</div>')
        if c["apply"]:
            out += (f'<div class="l meta" style="padding:8px 13px;'
                    f'border-top:1px solid var(--line)">'
                    f'{esc(c["apply"])}</div>')
        out += "</details>"

    out += ("<h2 style='font-size:14px;margin:20px 0 8px'>From completed runs "
            f"({len(data['runs'])})</h2>")
    if not data["runs"]:
        out += "<p class='thesis'>No finished run has produced a patch yet.</p>"
    for r in data["runs"]:
        badge = ('<span class="pill bad">from an INVALID run</span>'
                 if r["invalid"] else '<span class="pill">patch</span>')
        out += (f'<details class="f"><summary><span>{esc(r["who"])} — '
                f'{esc(", ".join(r["files"])[:70])}</span>{badge}</summary>')
        if r["invalid"]:
            out += ('<div class="l meta" style="padding:8px 13px">This run was '
                    'marked INVALID. Read the diff for ideas, but do not treat '
                    'its score as evidence.</div>')
        out += (f'<div class="code">{render_hunk(r["diff"])}</div>'
                f'<div class="l meta" style="padding:8px 13px;'
                f'border-top:1px solid var(--line)">{esc(r["apply"])}</div>'
                f'</details>')

    out += ("<h2 style='font-size:14px;margin:20px 0 8px'>Known bugs, not yet "
            f"acted on ({len(data['known'])})</h2>"
            "<p class='thesis'>From <code>experiments/proposals.json</code> — a "
            "reading list, not an input. Nothing in the loop opens this file. "
            "Several are one-line fixes; if a run independently finds one, that "
            "is real evidence the loop works.</p>")
    for k in data["known"]:
        out += (f'<details class="f"><summary><span>{esc(k["title"])}</span>'
                f'<span class="pill">{esc(k["target"])}</span></summary>'
                f'<div class="code"><div class="l meta" '
                f'style="white-space:pre-wrap;padding:10px 13px">'
                f'{esc(k["evidence"])}</div></div></details>')
    return out



def _bars(node: dict) -> str:
    """One row per question in the subsample: parent score under child score."""
    rows = ""
    for j, q in enumerate(node["questions"]):
        was = node["old"][j] if j < len(node["old"]) else 0.0
        now = node["new"][j] if j < len(node["new"]) else 0.0
        rows += (f'<div class="bar"><span class="n" title="{esc(q)}">{esc(q)}</span>'
                 f'<span class="track">'
                 f'<span class="fill was" style="width:{was*100:.0f}%"></span>'
                 f'<span class="fill" style="width:{now*100:.0f}%;'
                 f'opacity:.85"></span></span>'
                 f'<span class="v">{was:.2f}→{now:.2f}</span></div>')
    return f'<div class="bars">{rows}</div>'


def view_tree() -> str:
    out = ("<p class='thesis'>How each arm actually searched. The two shapes "
           "differ on purpose: GEPA mutates a parent and keeps the child only "
           "if a small subsample improves, so most children die; Arm A proposes "
           "several competing candidates from evidence and judges them against "
           "one shared mini-batch.</p>")

    # ---- Arm A: competing branches
    a = ARMS["arm-a"]
    branches = trajectory.branch_tree(Path(a["lever_tree"]),
                                      a.get("cand_base", a["base"]), git)
    out += ("<div class='runhead'><h3>Arm A — competing candidates</h3>"
            f"<span class='tag'>{len(branches)} live</span></div>")
    if not branches:
        out += "<p class='thesis'>No candidate branches yet.</p>"
    else:
        out += (f"<div class='seed'><b>arm-a-base</b> "
                f"<span class='ix'>{esc(a.get('cand_base',''))}</span> — "
                f"the tool as shipped, plus the loop skills</div><ul class='tree'>")
        for b in branches:
            out += (f"<li><details class='node keep'><summary>"
                    f"<span class='ix'>{'▸' if not b['current'] else '●'}</span>"
                    f"<b>{esc(b['branch'].replace('cand/',''))}</b>"
                    f"<span class='tag lever'>{esc(b['lever'])} lever</span>"
                    f"<span class='delta'><span class='ok'>+{b['adds']}</span> "
                    f"<span class='bad'>-{b['dels']}</span></span></summary>"
                    f"<div class='bars'><div style='font-size:12.5px;"
                    f"color:var(--muted);padding:2px 0'>{esc(b['subject'])}</div>"
                    f"<div style='font-size:12px;padding:4px 0'>"
                    f"<code>{esc(', '.join(b['files']))}</code></div></div>"
                    f"</details></li>")
        out += "</ul>"

    # ---- GEPA arms: iteration lineage
    for key, root in (("arm-b", SHARED), ("arm-c", ARM_C_TREE)):
        runs = trajectory.gepa_runs(Path(root))
        title = ARMS[key]["title"].split(" — ")[0]
        out += f"<div class='runhead'><h3>{esc(title)} — GEPA iterations</h3></div>"
        if not runs:
            out += ("<p class='thesis'>No GEPA run has produced a lineage yet. "
                    "This fills in once the run starts.</p>")
        for r in runs:
            kept = sum(1 for n in r["nodes"] if n["kept"])
            zeros = sum(1 for n in r["nodes"] if n["suspect_zero"])
            badge = ("<span class='tag zero'>INVALID run</span>"
                     if r["invalid"] else "")
            out += (f"<div class='runhead'><h3 style='font-weight:500'>"
                    f"{esc(r['name'])}</h3>{badge}"
                    f"<span class='tag'>{len(r['nodes'])} iterations</span>"
                    f"<span class='tag keep'>{kept} accepted</span>"
                    + (f"<span class='tag zero'>{zeros} scored 0.000</span>"
                       if zeros else "") + "</div>")
            if r["invalid"]:
                out += ("<p class='thesis bad'>This run was withdrawn. The "
                        "shape of the search is still informative; the numbers "
                        "are not evidence.</p>")
            out += ("<div class='seed'><b>candidate 0</b> — the seed, i.e. the "
                    "unchanged files</div><ul class='tree'>")
            for n in r["nodes"]:
                cls = "zero" if n["suspect_zero"] else ("keep" if n["kept"] else "drop")
                d = n["delta"]
                dcls = "ok" if d > 0 else ("bad" if d < 0 else "")
                tag = ("<span class='tag keep'>kept → candidate "
                       f"{n['child']}</span>" if n["kept"]
                       else "<span class='tag'>discarded</span>")
                if n["suspect_zero"]:
                    tag += ("<span class='tag zero'>every attempt scored 0"
                            "</span>")
                out += (f"<li><details class='node {cls}'><summary>"
                        f"<span class='ix'>i={n['i']}</span>"
                        f"<span class='arrow'>from cand {n['parent']}</span>"
                        f"<span class='delta'>{n['mean_old']:.3f} → "
                        f"{n['mean_new']:.3f}</span>"
                        f"<span class='delta {dcls}'>{d:+.3f}</span>{tag}"
                        f"</summary>{_bars(n)}</details></li>")
            out += "</ul>"
            if r["summary"]:
                sm = r["summary"]
                out += (f"<p class='thesis'>Outcome: changed "
                        f"<code>{esc(', '.join(sm.get('files_changed') or []) or 'nothing')}"
                        f"</code> · {sm.get('evaluations_run','?')} evaluations · "
                        f"{sm.get('candidates_tried','?')} candidates · "
                        f"{sm.get('minutes','?')} min</p>")
    return out


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = unquote(self.path.split("?")[0])
        try:
            if path in ("/", "/index.html"):
                body = page("Autoresearch — three arms", "overview", view_overview())
            elif path == "/tree":
                body = page("Search trajectories", "tree", view_tree())
            elif path == "/proposals":
                body = page("Adoptable changes", "proposals", view_proposals())
            elif path.startswith("/arm/"):
                key = path[len("/arm/"):].strip("/")
                if key not in ARMS:
                    self.send_error(404); return
                body = page(ARMS[key]["title"], key, view_arm(key))
            else:
                self.send_error(404); return
        except Exception as e:  # a render bug must not take the page down
            body = page("Autoresearch — error", "overview",
                        f"<pre class='term'>{esc(repr(e))}</pre>")
        raw = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *_):
        pass


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8765)
    args = p.parse_args()
    import threading
    threading.Thread(target=sampler_loop, daemon=True).start()
    print(f"dashboard: http://localhost:{args.port}  (ctrl-c to stop)")
    print(f"sampling lever files every {SAMPLE_SECONDS}s -> {HISTORY}")
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

"""Finds out what GEPA wanted to change but wasn't allowed to.

GEPA can only rewrite the files we hand it. There are two ways that bites, and
they need different fixes:

1. **An existing file we left out.** Fixable next run by adding it to the file
   list.
2. **A file that does not exist yet.** GEPA can *never* create one — the set of
   things it can edit is fixed the moment we hand it the seed. So this failure
   repeats forever unless we notice. The fix is to create the file ourselves,
   even empty, and include it next time.

Either way the symptom is the same from outside: the run just underperforms,
and GEPA either patches around the problem somewhere it can reach or keeps
proposing the same doomed change. So we ask it to say when it is blocked, and
read its reasoning back afterwards.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

# We ask GEPA to write this exact line when it needs a file that doesn't exist.
# A fixed marker is far more reliable than guessing from prose, and it lets it
# tell us *why* as well as *what*.
NEW_FILE_MARKER = "NEW FILE NEEDED:"

# Anything shaped like a source filename, with or without a directory.
_FILENAME = re.compile(r"\b((?:[\w./-]+/)?[\w-]+\.(?:py|md))\b")


@dataclass
class Wanted:
    """What GEPA reached for and could not have."""

    # Files that exist in the tool but weren't editable this run.
    out_of_scope: Counter[str] = field(default_factory=Counter)
    # Files that don't exist at all. GEPA cannot create these, ever.
    new_files: Counter[str] = field(default_factory=Counter)
    # The reasons it gave, when it used the marker.
    reasons: dict[str, str] = field(default_factory=dict)

    def __bool__(self) -> bool:
        return bool(self.out_of_scope or self.new_files)


def _read_logs(run_dir: Path) -> str:
    parts = []
    for name in ("run_log.txt", "run_log.json", "candidates.json"):
        path = run_dir / name
        if path.exists():
            parts.append(path.read_text(encoding="utf-8", errors="replace"))
    return "\n".join(parts)


def scan(run_dir: Path, in_scope: tuple[str, ...], repo: Path) -> Wanted:
    """Read GEPA's reasoning and sort what it wanted into the two buckets."""
    text = _read_logs(run_dir)
    wanted = Wanted()
    if not text:
        return wanted

    existing = {
        str(p.relative_to(repo))
        for p in (repo / "botmap").rglob("*")
        if p.is_file() and p.suffix in {".py", ".md"}
    }
    by_name = {Path(f).name: f for f in existing}
    allowed = set(in_scope)

    # 1. Explicit requests, which carry a reason we can quote back.
    for line in text.splitlines():
        if NEW_FILE_MARKER not in line:
            continue
        after = line.split(NEW_FILE_MARKER, 1)[1].strip()
        match = _FILENAME.search(after)
        if not match:
            continue
        path = match.group(1)
        wanted.new_files[path] += 1
        reason = after[match.end() - after.find(path) :].strip(" -—:")
        if reason and path not in wanted.reasons:
            wanted.reasons[path] = reason[:200]

    # 2. Filenames mentioned in passing, sorted by whether they exist.
    for raw in _FILENAME.findall(text):
        name = Path(raw).name
        if name in by_name:
            path = by_name[name]
            if path not in allowed:
                wanted.out_of_scope[path] += 1
        elif raw not in wanted.new_files:
            # Not in the tool and not already recorded: probably a file it
            # wishes existed. Counted separately because it is a guess.
            wanted.new_files[raw] += 1

    return wanted


def report(wanted: Wanted) -> str:
    """A note for the operator, or empty when nothing was blocked."""
    if not wanted:
        return ""

    out: list[str] = []

    if wanted.new_files:
        out += [
            "GEPA WANTED FILES THAT DO NOT EXIST",
            "",
            "It cannot create files — the set it can edit is fixed when the run",
            "starts. So this will keep failing until you create them yourself.",
            "",
        ]
        for path, n in wanted.new_files.most_common():
            out.append(f"  {path:34} asked for {n}x")
            if path in wanted.reasons:
                out.append(f"      why: {wanted.reasons[path]}")
        wanted_paths = " ".join(sorted(wanted.new_files))
        out += [
            "",
            "To let the next run have them, create them first — empty is fine,",
            "GEPA fills them in — then name them in the file list:",
            "",
            f"  touch {wanted_paths}",
            f"  python -m autoresearch.optimize --files {wanted_paths} <your existing files>",
            "",
            "Remember a new module also needs importing from somewhere, so keep",
            "the file that would import it in the list too.",
            "",
        ]

    if wanted.out_of_scope:
        out += [
            "GEPA REFERRED TO EXISTING FILES IT COULD NOT EDIT",
            "",
        ]
        for path, n in wanted.out_of_scope.most_common():
            out.append(f"  {path:34} mentioned {n}x")
        out += [
            "",
            "One it keeps returning to is worth adding next run:",
            f"  --files {' '.join(sorted(wanted.out_of_scope))} <the files you already had>",
            "",
        ]

    out.append("Mentions are not proof — read run_log.txt before widening.")
    return "\n".join(out)

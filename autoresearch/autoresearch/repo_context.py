"""Shows GEPA the whole tool, while it may still only edit a few of its files.

Why this exists. GEPA used to see exactly the files it was allowed to rewrite
and nothing else, which left it reasoning about a component without being able
to read the thing it talks to. In the previous run it reached for
`botmap/core.py` thirty-five times, could not see it, and had to guess.

Seeing a file and being allowed to edit it are different permissions, and
conflating them was the mistake. So: the editable set stays exactly as narrow
as before -- attribution depends on that -- and everything else comes along
read-only.

Two levels of detail, because they cost very different amounts:

- a **map** of every file, always, at roughly one line each. Cheap enough that
  leaving a file out would save nothing worth having.
- the **source** of the files GEPA cannot edit, most relevant first, until a
  character budget runs out. The editable files are excluded: GEPA already
  holds those as the candidate, and sending them twice would pay for them
  twice and invite an edit to the stale copy.
"""

from __future__ import annotations

import ast
from pathlib import Path

# Roughly four characters to a token, so this is about 15k tokens of source on
# top of the map. Paid once per proposal, not once per evaluation -- proposals
# are the rare event, so this is affordable where a per-evaluation cost would
# not be.
DEFAULT_BUDGET_CHARS = 60_000

# Files that exist but say nothing about how the tool behaves at query time.
# Left out of the source dump; they still appear in the map, so their absence
# is visible rather than silent.
UNINTERESTING = {
    "botmap/__init__.py",         # re-exports
    "botmap/__main__.py",         # four lines of entry point
    "botmap/skill_installer.py",  # installs the instructions; not used at query time
}

# Read-only files worth spending the budget on first. Ordered by how often the
# previous run reached for them (core.py 35x, cache.py 2x) and then by how
# much they shape what the agent sees. Anything not named here still gets
# included afterwards, in alphabetical order, if budget remains.
PRIORITY = (
    "botmap/core.py",
    "botmap/cache.py",
    "botmap/models.py",
    "botmap/writers.py",
    "botmap/changelog.py",
)


def _summary(path: Path) -> str:
    """The file's own one-line description of itself, or nothing.

    Read from the module docstring rather than invented here, so the map keeps
    telling the truth as the tool changes.
    """
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return ""
    doc = ast.get_docstring(tree) or ""
    return doc.strip().splitlines()[0].strip() if doc else ""


def _python_files(repo: Path) -> list[str]:
    return sorted(f"botmap/{p.name}" for p in (repo / "botmap").glob("*.py"))


def _order(candidates: list[str]) -> list[str]:
    """Priority files first, in the order named; then the rest alphabetically."""
    ranked = [f for f in PRIORITY if f in candidates]
    return ranked + [f for f in candidates if f not in ranked]


def build(repo: Path, editable: tuple[str, ...],
          budget_chars: int = DEFAULT_BUDGET_CHARS) -> str:
    """The read-only view of the tool, as text to hand to the improver."""
    editable_set = set(editable)
    files = _python_files(repo)

    lines = [
        "",
        "=" * 70,
        "THE REST OF THE TOOL (read-only)",
        "=" * 70,
        "",
        "Below is the rest of the package. You cannot edit any of it. It is here",
        "so you can see how the piece you are changing fits into the whole, and",
        "so you can tell the difference between 'the tool cannot do this' and",
        "'the tool can do this and the agent could not find it'.",
        "",
        "If the real fix belongs in one of these files, say so and name it, using",
        "the wording described above. Do not reimplement a read-only file inside",
        "one you can edit -- a duplicate of core.py living in cli.py is worse",
        "than the problem it works around, and we would rather widen the next run.",
        "",
        "FILE MAP",
    ]

    width = max((len(f) for f in files), default=0)
    for rel in files:
        path = repo / rel
        mark = "EDITABLE " if rel in editable_set else "read-only"
        count = len(path.read_text(encoding="utf-8").splitlines())
        note = _summary(path)
        lines.append(f"  {rel:<{width}}  {count:>5} lines  {mark}  {note}")

    # Source, most relevant first, until the budget runs out.
    candidates = [f for f in files
                  if f not in editable_set and f not in UNINTERESTING]
    spent = 0
    included: list[str] = []
    omitted: list[str] = []
    body: list[str] = []

    for rel in _order(candidates):
        text = (repo / rel).read_text(encoding="utf-8")
        if spent + len(text) > budget_chars:
            omitted.append(rel)
            continue
        spent += len(text)
        included.append(rel)
        body += ["", f"--- {rel} " + "-" * max(0, 66 - len(rel)), "", text]

    lines += ["", "SOURCE OF THE FILES YOU CANNOT EDIT"]
    if omitted:
        # Say what is missing. A silently truncated context reads exactly like
        # a complete one, and GEPA would draw conclusions from a gap it could
        # not see.
        lines.append(
            f"  (omitted for length, map only: {', '.join(omitted)} — "
            f"ask for one by name if you need it)"
        )
    lines += body
    return "\n".join(lines)


def describe(repo: Path, editable: tuple[str, ...],
             budget_chars: int = DEFAULT_BUDGET_CHARS) -> dict[str, object]:
    """What the context ended up containing, for the run summary.

    Recorded because the context is now an input to the result: two runs given
    different views of the repo are not comparable, and we would have no way of
    knowing that afterwards without this.
    """
    text = build(repo, editable, budget_chars)
    files = _python_files(repo)
    shown = [f for f in _order([f for f in files
                                if f not in set(editable) and f not in UNINTERESTING])
             if f"--- {f} " in text]
    return {
        "chars": len(text),
        "budget_chars": budget_chars,
        "read_only_sources_included": shown,
        "mapped_only": [f for f in files if f not in shown and f not in set(editable)],
    }

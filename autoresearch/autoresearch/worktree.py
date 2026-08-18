"""Private copies of the tool, so experiments can't tread on each other.

A git worktree is a second checkout of the same repository in another folder.
We give each worker its own, write the candidate version of the file into it,
and run the questions there. Nothing we do touches your real checkout.

Worktrees are reused rather than recreated. Making one costs a few seconds
(mostly installing dependencies), and GEPA will evaluate hundreds of
candidates, so rebuilding every time would dominate the run.
"""

from __future__ import annotations

import shutil
import subprocess
import threading
from pathlib import Path

from . import config


def _git(args: list[str], cwd: Path) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout


def head_sha(repo: Path | None = None) -> str:
    """The commit every copy starts from. Fixed for a whole run."""
    return _git(["rev-parse", "--short", "HEAD"], repo or config.repo_root()).strip()


class Pool:
    """Hands out one private copy per worker thread, and reuses them.

    Thread-safe because GEPA can evaluate candidates in parallel.
    """

    def __init__(self, sha: str, base: Path | None = None,
                 files: tuple[str, ...] | None = None):
        self.sha = sha
        self.files = files  # None means "use the lever's curated default"
        self.repo = config.repo_root()
        self.base = base or self.repo.parent
        self._trees: dict[int, Path] = {}
        self._lock = threading.Lock()

    def _create(self, name: str) -> Path:
        path = self.base / f"botmap-oa-{name}"
        if path.exists():
            self.destroy(path)
        _git(["worktree", "add", "--detach", str(path), self.sha], self.repo)
        # Each copy needs its own installed dependencies. Done once per copy,
        # not once per candidate — writing a .py file takes effect immediately
        # because Python imports it from the working directory.
        subprocess.run(["uv", "sync"], cwd=path, check=True, capture_output=True)
        return path

    def acquire(self) -> Path:
        """The calling thread's private copy, made on first use."""
        key = threading.get_ident()
        with self._lock:
            if key not in self._trees:
                self._trees[key] = self._create(f"{self.sha}-{len(self._trees)}")
            return self._trees[key]

    def write_candidate(self, tree: Path, lever: str, files: dict[str, str]) -> None:
        """Put the proposed version of each file into this copy.

        Keyed by path relative to the tool's repo, e.g. "botmap/filters.py".
        We only write the files the candidate actually carries, so a candidate
        that changed one file leaves the rest of the copy untouched.
        """
        allowed = set(config.lever_files(lever, self.files))
        # Check every path before writing any of them. Refusing halfway would
        # leave the copy holding a mix of this candidate and the last one,
        # which is exactly the state reset() exists to prevent.
        outside = sorted(set(files) - allowed)
        if outside:
            # Should never happen, but writing outside the lever would make
            # the result impossible to attribute, so refuse loudly.
            raise ValueError(f"{', '.join(outside)} is not part of the '{lever}' lever")
        for rel, text in files.items():
            target = tree / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")

    def read_original(self, lever: str) -> dict[str, str]:
        """The unchanged files, which is where the search starts."""
        return {
            rel: (self.repo / rel).read_text(encoding="utf-8")
            for rel in config.lever_files(lever, self.files)
        }

    def reset(self, tree: Path) -> None:
        """Throw away any edits, putting the copy back to the starting commit."""
        _git(["checkout", "--", "."], tree)

    def destroy(self, path: Path) -> None:
        try:
            _git(["worktree", "remove", "--force", str(path)], self.repo)
        except subprocess.CalledProcessError:
            shutil.rmtree(path, ignore_errors=True)

    def close(self) -> None:
        with self._lock:
            for path in self._trees.values():
                self.destroy(path)
            self._trees.clear()

    def prune(self) -> None:
        """Clear out copies left behind by a run that was killed."""
        subprocess.run(["git", "worktree", "prune"], cwd=self.repo, capture_output=True)

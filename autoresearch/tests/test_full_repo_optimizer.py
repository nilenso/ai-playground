from __future__ import annotations

import subprocess

from autoresearch import config


def _git(repo, *args: str) -> None:
    subprocess.run(
        [
            "git",
            "-c",
            "user.name=Autoresearch Test",
            "-c",
            "user.email=test@example.invalid",
            *args,
        ],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )


def test_full_repo_files_returns_tracked_utf8_files(monkeypatch, tmp_path):
    repo = tmp_path / "botmap-repo"
    repo.mkdir()
    (repo / "botmap").mkdir()
    (repo / "botmap" / "cli.py").write_text("print('ok')\n", encoding="utf-8")
    (repo / "evals").mkdir()
    (repo / "evals" / "score.py").write_text("print('exam')\n", encoding="utf-8")
    (repo / "README.md").write_text("# botmap\n", encoding="utf-8")
    (repo / "image.bin").write_bytes(b"abc\x00def")
    (repo / "untracked.py").write_text("ignored\n", encoding="utf-8")

    _git(repo, "init")
    _git(repo, "add", "botmap/cli.py", "evals/score.py", "README.md", "image.bin")
    _git(repo, "commit", "-m", "seed")

    monkeypatch.setattr(config, "repo_root", lambda: repo)

    assert config.full_repo_files() == ("README.md", "botmap/cli.py")
    assert config.full_repo_files(include_evaluator=True) == (
        "README.md",
        "botmap/cli.py",
        "evals/score.py",
    )


def test_full_repo_context_includes_bounded_tracked_file_contents(monkeypatch, tmp_path):
    repo = tmp_path / "botmap-repo"
    repo.mkdir()
    (repo / "botmap").mkdir()
    (repo / "botmap" / "cli.py").write_text("print('ok')\n", encoding="utf-8")
    (repo / "README.md").write_text("# botmap\n", encoding="utf-8")

    _git(repo, "init")
    _git(repo, "add", "botmap/cli.py", "README.md")
    _git(repo, "commit", "-m", "seed")

    monkeypatch.setattr(config, "repo_root", lambda: repo)

    context = config.full_repo_context(max_chars=1_000, file_max_chars=1_000)

    assert "--- FILE: README.md ---" in context
    assert "# botmap" in context
    assert "--- FILE: botmap/cli.py ---" in context
    assert "print('ok')" in context

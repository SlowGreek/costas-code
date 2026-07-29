"""Changelog parsing: every commit in range must reach the release notes.

`get_commits` formats `git log` with NUL delimiters:

    --format=%H<US>%an<US>%ae<US>%s%x00%b%x00

and then split records on ``"\\0\\0"``. That separator never occurs. git
terminates each record with a NEWLINE, so the actual boundary between two
commits is ``"\\0\\n"`` — the whole log parsed as a single entry and only the
FIRST commit survived.

Observed: 19 non-merge commits between v2026.7.28 and HEAD produced a
changelog with exactly 1 entry. Every release since this format was introduced
has silently dropped all but its newest commit, so the published notes
understated what shipped.

These are behaviour contracts against a real throwaway git repo — no mocks, no
assertions about the format string itself, so the format stays free to change
as long as every commit still round-trips.
"""

from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_release_module(repo_root: Path | None = None):
    """Import scripts/release.py, optionally re-rooting it at a temp repo.

    ``git()`` in release.py runs with ``cwd=REPO_ROOT`` rather than the
    process cwd, so ``monkeypatch.chdir`` alone cannot redirect it at a
    fixture repo — the module-level constant has to be replaced.
    """
    spec = importlib.util.spec_from_file_location(
        "release_under_test", REPO_ROOT / "scripts" / "release.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if repo_root is not None:
        module.REPO_ROOT = repo_root
    return module


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()


@pytest.fixture()
def repo_with_history(tmp_path, monkeypatch):
    """A real git repo: a tag, then N commits with varied body shapes."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test User")

    (repo / "f.txt").write_text("0\n")
    _git(repo, "add", "f.txt")
    _git(repo, "commit", "-q", "-m", "chore: base")
    _git(repo, "tag", "v2026.1.1")

    # Bodies matter: empty, single-line, multi-paragraph, and one with a
    # trailer. A parser that keys off body shape breaks on at least one.
    messages = [
        "feat: first thing",
        "fix: second thing\n\nWith a one-line body.",
        "fix: third thing\n\nParagraph one.\n\nParagraph two.",
        "feat: fourth thing\n\nBody.\n\nCo-Authored-By: Someone <s@example.com>",
        "docs: fifth thing",
    ]
    for i, msg in enumerate(messages, start=1):
        (repo / "f.txt").write_text(f"{i}\n")
        _git(repo, "add", "f.txt")
        _git(repo, "commit", "-q", "-m", msg)

    monkeypatch.chdir(repo)
    return repo, len(messages)


def test_every_commit_in_range_is_parsed(repo_with_history):
    """The contract: N commits in range → N changelog entries.

    This is the regression. The old ``"\\0\\0"`` split collapsed the entire
    log into one record, so a 19-commit release shipped a 1-line changelog.
    """
    _repo, expected = repo_with_history
    release = _load_release_module(_repo)

    commits = release.get_commits(since_tag="v2026.1.1")

    assert len(commits) == expected, (
        f"expected {expected} commits from the tag, got {len(commits)} — "
        "the record separator is dropping commits"
    )


def test_parsed_commits_match_git_rev_list(repo_with_history):
    """Cross-check against git itself rather than a hardcoded number.

    Ties the parser to the same source of truth a human would use, so the test
    can't drift from reality.
    """
    repo, _ = repo_with_history
    release = _load_release_module(repo)

    expected = int(
        _git(repo, "rev-list", "--count", "--no-merges", "v2026.1.1..HEAD")
    )
    commits = release.get_commits(since_tag="v2026.1.1")

    assert len(commits) == expected


def test_each_commit_keeps_its_own_fields(repo_with_history):
    """A separator bug can also SMEAR fields across records.

    Splitting on the wrong boundary can leave one commit's body glued to the
    next commit's header, so assert each entry is individually well-formed
    rather than only counting them.
    """
    _repo, _ = repo_with_history
    release = _load_release_module(_repo)

    commits = release.get_commits(since_tag="v2026.1.1")

    subjects = [c["subject"] for c in commits]
    assert "docs: fifth thing" in subjects
    assert "feat: first thing" in subjects

    for commit in commits:
        assert len(commit["sha"]) == 40, f"malformed sha: {commit['sha']!r}"
        assert commit["short_sha"] == commit["sha"][:8]
        assert commit["author_email"] == "test@example.com"
        # A smeared record shows up as a subject carrying a NUL or newline.
        assert "\0" not in commit["subject"]
        assert "\n" not in commit["subject"]


def test_multiline_bodies_do_not_split_into_extra_commits(repo_with_history):
    """Paragraph breaks in a body must not be mistaken for record boundaries.

    A naive "split on blank line" fix would over-count instead of under-count —
    the opposite failure, equally wrong.
    """
    _repo, expected = repo_with_history
    release = _load_release_module(_repo)

    commits = release.get_commits(since_tag="v2026.1.1")
    assert len(commits) == expected

    # The multi-paragraph commit is one entry, not two.
    assert sum(1 for c in commits if c["subject"] == "fix: third thing") == 1

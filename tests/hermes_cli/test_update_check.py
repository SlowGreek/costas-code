"""Tests for the update check mechanism in hermes_cli.banner."""

import json
import os
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest




def test_check_for_updates_uses_cache(tmp_path, monkeypatch):
    """When cache is fresh, check_for_updates should return cached value without calling git."""
    from hermes_cli.banner import check_for_updates
    from hermes_cli import __version__

    # Create a fake git repo and fresh cache
    repo_dir = tmp_path / "hermes-agent"
    repo_dir.mkdir()
    (repo_dir / ".git").mkdir()

    cache_file = tmp_path / ".update_check"
    cache_file.write_text(json.dumps({"ts": time.time(), "behind": 3, "ver": __version__}))

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    with patch("hermes_cli.banner.subprocess.run") as mock_run:
        result = check_for_updates()

    assert result == 3
    mock_run.assert_not_called()




def test_check_for_updates_expired_cache(tmp_path, monkeypatch):
    """When cache is expired, check_for_updates should call git fetch."""
    from hermes_cli.banner import check_for_updates

    repo_dir = tmp_path / "hermes-agent"
    repo_dir.mkdir()
    (repo_dir / ".git").mkdir()

    # Write an expired cache (timestamp far in the past)
    cache_file = tmp_path / ".update_check"
    cache_file.write_text(json.dumps({"ts": 0, "behind": 1}))

    def fake_run(cmd, **kwargs):
        if cmd == ["git", "remote", "get-url", "origin"]:
            return MagicMock(
                returncode=0,
                stdout="https://github.com/SlowGreek/costas-code.git\n",
            )
        if cmd == ["git", "rev-parse", "--is-shallow-repository"]:
            return MagicMock(returncode=0, stdout="false\n")
        if cmd[:2] == ["git", "fetch"]:
            return MagicMock(returncode=0, stdout="")
        if cmd == [
            "git",
            "rev-list",
            "--count",
            "HEAD..origin/costas-code",
        ]:
            return MagicMock(returncode=0, stdout="5\n")
        if cmd[:3] == ["git", "merge-base", "--is-ancestor"]:
            # Upstream added a local-ahead check to the SSH fast path: when the
            # tips differ it asks whether the remote tip is an ancestor of HEAD
            # (ahead, not behind). returncode=1 => genuinely behind, which is
            # what this test is asserting.
            return MagicMock(returncode=1, stdout="")
        raise AssertionError(f"unexpected git command: {cmd!r}")

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    with patch("hermes_cli.banner.subprocess.run", side_effect=fake_run) as mock_run:
        result = check_for_updates()

    assert result == 5
    # origin probe + is-shallow probe + git fetch + git rev-list + local-ahead guard
    assert mock_run.call_count == 5


def test_check_for_updates_official_ssh_origin_uses_https_probe(tmp_path):
    """Passive update checks must not trigger SSH auth for official installs."""
    import hermes_cli.banner as banner

    repo_dir = tmp_path / "hermes-agent"
    repo_dir.mkdir()
    (repo_dir / ".git").mkdir()

    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        if cmd == ["git", "remote", "get-url", "origin"]:
            return MagicMock(returncode=0, stdout="git@github.com:SlowGreek/costas-code.git\n")
        if cmd == ["git", "rev-parse", "HEAD"]:
            return MagicMock(returncode=0, stdout="local-sha\n")
        if cmd == [
            "git",
            "ls-remote",
            "https://github.com/SlowGreek/costas-code.git",
            "refs/heads/costas-code",
        ]:
            return MagicMock(
                returncode=0,
                stdout="upstream-sha\trefs/heads/costas-code\n",
            )
        if cmd[:3] == ["git", "merge-base", "--is-ancestor"]:
            # Upstream added a local-ahead check to the SSH fast path: when the
            # tips differ it asks whether the remote tip is an ancestor of HEAD
            # (ahead, not behind). returncode=1 => genuinely behind, which is
            # what this test is asserting.
            return MagicMock(returncode=1, stdout="")
        raise AssertionError(f"unexpected git command: {cmd!r}")

    with patch("hermes_cli.banner.subprocess.run", side_effect=fake_run):
        result = banner._check_via_local_git(repo_dir)

    # Upstream replaced the fabricated "1" with an honest no-count sentinel:
    # the SSH fast path knows the tips differ but cannot count without the
    # compare API (unreachable under this fake), and inventing "1 commit
    # behind" was the bug. Fork adopts that contract.
    assert result == banner.UPDATE_AVAILABLE_NO_COUNT
    assert [
        "git",
        "fetch",
        "origin",
        "+refs/heads/costas-code:refs/remotes/origin/costas-code",
        "--quiet",
    ] not in calls


def test_check_via_local_git_shallow_clone_behind_reports_no_count(tmp_path):
    """Shallow installer clones must report presence-only, never a bogus count.

    On a ``git clone --depth 1`` checkout the history stops at one commit, so
    counting ``HEAD..origin/costas-code`` across the shallow boundary yields a huge
    nonsense number (the "12492 commits behind" banner). The shallow path must
    compare tip SHAs and return UPDATE_AVAILABLE_NO_COUNT instead, and must
    never run ``git rev-list --count``.
    """
    import hermes_cli.banner as banner

    repo_dir = tmp_path / "hermes-agent"
    repo_dir.mkdir()
    (repo_dir / ".git").mkdir()

    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        if cmd == ["git", "remote", "get-url", "origin"]:
            return MagicMock(returncode=0, stdout="https://github.com/SlowGreek/costas-code.git\n")
        if cmd == ["git", "rev-parse", "--is-shallow-repository"]:
            return MagicMock(returncode=0, stdout="true\n")
        if cmd[:2] == ["git", "fetch"]:
            return MagicMock(returncode=0, stdout="")
        if cmd == ["git", "rev-parse", "HEAD"]:
            return MagicMock(returncode=0, stdout="local-sha\n")
        if cmd == ["git", "rev-parse", "FETCH_HEAD"]:
            return MagicMock(returncode=0, stdout="upstream-sha\n")
        if cmd[:3] == ["git", "rev-list", "--count"]:
            raise AssertionError("shallow path must not count across the boundary")
        if cmd[:3] == ["git", "merge-base", "--is-ancestor"]:
            # Upstream added a local-ahead check to the SSH fast path: when the
            # tips differ it asks whether the remote tip is an ancestor of HEAD
            # (ahead, not behind). returncode=1 => genuinely behind, which is
            # what this test is asserting.
            return MagicMock(returncode=1, stdout="")
        raise AssertionError(f"unexpected git command: {cmd!r}")

    with patch("hermes_cli.banner.subprocess.run", side_effect=fake_run):
        result = banner._check_via_local_git(repo_dir)

    assert result == banner.UPDATE_AVAILABLE_NO_COUNT
    # The shallow fetch must preserve the boundary (--depth 1), not unshallow,
    # and must stay scoped to the update branch (unscoped fetches transfer
    # ~1,400 heads).
    assert [
        "git",
        "fetch",
        "origin",
        "+refs/heads/costas-code:refs/remotes/origin/costas-code",
        "--depth",
        "1",
        "--quiet",
    ] in calls


def test_check_via_local_git_shallow_clone_up_to_date(tmp_path):
    """Shallow clone whose tip matches upstream reports up-to-date (0)."""
    import hermes_cli.banner as banner

    repo_dir = tmp_path / "hermes-agent"
    repo_dir.mkdir()
    (repo_dir / ".git").mkdir()

    def fake_run(cmd, **kwargs):
        if cmd == ["git", "remote", "get-url", "origin"]:
            return MagicMock(returncode=0, stdout="https://github.com/SlowGreek/costas-code.git\n")
        if cmd == ["git", "rev-parse", "--is-shallow-repository"]:
            return MagicMock(returncode=0, stdout="true\n")
        if cmd[:2] == ["git", "fetch"]:
            return MagicMock(returncode=0, stdout="")
        if cmd == ["git", "rev-parse", "HEAD"]:
            return MagicMock(returncode=0, stdout="same-sha\n")
        if cmd == ["git", "rev-parse", "FETCH_HEAD"]:
            return MagicMock(returncode=0, stdout="same-sha\n")
        if cmd[:3] == ["git", "merge-base", "--is-ancestor"]:
            # Upstream added a local-ahead check to the SSH fast path: when the
            # tips differ it asks whether the remote tip is an ancestor of HEAD
            # (ahead, not behind). returncode=1 => genuinely behind, which is
            # what this test is asserting.
            return MagicMock(returncode=1, stdout="")
        raise AssertionError(f"unexpected git command: {cmd!r}")

    with patch("hermes_cli.banner.subprocess.run", side_effect=fake_run):
        result = banner._check_via_local_git(repo_dir)

    assert result == 0


def test_check_via_local_git_full_clone_keeps_exact_count(tmp_path):
    """Full (non-shallow) clones keep the exact rev-list count path."""
    import hermes_cli.banner as banner

    repo_dir = tmp_path / "hermes-agent"
    repo_dir.mkdir()
    (repo_dir / ".git").mkdir()

    def fake_run(cmd, **kwargs):
        if cmd == ["git", "remote", "get-url", "origin"]:
            return MagicMock(returncode=0, stdout="https://github.com/SlowGreek/costas-code.git\n")
        if cmd == ["git", "rev-parse", "--is-shallow-repository"]:
            return MagicMock(returncode=0, stdout="false\n")
        if cmd[:2] == ["git", "fetch"]:
            return MagicMock(returncode=0, stdout="")
        if cmd[:3] == ["git", "rev-list", "--count"]:
            return MagicMock(returncode=0, stdout="7\n")
        if cmd[:3] == ["git", "merge-base", "--is-ancestor"]:
            # Upstream added a local-ahead check to the SSH fast path: when the
            # tips differ it asks whether the remote tip is an ancestor of HEAD
            # (ahead, not behind). returncode=1 => genuinely behind, which is
            # what this test is asserting.
            return MagicMock(returncode=1, stdout="")
        raise AssertionError(f"unexpected git command: {cmd!r}")

    with patch("hermes_cli.banner.subprocess.run", side_effect=fake_run):
        result = banner._check_via_local_git(repo_dir)

    assert result == 7


def test_check_for_updates_no_git_dir(tmp_path, monkeypatch):
    """Returns None when .git directory doesn't exist anywhere (no source tree)."""
    import hermes_cli.banner as banner

    # Create a fake banner.py so the fallback path also has no .git
    fake_banner = tmp_path / "hermes_cli" / "banner.py"
    fake_banner.parent.mkdir(parents=True, exist_ok=True)
    fake_banner.touch()

    monkeypatch.setattr(banner, "__file__", str(fake_banner))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    with patch("hermes_cli.banner.subprocess.run") as mock_run:
        result = banner.check_for_updates()
    assert result is None
    mock_run.assert_not_called()


def test_check_for_updates_fallback_to_project_root(tmp_path, monkeypatch):
    """Dev install: falls back to Path(__file__).parent.parent when HERMES_HOME has no git repo."""
    import hermes_cli.banner as banner

    project_root = Path(banner.__file__).parent.parent.resolve()
    if not (project_root / ".git").exists():
        pytest.skip("Not running from a git checkout")

    # Point HERMES_HOME at a temp dir with no hermes-agent/.git
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    with patch("hermes_cli.banner.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stdout="0\n")
        result = banner.check_for_updates()
    # Should have fallen back to project root and run git commands
    assert mock_run.call_count >= 1


def test_check_for_updates_docker_returns_none(tmp_path, monkeypatch):
    """Inside the Docker image, check_for_updates() must short-circuit to None.

    Regression: the published image excludes .git (.dockerignore) and sets no
    HERMES_REVISION (nix-only), so without a docker guard check_for_updates()
    would fall through and try to probe a non-existent git checkout. The guard
    must return None (so the > 0 render guards stay false) AND not reach the
    git probe or write a cache entry.
    """
    import hermes_cli.banner as banner

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    cache_file = tmp_path / ".update_check"

    with patch("hermes_cli.config.detect_install_method", return_value="docker"), \
         patch("hermes_cli.banner.subprocess.run") as mock_run:
        result = banner.check_for_updates()

    assert result is None
    # The git probe should not have run.
    mock_run.assert_not_called()
    # And no phantom "behind" count should be cached for the next 6h.
    assert not cache_file.exists()


def test_prefetch_non_blocking():
    """prefetch_update_check() should return immediately without blocking."""
    import hermes_cli.banner as banner

    # Reset module state
    banner._update_result = None
    banner._update_check_done = threading.Event()

    with patch.object(banner, "check_for_updates", return_value=5):
        start = time.monotonic()
        banner.prefetch_update_check()
        elapsed = time.monotonic() - start

        # Should return almost immediately (well under 1 second)
        assert elapsed < 1.0

        # Wait for the background thread to finish
        banner._update_check_done.wait(timeout=5)
        assert banner._update_result == 5


def test_check_via_local_git_fetch_failure_returns_none(tmp_path, monkeypatch):
    """When git fetch fails and the stale origin/main ref is not ahead,
    _check_via_local_git must return None (#82166).

    A stale tracking ref cannot prove *currentness* (rev-list 0 just means
    the ref hasn't caught up), so returning None is the honest inconclusive
    result — and the caller must not cache it as "up to date".
    """
    from hermes_cli import banner

    repo_dir = tmp_path / "hermes-agent"
    repo_dir.mkdir()
    (repo_dir / ".git").mkdir()

    # Simulate a non-shallow, non-SSH-remote checkout
    def mock_git_stdout(args, *, cwd, timeout=5):
        if args[:2] == ["remote", "get-url"]:
            return "https://github.com/NousResearch/hermes-agent.git"
        if args[:2] == ["rev-parse", "--is-shallow-repository"]:
            return "false"
        return None

    # Fetch fails (returncode != 0); stale rev-list reports 0 behind
    failed_proc = MagicMock()
    failed_proc.returncode = 1
    failed_proc.stdout = ""
    failed_proc.stderr = "fatal: could not reach remote"

    stale_zero_proc = MagicMock()
    stale_zero_proc.returncode = 0
    stale_zero_proc.stdout = "0"

    def mock_run(args, **kwargs):
        if args[:2] == ["git", "fetch"]:
            return failed_proc
        if args[:2] == ["git", "rev-list"]:
            return stale_zero_proc
        raise AssertionError(f"unexpected subprocess.run: {args}")

    monkeypatch.setattr(banner, "_git_stdout", mock_git_stdout)
    monkeypatch.setattr(banner.subprocess, "run", mock_run)

    result = banner._check_via_local_git(repo_dir)
    assert result is None, (
        "Fetch failure with stale 0-behind must return None, not 'up to date'"
    )


def test_check_via_local_git_fetch_failure_keeps_positive_stale_count(tmp_path, monkeypatch):
    """A failed fetch must preserve sound evidence: if the stale origin/main
    ref already shows HEAD behind, that positive count is still an update
    signal and must be returned (review #92578)."""
    from hermes_cli import banner

    repo_dir = tmp_path / "hermes-agent"
    repo_dir.mkdir()
    (repo_dir / ".git").mkdir()

    def mock_git_stdout(args, *, cwd, timeout=5):
        if args[:2] == ["remote", "get-url"]:
            return "https://github.com/NousResearch/hermes-agent.git"
        if args[:2] == ["rev-parse", "--is-shallow-repository"]:
            return "false"
        return None

    failed_proc = MagicMock()
    failed_proc.returncode = 1
    failed_proc.stdout = ""
    failed_proc.stderr = "fatal: could not reach remote"

    stale_behind_proc = MagicMock()
    stale_behind_proc.returncode = 0
    stale_behind_proc.stdout = "5"

    def mock_run(args, **kwargs):
        if args[:2] == ["git", "fetch"]:
            return failed_proc
        if args[:2] == ["git", "rev-list"]:
            return stale_behind_proc
        raise AssertionError(f"unexpected subprocess.run: {args}")

    monkeypatch.setattr(banner, "_git_stdout", mock_git_stdout)
    monkeypatch.setattr(banner.subprocess, "run", mock_run)

    result = banner._check_via_local_git(repo_dir)
    assert result == 5, "Stale positive behind-count must be preserved on fetch failure"


def test_check_via_local_git_fetch_failure_rev_list_error_returns_none(tmp_path, monkeypatch):
    """If the stale rev-list itself fails, the check stays inconclusive (None)."""
    from hermes_cli import banner

    repo_dir = tmp_path / "hermes-agent"
    repo_dir.mkdir()
    (repo_dir / ".git").mkdir()

    def mock_git_stdout(args, *, cwd, timeout=5):
        if args[:2] == ["remote", "get-url"]:
            return "https://github.com/NousResearch/hermes-agent.git"
        if args[:2] == ["rev-parse", "--is-shallow-repository"]:
            return "false"
        return None

    failed_proc = MagicMock()
    failed_proc.returncode = 1
    failed_proc.stdout = ""
    failed_proc.stderr = "fatal: could not reach remote"

    bad_rev_list = MagicMock()
    bad_rev_list.returncode = 128
    bad_rev_list.stdout = ""
    bad_rev_list.stderr = "fatal: ambiguous argument 'HEAD..origin/main'"

    def mock_run(args, **kwargs):
        if args[:2] == ["git", "fetch"]:
            return failed_proc
        if args[:2] == ["git", "rev-list"]:
            return bad_rev_list
        raise AssertionError(f"unexpected subprocess.run: {args}")

    monkeypatch.setattr(banner, "_git_stdout", mock_git_stdout)
    monkeypatch.setattr(banner.subprocess, "run", mock_run)

    result = banner._check_via_local_git(repo_dir)
    assert result is None


def test_check_for_updates_does_not_cache_none(tmp_path, monkeypatch):
    """check_for_updates must not cache None results so a transient fetch
    failure doesn't suppress retries for the full 6-hour cache window (#82166).

    Instead of mocking the full Path resolution chain, we verify the cache-write
    guard directly: call check_for_updates with a mocked _check_via_local_git
    that returns None, and confirm no cache file is created.
    """
    import hermes_cli.banner as banner

    cache_file = tmp_path / ".update_check"
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("HERMES_REVISION", raising=False)

    # Create a fake repo dir so the .git check passes
    repo_dir = tmp_path / "hermes-agent"
    repo_dir.mkdir()
    (repo_dir / ".git").mkdir()

    # Mock the internal functions to force the local-git path returning None
    monkeypatch.setattr(banner, "_check_via_local_git", lambda rd: None)
    monkeypatch.setattr(
        "hermes_cli.config.detect_install_method", lambda root: "git"
    )
    monkeypatch.setattr(
        "hermes_cli.config.get_project_root", lambda: repo_dir
    )

    # Patch __file__ resolution by monkeypatching the module's Path calls.
    # check_for_updates does: Path(__file__).parent.parent.resolve()
    # We intercept by making the resolve() return our fake repo_dir.
    original_init = Path.__init__

    def patched_path_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)

    # Simpler: just patch the get_hermes_home and the repo_dir resolution
    # by making check_for_updates find our fake repo via hermes_home fallback.
    # The code checks Path(__file__).parent.parent/.git first, then falls
    # back to hermes_home / "hermes-agent". We ensure the fallback hits.
    # To do this, we make Path(__file__).parent.parent.resolve() return
    # a path without .git, so it falls through to hermes_home / "hermes-agent".
    real_resolve = Path.resolve

    def fake_resolve(self, *args, **kwargs):
        s = str(self)
        if "banner.py" in s or s.endswith("hermes_cli"):
            # Return a path that has no .git, forcing the fallback
            return tmp_path / "no-git-here"
        return real_resolve(self, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", fake_resolve)

    result = banner.check_for_updates()
    assert result is None

    # The cache file must NOT have been written with a None result
    assert not cache_file.exists(), "None result must not be cached"





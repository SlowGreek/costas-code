from unittest.mock import MagicMock, patch


def test_format_banner_version_label_without_git_state():
    from hermes_cli import banner

    with patch.object(banner, "get_git_banner_state", return_value=None):
        value = banner.format_banner_version_label()

    assert value == f"Catalyst v{banner.VERSION} ({banner.RELEASE_DATE})"


def test_format_banner_version_label_on_upstream_main():
    from hermes_cli import banner

    with patch.object(
        banner,
        "get_git_banner_state",
        return_value={"upstream": "b2f477a3", "local": "b2f477a3", "ahead": 0},
    ):
        value = banner.format_banner_version_label()

    assert value.endswith("· upstream b2f477a3")
    assert "local" not in value


def test_get_git_banner_state_reads_origin_and_head(tmp_path):
    from hermes_cli import banner

    repo_dir = tmp_path / "repo"
    (repo_dir / ".git").mkdir(parents=True)

    results = {
        ("git", "rev-parse", "--short=8", "origin/costas-code"): MagicMock(returncode=0, stdout="b2f477a3\n"),
        ("git", "rev-parse", "--short=8", "HEAD"): MagicMock(returncode=0, stdout="af8aad31\n"),
        ("git", "rev-list", "--count", "origin/costas-code..HEAD"): MagicMock(returncode=0, stdout="3\n"),
    }

    def fake_run(cmd, **kwargs):
        key = tuple(cmd)
        if key not in results:
            raise AssertionError(f"unexpected command: {cmd}")
        return results[key]

    with patch("hermes_cli.banner.subprocess.run", side_effect=fake_run):
        state = banner.get_git_banner_state(repo_dir)

    assert state == {"upstream": "b2f477a3", "local": "af8aad31", "ahead": 3}


def test_check_via_local_git_ssh_fastpath_ahead_not_behind(tmp_path):
    """SSH fast path must not report an ahead (carried) HEAD as behind.

    A carried local commit means tip SHAs differ, but the fresh upstream tip
    is an ancestor of HEAD — that is "ahead", and reporting it as behind
    nudges the user into `hermes update`, which can wipe the carried work.
    """
    from hermes_cli import banner

    from unittest.mock import MagicMock

    banner._git_banner_state_cache = None

    with patch.object(banner, "_resolve_repo_dir", return_value=None), \
         patch("hermes_cli.build_info.get_build_sha", return_value="abcdef12"):
        state = banner.get_git_banner_state()

    assert state == {"upstream": "abcdef12", "local": "abcdef12", "ahead": 0}


def test_get_git_banner_state_returns_none_when_no_repo_and_no_build_sha():
    """Pip-installed wheel with neither git checkout nor baked SHA → None.

    Banner correctly omits the upstream/local suffix in this case.
    """
    from hermes_cli import banner

    banner._git_banner_state_cache = None

    with patch.object(banner, "_resolve_repo_dir", return_value=None), \
         patch("hermes_cli.build_info.get_build_sha", return_value=None):
        state = banner.get_git_banner_state()

    assert state is None


def test_get_git_banner_state_falls_back_when_live_git_returns_nothing(tmp_path):
    """Shallow clone without origin/costas-code still surfaces the build SHA.

    Some install paths (e.g. ``git clone --depth 1`` without a remote) have
    a ``.git`` directory but ``git rev-parse origin/costas-code`` fails. When that
    happens AND a baked SHA exists, return the baked one instead of None.
    """
    from hermes_cli import banner

    repo_dir = tmp_path / "repo"
    (repo_dir / ".git").mkdir(parents=True)

    def fake_git_stdout(args, *, cwd, timeout=5, network=False):
        if args == ["remote", "get-url", "origin"]:
            # Fork: the SSH fast path only engages for the fork's OWN
            # official remote. Deriving it from the module constant keeps
            # this test exercising the fast path instead of silently
            # falling through the non-official early return.
            return f"git@github.com:{banner._OFFICIAL_REPO_CANONICAL.split('github.com/', 1)[-1]}.git"
        if args == ["rev-parse", "HEAD"]:
            return "b" * 40  # carried commit, differs from upstream tip
        raise AssertionError(f"unexpected git call: {args}")

    with (
        patch.object(banner, "_git_stdout", side_effect=fake_git_stdout),
        patch.object(banner, "_upstream_main_sha", return_value="a" * 40),
        # merge-base --is-ancestor exits 0: upstream tip IS an ancestor of HEAD
        patch.object(banner.subprocess, "run", return_value=MagicMock(returncode=0)),
    ):
        behind = banner._check_via_local_git(repo_dir)

    assert behind == 0


def test_check_via_local_git_ssh_fastpath_genuinely_behind(tmp_path):
    """SSH fast path reports the exact count (compare API) when behind."""
    from unittest.mock import MagicMock

    from hermes_cli import banner

    repo_dir = tmp_path / "repo"
    (repo_dir / ".git").mkdir(parents=True)

    def fake_git_stdout(args, *, cwd, timeout=5, network=False):
        if args == ["remote", "get-url", "origin"]:
            # Fork: the SSH fast path only engages for the fork's OWN
            # official remote. Deriving it from the module constant keeps
            # this test exercising the fast path instead of silently
            # falling through the non-official early return.
            return f"git@github.com:{banner._OFFICIAL_REPO_CANONICAL.split('github.com/', 1)[-1]}.git"
        if args == ["rev-parse", "HEAD"]:
            return "b" * 40
        raise AssertionError(f"unexpected git call: {args}")

    with (
        patch.object(banner, "_git_stdout", side_effect=fake_git_stdout),
        patch.object(banner, "_upstream_main_sha", return_value="a" * 40),
        # merge-base --is-ancestor exits 1: not an ancestor -> genuinely behind
        patch.object(banner.subprocess, "run", return_value=MagicMock(returncode=1)),
        patch.object(banner, "_github_compare_behind", return_value=3),
    ):
        behind = banner._check_via_local_git(repo_dir)

    assert behind == 3


def test_check_via_local_git_ssh_fastpath_offline_keeps_sentinel(tmp_path):
    """Behind + compare API unreachable = honest no-count sentinel, never 1."""
    from unittest.mock import MagicMock

    from hermes_cli import banner

    repo_dir = tmp_path / "repo"
    (repo_dir / ".git").mkdir(parents=True)

    def fake_git_stdout(args, *, cwd, timeout=5, network=False):
        if args == ["remote", "get-url", "origin"]:
            # Fork: the SSH fast path only engages for the fork's OWN
            # official remote. Deriving it from the module constant keeps
            # this test exercising the fast path instead of silently
            # falling through the non-official early return.
            return f"git@github.com:{banner._OFFICIAL_REPO_CANONICAL.split('github.com/', 1)[-1]}.git"
        if args == ["rev-parse", "HEAD"]:
            return "b" * 40
        raise AssertionError(f"unexpected git call: {args}")

    with (
        patch.object(banner, "_git_stdout", side_effect=fake_git_stdout),
        patch.object(banner, "_upstream_main_sha", return_value="a" * 40),
        patch.object(banner.subprocess, "run", return_value=MagicMock(returncode=1)),
        patch.object(banner, "_github_compare_behind", return_value=None),
    ):
        behind = banner._check_via_local_git(repo_dir)

    assert behind == banner.UPDATE_AVAILABLE_NO_COUNT


def test_check_via_local_git_insteadof_rewrite_routes_to_ssh_fastpath(tmp_path, monkeypatch):
    """#104591: the origin-URL probe must run under the fetch's config-isolated env.

    A global ``url.<https>.insteadOf`` rewrite makes a plain ``git remote get-url origin``
    report HTTPS for an SSH origin, so the SSH-avoiding fast path is skipped — while the
    fetch itself drops global config (``GIT_CONFIG_GLOBAL=/dev/null``), dials the raw SSH
    origin, and its host-key prompt opens /dev/tty and steals the CLI's keystrokes. With the
    probe under the same isolated env both sides observe the raw SSH URL and the HTTPS
    ls-remote fast path runs instead — no fetch, no ssh child.
    """
    import os
    import subprocess

    from hermes_cli import banner

    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    # Config-isolated setup so the developer's own global git config can't leak in.
    setup_env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull}
    setup_cmds = [
        ["git", "init", "-q"],
        # Pinned identity: with global/system config nulled, CI runners whose bare
        # hostname makes git's auto-detected ident "user@host.(none)" reject the commit.
        ["git", "-c", "user.email=t@t", "-c", "user.name=t",
         "commit", "--allow-empty", "-q", "-m", "init"],
        ["git", "remote", "add", "origin", "git@github.com:NousResearch/hermes-agent.git"],
        ["git", "rev-parse", "HEAD"],
    ]
    head_sha = None
    for argv in setup_cmds:
        done = subprocess.run(
            argv, cwd=repo_dir, env=setup_env, check=True, capture_output=True, text=True)
        if argv[1] == "rev-parse":
            head_sha = done.stdout.strip()
    assert head_sha

    # Global config (visible only without GIT_CONFIG_GLOBAL isolation) rewrites SSH to HTTPS.
    home = tmp_path / "home"
    home.mkdir()
    (home / ".gitconfig").write_text(
        '[url "https://github.com/"]\n\tinsteadOf = git@github.com:\n', encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))  # Git for Windows resolves global config here too

    calls = []
    real_run = banner.subprocess.run

    def spy_run(args, **kwargs):
        calls.append((list(args), kwargs))
        if args[1] == "ls-remote":
            return MagicMock(returncode=0, stdout=f"{head_sha}\trefs/heads/main\n")
        if args[1] == "fetch":
            return MagicMock(returncode=1, stdout="")
        return real_run(args, **kwargs)

    monkeypatch.setattr(banner.subprocess, "run", spy_run)

    behind = banner._check_via_local_git(repo_dir)

    # Same upstream tip as HEAD: the SSH fast path concludes "not behind".
    assert behind == 0
    assert not any(args[1] == "fetch" for args, _ in calls), (
        "insteadOf rewrite must not smuggle the check into the fetch branch")
    probe = next(
        (kwargs for args, kwargs in calls if args[1:3] == ["remote", "get-url"]), None)
    assert probe is not None
    assert probe["env"]["GIT_CONFIG_GLOBAL"] == os.devnull, (
        "the origin-URL probe must observe the URL the isolated fetch will dial")

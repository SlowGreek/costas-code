"""macOS desktop update handoff behavior against disposable app bundles."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
POSIX_HANDOFF = REPO_ROOT / "scripts" / "desktop-update" / "posix.sh"
EXPECTED_COMMIT = "a" * 40


def _bundle(root: Path, name: str, marker: str, commit: str = EXPECTED_COMMIT) -> Path:
    bundle = root / name
    resources = bundle / "Contents" / "Resources"
    resources.mkdir(parents=True)
    (resources / "marker.txt").write_text(marker)
    (resources / "install-stamp.json").write_text(
        '{"schemaVersion":1,"commit":"' + commit + '"}\n'
    )
    return bundle


def _run_swap(install_root: Path, installed: Path) -> subprocess.CompletedProcess[str]:
    args = [
        "/bin/bash",
        str(POSIX_HANDOFF),
        "--install-root",
        str(install_root),
        "--relaunch-target",
        str(installed),
        "--expected-commit",
        EXPECTED_COMMIT,
        "--no-ui",
        "--self-test-mac-swap",
    ]

    return subprocess.run(args, capture_output=True, check=True, text=True, timeout=30)


@pytest.mark.macos_only
def test_old_mac_handoff_discovers_a_rebuilt_catalyst_bundle(tmp_path: Path) -> None:
    """An old updater must discover a product name that did not exist when it shipped."""
    install_root = tmp_path / "hermes-agent"
    rebuilt_root = install_root / "apps" / "desktop" / "release" / "mac-arm64"
    rebuilt = _bundle(rebuilt_root, "Catalyst.app", "new")
    installed = _bundle(tmp_path / "Applications", "Costas Code.app", "old", "1" * 40)

    _run_swap(install_root, installed)

    assert (installed / "Contents" / "Resources" / "marker.txt").read_text() == "new"
    assert rebuilt.exists(), "the release artifact remains available after staging"


@pytest.mark.macos_only
def test_mac_swap_is_idempotent_when_installed_stamp_already_matches(tmp_path: Path) -> None:
    install_root = tmp_path / "hermes-agent"
    rebuilt_root = install_root / "apps" / "desktop" / "release" / "mac-arm64"
    _bundle(rebuilt_root, "Catalyst.app", "new")
    installed = _bundle(tmp_path / "Applications", "Catalyst.app", "current")
    preserved = installed / "Contents" / "Resources" / "preserved.txt"
    preserved.write_text("keep")

    _run_swap(install_root, installed)

    assert preserved.read_text() == "keep"
    assert (installed / "Contents" / "Resources" / "marker.txt").read_text() == "current"


@pytest.mark.macos_only
def test_old_mac_handoff_prefers_a_fresh_renamed_bundle_over_stale_same_name_output(
    tmp_path: Path,
) -> None:
    install_root = tmp_path / "hermes-agent"
    rebuilt_root = install_root / "apps" / "desktop" / "release" / "mac-arm64"
    stale = _bundle(rebuilt_root, "Costas Code.app", "stale")
    fresh = _bundle(rebuilt_root, "Catalyst.app", "new")
    installed = _bundle(tmp_path / "Applications", "Costas Code.app", "old", "1" * 40)
    os.utime(stale, (1_000, 1_000))
    os.utime(fresh, (2_000, 2_000))

    _run_swap(install_root, installed)

    assert (installed / "Contents" / "Resources" / "marker.txt").read_text() == "new"


@pytest.mark.macos_only
def test_future_mtime_bundle_with_wrong_install_stamp_is_rejected(tmp_path: Path) -> None:
    install_root = tmp_path / "hermes-agent"
    rebuilt_root = install_root / "apps" / "desktop" / "release" / "mac-arm64"
    genuine = _bundle(rebuilt_root, "Catalyst.app", "new")
    unrelated = _bundle(rebuilt_root, "Unrelated.app", "hostile", "b" * 40)
    installed = _bundle(tmp_path / "Applications", "Catalyst.app", "old", "1" * 40)
    os.utime(genuine, (1_000, 1_000))
    os.utime(unrelated, (3_000, 3_000))

    _run_swap(install_root, installed)

    assert (installed / "Contents" / "Resources" / "marker.txt").read_text() == "new"


@pytest.mark.macos_only
def test_mac_handoff_reports_when_no_rebuilt_bundle_exists(tmp_path: Path) -> None:
    install_root = tmp_path / "hermes-agent"
    installed = _bundle(tmp_path / "Applications", "Catalyst.app", "old", "1" * 40)

    result = _run_swap(install_root, installed)

    assert (installed / "Contents" / "Resources" / "marker.txt").read_text() == "old"
    assert "no rebuilt app bundle was found" in result.stdout.lower()

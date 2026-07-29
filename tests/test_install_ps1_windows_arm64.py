"""Regression: Windows ARM64 must fail fast with a truthful explanation.

Field report (Microsoft-issued Windows-on-ARM laptop, 2026-07): the
`dependencies` stage cascaded through all four install tiers and ended with
"Failed to install hermes-agent package even with no extras" — which reads
like a Hermes bug. The real cause is upstream and unfixable from here:

    Python reports platform: win-arm64
    Computed rustc target triple: aarch64-pc-windows-msvc
    ...
    error: failed to run custom build command for `openssl-sys`

`cryptography==46.0.7` publishes NO win_arm64 wheel (46.0.3 was the last one
that did, and it sits below our CVE floor), so uv falls back to a source build
needing a Rust toolchain plus a full OpenSSL dev environment.

Rather than cascade through four tiers and blame the package index, the
dependency stage must detect ARM64 up front and say so plainly.

These tests assert BEHAVIOUR of the guard, not the presence of the substring
"arm64" — the script already contains plenty of unrelated arm64 handling
(Node/Git/winget asset selection), so a naive substring check passes
vacuously against a script with no guard at all.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_PS1 = REPO_ROOT / "scripts" / "install.ps1"

# Sentinel emitted by the guard. Naming it here (rather than matching a loose
# "arm64") keeps these tests from passing against the pre-existing arm64
# asset-selection logic, which has nothing to do with this failure mode.
GUARD_FUNC = "Assert-Arm64WheelSupport"


@pytest.fixture(scope="module")
def source() -> str:
    return INSTALL_PS1.read_text(encoding="utf-8")


def test_a_dedicated_arm64_preflight_exists(source: str) -> None:
    assert f"function {GUARD_FUNC}" in source, (
        "install.ps1 has no dedicated ARM64 preflight; the four-tier cascade "
        "will still run and blame the package index"
    )


def test_preflight_runs_before_the_first_dependency_tier(source: str) -> None:
    """Detecting ARM64 after the cascade would not fix the reported symptom."""
    call = re.search(rf"^\s*{GUARD_FUNC}\b", source, re.MULTILINE)
    assert call, f"{GUARD_FUNC} is defined but never invoked"

    first_tier = source.find('Write-Info "Trying tier:')
    assert first_tier != -1, "could not locate the dependency tier cascade"
    assert call.start() < first_tier, (
        "the ARM64 preflight runs after the dependency cascade has started; "
        "the user still sees the confusing four-tier failure first"
    )


def test_preflight_reuses_the_existing_architecture_helper(source: str) -> None:
    """Don't invent a second architecture probe.

    ``Get-WindowsArch`` already handles the emulation edge case where an
    ARM64 machine reports X64 from an emulated x64 PowerShell.
    """
    body = _guard_body(source)
    assert "Get-WindowsArch" in body, (
        "the ARM64 preflight does not use Get-WindowsArch, which already "
        "handles the x64-emulation false negative"
    )


def test_message_names_the_platform_in_plain_language(source: str) -> None:
    body = _guard_body(source)
    assert re.search(r"Windows on ARM|Windows ARM", body), (
        "the ARM64 failure does not name the platform in plain language"
    )


def test_message_explains_missing_prebuilt_wheels(source: str) -> None:
    """Name the real blocker instead of a generic install failure."""
    body = _guard_body(source).lower()
    assert "wheel" in body, (
        "the message should explain that prebuilt wheels are missing for "
        "this CPU architecture"
    )


def test_message_offers_the_x64_workaround(source: str) -> None:
    """An unsupported-platform error must still leave the user a way forward.

    Windows on ARM runs x64 binaries under emulation, so an x64 Python makes
    every existing amd64 wheel apply.
    """
    body = _guard_body(source)
    assert re.search(r"x64|amd64", body, re.IGNORECASE), (
        "the ARM64 message is a dead end; it should point at the x64 "
        "(emulated) Python workaround"
    )


def _guard_body(source: str) -> str:
    """Return the text of the ARM64 guard function."""
    start = source.find(f"function {GUARD_FUNC}")
    if start == -1:
        pytest.fail(f"{GUARD_FUNC} not defined in install.ps1")
    # Walk braces to find the end of the function body.
    depth = 0
    for idx in range(start, len(source)):
        if source[idx] == "{":
            depth += 1
        elif source[idx] == "}":
            depth -= 1
            if depth == 0:
                return source[start : idx + 1]
    pytest.fail(f"{GUARD_FUNC} body is unbalanced")

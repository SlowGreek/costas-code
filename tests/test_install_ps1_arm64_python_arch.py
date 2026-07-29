"""Regression: the Windows installer must pin an x64 CPython on Windows on ARM.

A user installing on an ARM64 Windows box (Snapdragon-class hardware) hit a
dependency stage that failed on every tier::

    Using CPython 3.11.9 interpreter at: ...\\Python311-arm64\\python.exe
    ...
    Python reports platform: win-arm64
    Computed rustc target triple: aarch64-pc-windows-msvc
    x Failed to build `cryptography==46.0.7`
    `-> Call to `maturin.build_wheel` failed (exit code: 1)
    error: could not remove 'rustup-bin' file: Access is denied. (os error 5)

Root cause: ``uv python find 3.11`` matches a *pre-existing* arm64 interpreter,
and PyPI publishes no ``win_arm64`` wheels for several exact-pinned deps
(``cryptography``, ``pywinpty``).  uv falls back to the sdist, whose build
backend is maturin, which needs a Rust toolchain for
``aarch64-pc-windows-msvc``.  The installer then misreports the failure as
"NOT a version problem -- look for a network/proxy block", because it only
validates the interpreter's *version* and never its *architecture*.

The fix routes every uv interpreter request through ``Get-UvPythonRequest``,
which on arm64 asks for ``cpython-<ver>-windows-x86_64``.  The x64 build runs
under Prism emulation and resolves prebuilt ``win_amd64`` wheels for the whole
tree, so no compiler is involved.

These tests execute the real PowerShell functions under ``pwsh`` (preinstalled
on GitHub's Ubuntu runners) rather than asserting on the shape of the source.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

_INSTALL_PS1 = Path(__file__).resolve().parents[1] / "scripts" / "install.ps1"

pytestmark = pytest.mark.skipif(
    shutil.which("pwsh") is None, reason="pwsh (PowerShell 7) not available"
)


@pytest.fixture(scope="module")
def source() -> str:
    return _INSTALL_PS1.read_text(encoding="utf-8")


def _function_body(source: str, name: str) -> str:
    """Return the full text of a PowerShell ``function <name> { ... }`` block."""
    start = source.index(f"function {name}")
    brace = source.index("{", start)
    depth = 0
    for i in range(brace, len(source)):
        if source[i] == "{":
            depth += 1
        elif source[i] == "}":
            depth -= 1
            if depth == 0:
                return source[start : i + 1]
    raise AssertionError(f"unterminated function body for {name}")


def _run_pwsh(tmp_path: Path, script: str) -> str:
    """Execute a PowerShell script under pwsh and return its stdout."""
    path = tmp_path / "probe.ps1"
    path.write_text(script, encoding="utf-8")
    proc = subprocess.run(
        ["pwsh", "-NoProfile", "-NonInteractive", "-File", str(path)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, (
        f"pwsh exited {proc.returncode}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    )
    return proc.stdout


def _harness(source: str, *names: str) -> str:
    """A pwsh preamble that defines the named install.ps1 functions."""
    return "$ErrorActionPreference = 'Continue'\n" + "\n".join(
        _function_body(source, n) for n in names
    )


@pytest.mark.parametrize("version", ["3.11", "3.12", "3.13", "3.10"])
def test_arm64_requests_the_x64_cpython_build(source, tmp_path, version):
    """On arm64 every supported minor version is pinned to the x64 build.

    The fallback versions matter as much as the primary one: falling back to
    3.12 on arm64 reintroduces the exact same missing-wheel failure.
    """
    out = _run_pwsh(
        tmp_path,
        _harness(source, "Get-UvPythonRequest", "Get-WindowsArch")
        + f"\nGet-UvPythonRequest -Version '{version}' -Arch 'arm64'\n",
    )
    assert out.strip() == f"cpython-{version}-windows-x86_64"


@pytest.mark.parametrize("arch", ["x64", "x86"])
def test_non_arm_arches_pass_the_version_through_untouched(source, tmp_path, arch):
    """Native x64/x86 hosts keep uv's default resolution -- no behavior change."""
    out = _run_pwsh(
        tmp_path,
        _harness(source, "Get-UvPythonRequest", "Get-WindowsArch")
        + f"\nGet-UvPythonRequest -Version '3.11' -Arch '{arch}'\n",
    )
    assert out.strip() == "3.11"


def test_arch_defaults_to_the_emulation_invariant_detector(source, tmp_path):
    """Omitting -Arch must consult Get-WindowsArch, not a trusting default.

    Get-WindowsArch deliberately ignores [Environment]::Is64BitOperatingSystem
    because an x64 PowerShell host under Prism reports X64 on an ARM64 machine.
    PROCESSOR_ARCHITEW6432 carries the real OS arch, so a request made with no
    explicit -Arch on such a host must still resolve to arm64 -> x86_64.
    """
    out = _run_pwsh(
        tmp_path,
        _harness(source, "Get-UvPythonRequest", "Get-WindowsArch")
        + "\n$env:PROCESSOR_ARCHITEW6432 = 'ARM64'\n"
        + "Get-UvPythonRequest -Version '3.11'\n",
    )
    assert out.strip() == "cpython-3.11-windows-x86_64"


def test_resolver_probes_uv_with_the_arch_qualified_request(source, tmp_path):
    """Resolve-AvailablePythonVersion must ASK uv for the x64 build on arm64.

    This is the wiring that actually prevents the bug: a correct helper that
    the resolver never calls would still hand `uv python find 3.11` back an
    arm64 interpreter.  We stub $UvCmd and assert on the argv uv really saw,
    while the resolver still reports the bare minor version to its callers.
    """
    recorded = tmp_path / "argv.txt"
    script = (
        _harness(
            source,
            "Get-UvPythonRequest",
            "Get-WindowsArch",
            "Resolve-AvailablePythonVersion",
        )
        + f"""
$env:PROCESSOR_ARCHITEW6432 = 'ARM64'
$PythonVersion = '3.11'
$PythonFallbackVersions = @('3.12', '3.13', '3.10')
function Invoke-UvStub {{
    ($args -join ' ') | Add-Content -LiteralPath '{recorded.as_posix()}'
    return '/fake/path/to/python'
}}
$UvCmd = 'Invoke-UvStub'
Resolve-AvailablePythonVersion
"""
    )
    out = _run_pwsh(tmp_path, script)

    # The resolver's return value stays a bare minor version -- callers compare
    # it against $PythonVersion and log it to the user.
    assert out.strip() == "3.11"

    calls = recorded.read_text(encoding="utf-8").split("\n")
    assert calls[0].strip() == "python find cpython-3.11-windows-x86_64", (
        "the resolver must probe uv with the arch-qualified request on arm64, "
        f"got: {calls[0]!r}"
    )

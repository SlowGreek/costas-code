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


# --------------------------------------------------------------------------
# Assert-Arm64WheelSupport must gate on the INTERPRETER, not the CPU.
#
# The guard added in b28d9f841 correctly diagnosed the missing-wheel problem
# and told the user to "install the x64 build of Python 3.11 and re-run this
# installer" -- but it threw whenever *the machine* was ARM64, so following
# that instruction could never work.  Windows on ARM runs x64 under emulation;
# an x64 CPython reports win-amd64 and resolves every existing amd64 wheel.
# --------------------------------------------------------------------------


def _guard_harness(source: str, *, arch: str, tag: str | None) -> str:
    """Harness for Assert-Arm64WheelSupport with its two seams stubbed.

    Get-PythonPlatformTag is exercised for real against a live interpreter in
    the tests below; here it is stubbed so the guard's *decision* can be driven
    across arches and tags that this runner does not physically have.
    """
    stub_tag = "$null" if tag is None else f"'{tag}'"
    return (
        _harness(source, "Assert-Arm64WheelSupport")
        + f"\nfunction Get-WindowsArch {{ '{arch}' }}\n"
        + f"function Get-PythonPlatformTag {{ param([string]$PythonExe) {stub_tag} }}\n"
        + "try { Assert-Arm64WheelSupport 'C:\\fake\\python.exe'; 'NO-THROW' }\n"
        + "catch { \"THREW: $($_.Exception.Message)\" }\n"
    )


def test_x64_interpreter_on_an_arm64_machine_is_allowed(source, tmp_path):
    """The regression that made the guard's own advice unreachable.

    An ARM64 machine running an x64 (win-amd64) Python is the supported,
    working configuration -- it is what the installer now provisions, and it is
    verifiably able to install cryptography and pywinpty from prebuilt wheels.
    Blocking it turns a working setup into a hard failure.
    """
    out = _run_pwsh(tmp_path, _guard_harness(source, arch="arm64", tag="win-amd64"))
    assert out.strip() == "NO-THROW"


def test_arm64_interpreter_still_fails_fast_with_actionable_guidance(source, tmp_path):
    """The case the guard exists for must keep failing -- and stay diagnostic.

    Without this, uv falls back to an sdist build of cryptography that needs a
    Rust toolchain and OpenSSL, and the four-tier cascade buries the cause
    under "even with no extras", which reads like a Hermes bug.
    """
    out = _run_pwsh(tmp_path, _guard_harness(source, arch="arm64", tag="win-arm64"))
    assert out.startswith("THREW:")
    lowered = out.lower()
    # Name the blocked thing, both culprits, and a way out.
    assert "arm" in lowered
    assert "wheel" in lowered
    assert "cryptography" in lowered and "pywinpty" in lowered
    assert "uv_python" in lowered


def test_an_unprobeable_interpreter_fails_closed(source, tmp_path):
    """A probe that returns nothing must not be read as "not arm64".

    Failing open here would restore the original silent fallthrough into the
    Rust build for exactly the broken environments least able to diagnose it.
    """
    out = _run_pwsh(tmp_path, _guard_harness(source, arch="arm64", tag=None))
    assert out.startswith("THREW:")


@pytest.mark.parametrize("arch", ["x64", "x86"])
def test_non_arm64_machines_are_never_gated(source, tmp_path, arch):
    """Native x64/x86 hosts must not pay for this check at all."""
    out = _run_pwsh(tmp_path, _guard_harness(source, arch=arch, tag="win-arm64"))
    assert out.strip() == "NO-THROW"


def test_platform_tag_matches_what_the_interpreter_itself_reports(source, tmp_path):
    """Get-PythonPlatformTag must return the real wheel tag, not the CPU.

    This is the value pip and uv match wheels against -- the same string
    maturin echoed as "Python reports platform: win-arm64" in the failing log.
    Asserted against the live interpreter running this test, so it stays true
    on any runner arch.
    """
    import sys
    import sysconfig

    out = _run_pwsh(
        tmp_path,
        _harness(source, "Get-PythonPlatformTag")
        + f"\nGet-PythonPlatformTag '{sys.executable}'\n",
    )
    assert out.strip() == sysconfig.get_platform()


def test_platform_tag_is_null_for_a_nonexistent_interpreter(source, tmp_path):
    """A missing path must probe to $null rather than crashing the installer."""
    out = _run_pwsh(
        tmp_path,
        _harness(source, "Get-PythonPlatformTag")
        + "\n$t = Get-PythonPlatformTag 'C:\\definitely\\not\\here\\python.exe'\n"
        + "if ($null -eq $t) { 'NULL' } else { \"GOT: $t\" }\n",
    )
    assert out.strip() == "NULL"

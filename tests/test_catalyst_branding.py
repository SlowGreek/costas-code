"""The product is Catalyst: no user-facing output may name the upstream fork.

Catalyst is a downstream fork of Hermes Agent. Every upstream sync drags in new
user-facing copy that says "Hermes", and it is invisible in review — the strings
are valid Python, the tests pass, and the wrong brand ships. One sync left 134
such strings across 41 modules (setup banners, the uninstaller, update prompts,
auth flows).

These are invariants about the brand, not snapshots of the copy: they assert
that no string a user READS names the upstream product. Rewording a message
never breaks them; reintroducing the brand always does.

Deliberately NOT covered: docstrings, comments, log messages, identifiers,
paths, and env vars. Those are developer-facing, and every compatibility
identifier (``hermes`` command, ``~/.hermes``, ``HERMES_*``,
``com.nousresearch.hermes``, the ``hermes://`` scheme) must keep the old name
forever — rebranding them would break existing installs.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]

# Packages whose output the user actually sees.
SOURCE_DIRS = (
    "hermes_cli",
    "agent",
    "tools",
    "gateway",
    "tui_gateway",
    "cron",
)
EXTRA_FILES = ("cli.py", "run_agent.py")

# Real external things that legitimately keep the Hermes name, plus every
# compatibility identifier that must never be rebranded.
ALLOWED = re.compile(
    r"Hermes Cloud"          # Nous Research's hosted service
    r"|Hermes ?& ?Nous"      # "Hosted Hermes & Nous-trained models"
    r"|Nous-trained"
    r"|hermes-agent"         # install URL / package / repo name
    r"|hermes_agent"         # entry-point group
    r"|HERMES_[A-Z_]+"       # env vars
    r"|~/\.hermes"           # home directory
    r"|\.hermes\b"
    r"|com\.nousresearch\.hermes"  # macOS bundle id
    r"|hermes://"            # URL scheme
    r"|X-Hermes-[A-Za-z-]+"  # wire protocol headers — renaming breaks clients
    r"|'hermes'"             # the unix user / binary in quotes
    r"|`hermes[^`]*`"        # the CLI command in backticks
    r"|\bhermes\b"           # lowercase = the binary, not the brand
)

# Calls whose string arguments are printed or raised to the user.
USER_FACING_CALLS = {"print", "echo", "secho", "warn", "confirm", "prompt"}
ERROR_CALL = re.compile(r"(Error|Exception)$")


def _python_files() -> list[Path]:
    files: list[Path] = []
    for d in SOURCE_DIRS:
        root = REPO_ROOT / d
        if root.is_dir():
            files.extend(sorted(root.rglob("*.py")))
    for name in EXTRA_FILES:
        p = REPO_ROOT / name
        if p.is_file():
            files.append(p)
    return files


def _is_user_facing(node: ast.Call) -> bool:
    name = getattr(node.func, "id", None) or getattr(node.func, "attr", None) or ""
    return name in USER_FACING_CALLS or bool(ERROR_CALL.search(name))


def _offenders(path: Path) -> list[str]:
    """Return 'file:line: text' for every user-facing string naming Hermes."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (SyntaxError, UnicodeDecodeError):
        return []

    found: list[str] = []
    seen: set[int] = set()

    def scan(root: ast.AST) -> None:
        for node in ast.walk(root):
            if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
                continue
            if id(node) in seen or "Hermes" not in node.value:
                continue
            seen.add(id(node))
            if "Hermes" in ALLOWED.sub("", node.value):
                rel = path.relative_to(REPO_ROOT)
                found.append(f"{rel}:{node.lineno}: {node.value.strip()[:100]}")

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            if _is_user_facing(node):
                for arg in list(node.args) + [k.value for k in node.keywords]:
                    scan(arg)
            for kw in node.keywords:
                if kw.arg == "confirmation":
                    scan(kw.value)
    return found


class TestUserFacingCopyIsCatalyst:
    def test_no_printed_or_raised_string_names_the_upstream_product(self):
        offenders: list[str] = []
        for path in _python_files():
            offenders.extend(_offenders(path))

        assert not offenders, (
            f"{len(offenders)} user-facing string(s) still say 'Hermes'. "
            "Rebrand the message to Catalyst, or — if it names something "
            "genuinely external (Hermes Cloud, the hermes binary, ~/.hermes) — "
            "add it to ALLOWED:\n" + "\n".join(offenders[:25])
        )

    def test_the_version_banner_says_catalyst(self):
        """The single most visible string in the product."""
        from hermes_cli import _startup_fast

        src = Path(_startup_fast.__file__).read_text(encoding="utf-8")
        assert "Catalyst v{__version__}" in src or "Catalyst v" in src
        assert "Hermes Agent v" not in src

    @pytest.mark.parametrize(
        "text, expected_flagged",
        [
            # Real regressions the guard must catch.
            ("Hermes is at the active session limit.", True),
            ("Open this URL to authorize Hermes:", True),
            ("Update Hermes to the latest version", True),
            ("Set up Hermes Desktop", True),
            # Legitimate uses it must NOT flag.
            ("Managed by Hermes Cloud", False),
            ("Run `hermes model` to configure", False),
            ("Saved to ~/.hermes/auth.json", False),
            ("Set HERMES_HOME to override", False),
            ("curl -fsSL https://hermes-agent.nousresearch.com/install.sh", False),
            ("Hosted Hermes & Nous-trained models", False),
        ],
    )
    def test_allowlist_separates_the_brand_from_external_names(
        self, text: str, expected_flagged: bool
    ):
        """Guards the guard: too-broad an allowlist would silently pass anything."""
        flagged = "Hermes" in ALLOWED.sub("", text)
        assert flagged is expected_flagged, text

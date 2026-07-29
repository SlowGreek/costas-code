"""``/feedback`` — file a Catalyst bug report on GitHub from the chat.

The friction this removes: hitting a bug mid-session means leaving the app,
finding the repo, opening the issue form, and re-typing context you already
have on screen. By then most people don't bother, and the bug goes unreported.

What gets attached
------------------
Version, platform, Python, the active provider/model, and the last few log
lines — the fields a maintainer asks for anyway. Everything is collected from
the local install; nothing is read from the conversation, because a transcript
is the single most likely place for a user's secrets to be sitting.

Auth uses the ``gh`` CLI rather than a token in config. Catalyst's repo is
private, so a contributor already needs ``gh auth login`` for the install
itself, and reusing it means there is no new credential to store, rotate, or
leak into a log.
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO = "SlowGreek/costas-code"
ISSUES_URL = f"https://github.com/{REPO}/issues"

# Log tail size. Enough to catch a traceback, small enough that nobody has to
# scroll a wall of text to review what they're about to publish.
_LOG_TAIL_LINES = 40


def gh_available() -> bool:
    """True when the GitHub CLI is installed and authenticated."""
    if not shutil.which("gh"):
        return False
    try:
        return (
            subprocess.run(
                ["gh", "auth", "status"],
                capture_output=True,
                timeout=10,
            ).returncode
            == 0
        )
    except (OSError, subprocess.SubprocessError):
        return False


def _run(cmd: List[str], timeout: int = 15) -> str:
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True, encoding="utf-8", errors="replace",
            timeout=timeout,
        )
        return (result.stdout or "").strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def _version() -> str:
    try:
        from hermes_cli import __version__

        return __version__
    except Exception:
        return "unknown"


def _commit() -> str:
    """The exact commit this install is running, so a report is reproducible."""
    try:
        repo_root = Path(__file__).resolve().parent.parent
        sha = _run(["git", "-C", str(repo_root), "rev-parse", "--short", "HEAD"])
        if not sha:
            return "unknown"
        dirty = _run(["git", "-C", str(repo_root), "status", "--porcelain"])
        return f"{sha}-dirty" if dirty else sha
    except Exception:
        return "unknown"


def _active_model() -> str:
    try:
        from hermes_cli.config import load_config

        cfg = load_config() or {}
        model_cfg = cfg.get("model") or {}
        provider = model_cfg.get("provider") or "?"
        name = model_cfg.get("name") or "(provider default)"
        return f"{provider}:{name}"
    except Exception:
        return "unknown"


def _log_tail(lines: int = _LOG_TAIL_LINES) -> str:
    """Last lines of errors.log — where an unhandled exception lands."""
    try:
        from hermes_constants import get_hermes_home

        log_path = get_hermes_home() / "logs" / "errors.log"
        if not log_path.is_file():
            return "(no errors.log)"
        with open(log_path, encoding="utf-8", errors="replace") as fh:
            tail = fh.readlines()[-lines:]
        return "".join(tail).strip() or "(errors.log is empty)"
    except Exception as exc:  # pragma: no cover - diagnostics must not raise
        return f"(could not read errors.log: {exc})"


def collect_diagnostics() -> Dict[str, str]:
    """Environment facts a maintainer would otherwise have to ask for."""
    return {
        "Catalyst version": _version(),
        "Commit": _commit(),
        "Platform": f"{platform.system()} {platform.release()} ({platform.machine()})",
        "Python": sys.version.split()[0],
        "Model": _active_model(),
        "Profile": os.environ.get("HERMES_PROFILE") or "default",
    }


def build_issue_body(description: str, include_logs: bool = True) -> str:
    diagnostics = collect_diagnostics()
    rows = "\n".join(f"| {k} | `{v}` |" for k, v in diagnostics.items())

    body = f"""## What happened

{description.strip()}

## Environment

| | |
| --- | --- |
{rows}
"""

    if include_logs:
        body += f"""
<details>
<summary>Last {_LOG_TAIL_LINES} lines of errors.log</summary>

```
{_log_tail()}
```

</details>
"""

    body += "\n---\n*Filed with `/feedback` from inside Catalyst.*\n"
    return body


def _title_from(description: str) -> str:
    """First line, trimmed to something that reads well in an issue list."""
    first = (description.strip().splitlines() or [""])[0].strip()
    if len(first) > 72:
        first = first[:69].rstrip() + "..."
    return first or "Feedback from Catalyst"


def file_issue(
    description: str,
    *,
    labels: Optional[List[str]] = None,
    include_logs: bool = True,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """Create the issue. Returns ``{ok, url|error, title, body}``.

    ``dry_run`` renders everything without publishing, so a caller can show the
    user exactly what would be posted first — worth doing when the payload
    carries log output.
    """
    description = (description or "").strip()
    if not description:
        return {"ok": False, "error": "Describe the problem: /feedback <what went wrong>"}

    title = _title_from(description)
    body = build_issue_body(description, include_logs=include_logs)

    if dry_run:
        return {"ok": True, "dry_run": True, "title": title, "body": body}

    if not gh_available():
        return {
            "ok": False,
            "error": (
                "GitHub CLI is not available or not authenticated.\n"
                "  Install: https://cli.github.com\n"
                "  Then run: gh auth login\n"
                f"  Or file it by hand: {ISSUES_URL}/new"
            ),
            "title": title,
            "body": body,
        }

    cmd = [
        "gh", "issue", "create",
        "--repo", REPO,
        "--title", title,
        "--body", body,
    ]
    for label in labels or ["bug"]:
        cmd += ["--label", label]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True, encoding="utf-8", errors="replace",
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "error": f"gh issue create failed: {exc}", "title": title}

    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        # A missing label shouldn't cost the user their report — retry bare.
        if "label" in stderr.lower() and labels is not False:
            retry = subprocess.run(
                ["gh", "issue", "create", "--repo", REPO, "--title", title, "--body", body],
                capture_output=True,
                text=True, encoding="utf-8", errors="replace",
                timeout=60,
            )
            if retry.returncode == 0:
                return {"ok": True, "url": (retry.stdout or "").strip(), "title": title}
            stderr = (retry.stderr or "").strip() or stderr
        return {"ok": False, "error": stderr or "gh issue create failed", "title": title}

    return {"ok": True, "url": (result.stdout or "").strip(), "title": title}


def format_result(result: Dict[str, Any]) -> str:
    """Render a result for the CLI / gateway / desktop surfaces."""
    if result.get("dry_run"):
        return (
            f"Would file: {result['title']}\n\n"
            f"{result['body']}\n"
            "Run without --dry-run to publish."
        )
    if result.get("ok"):
        return f"✓ Filed: {result.get('url') or ISSUES_URL}"

    out = f"✗ Could not file the issue.\n{result.get('error', '')}"
    if result.get("body"):
        out += (
            "\n\nYour report (copy it into a new issue):\n"
            "────────────────────────────────────────\n"
            f"{result['title']}\n\n{result['body']}"
        )
    return out

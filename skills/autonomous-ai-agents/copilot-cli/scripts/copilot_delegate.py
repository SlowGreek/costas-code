#!/usr/bin/env python3
"""Run GitHub Copilot CLI noninteractively with bounded permissions."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Mapping, Sequence


SUPPORTED_TOKEN_PREFIXES = ("gho_", "github_pat_", "ghu_")


def ai_credit_limit(value: str) -> str:
    """Require the minimum session limit accepted by Copilot CLI."""
    try:
        credits = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("AI credits must be an integer.") from exc
    if credits < 30:
        raise argparse.ArgumentTypeError("AI credits must be at least 30.")
    return str(credits)


def resolve_command(explicit: str | None = None) -> str:
    """Resolve the Copilot CLI executable without invoking a shell."""
    candidates = (
        explicit,
        os.environ.get("COPILOT_CLI_PATH"),
        shutil.which("copilot"),
    )
    for candidate in candidates:
        if candidate and str(candidate).strip():
            return str(candidate).strip()
    raise FileNotFoundError(
        "GitHub Copilot CLI was not found. Install @github/copilot or set "
        "COPILOT_CLI_PATH."
    )


def supported_token(value: str | None) -> str | None:
    """Return a token only when Copilot accepts its GitHub token type."""
    token = (value or "").strip()
    return token if token.startswith(SUPPORTED_TOKEN_PREFIXES) else None


def token_from_gh_cli() -> str | None:
    """Read a compatible token from GitHub CLI without persisting a copy."""
    gh = shutil.which("gh")
    if not gh:
        return None
    try:
        result = subprocess.run(
            [gh, "auth", "token"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return supported_token(result.stdout)


def build_subprocess_environment(
    base_environment: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Promote existing GitHub OAuth into Copilot's highest-priority variable."""
    environment = dict(base_environment or os.environ)
    if supported_token(environment.get("COPILOT_GITHUB_TOKEN")):
        return environment

    for name in ("GH_TOKEN", "GITHUB_TOKEN"):
        token = supported_token(environment.get(name))
        if token:
            environment["COPILOT_GITHUB_TOKEN"] = token
            return environment

    token = token_from_gh_cli()
    if token:
        environment["COPILOT_GITHUB_TOKEN"] = token
    return environment


def load_prompt(*, prompt: str | None, prompt_file: str | None) -> str:
    """Load exactly one non-empty prompt source."""
    if prompt_file:
        value = Path(prompt_file).expanduser().read_text(encoding="utf-8")
    else:
        value = prompt or ""
    value = value.strip()
    if not value:
        raise ValueError("A non-empty --prompt or --prompt-file is required.")
    return value


def build_command(
    executable: str,
    *,
    workdir: str,
    prompt: str,
    model: str | None = None,
    name: str | None = None,
    resume: str | None = None,
    output_format: str = "text",
    autopilot: bool = False,
    max_autopilot_continues: int | None = None,
    max_ai_credits: str | None = None,
    disable_github_mcp: bool = False,
) -> list[str]:
    """Build the argv used for a bounded noninteractive Copilot run."""
    command = [
        executable,
        "-C",
        workdir,
        "-p",
        prompt,
        "--allow-all-tools",
        "--no-ask-user",
        "--no-auto-update",
        "--no-remote-export",
        "--stream",
        "off",
        "--output-format",
        output_format,
    ]
    if output_format == "text":
        command.append("--silent")
    if model:
        command.extend(("--model", model))
    if resume:
        command.append(f"--resume={resume}")
    elif name:
        command.extend(("--name", name))
    if autopilot:
        command.append("--autopilot")
    if max_autopilot_continues is not None:
        command.extend(("--max-autopilot-continues", str(max_autopilot_continues)))
    if max_ai_credits is not None:
        command.extend(("--max-ai-credits", max_ai_credits))
    if disable_github_mcp:
        command.append("--disable-builtin-mcps")
    return command


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Delegate one noninteractive task to GitHub Copilot CLI."
    )
    parser.add_argument("--workdir", required=True, help="Trusted working directory.")
    prompt_group = parser.add_mutually_exclusive_group(required=True)
    prompt_group.add_argument("--prompt", help="Task prompt.")
    prompt_group.add_argument(
        "--prompt-file", help="UTF-8 file containing the task prompt."
    )
    parser.add_argument("--command", help="Absolute Copilot CLI executable path.")
    parser.add_argument("--model", help="Copilot model ID.")
    session_group = parser.add_mutually_exclusive_group()
    session_group.add_argument("--name", help="Name for a new Copilot session.")
    session_group.add_argument("--resume", help="Existing session ID or exact name.")
    parser.add_argument(
        "--output-format",
        choices=("text", "json"),
        default="text",
        help="Copilot output format.",
    )
    parser.add_argument("--autopilot", action="store_true")
    parser.add_argument("--max-autopilot-continues", type=int)
    parser.add_argument("--max-ai-credits", type=ai_credit_limit)
    parser.add_argument("--disable-github-mcp", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = create_parser().parse_args(argv)
    workdir = Path(args.workdir).expanduser().resolve()
    if not workdir.is_dir():
        print(f"Working directory does not exist: {workdir}", file=sys.stderr)
        return 2

    try:
        executable = resolve_command(args.command)
        prompt = load_prompt(prompt=args.prompt, prompt_file=args.prompt_file)
    except (FileNotFoundError, OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    command = build_command(
        executable,
        workdir=str(workdir),
        prompt=prompt,
        model=args.model,
        name=args.name,
        resume=args.resume,
        output_format=args.output_format,
        autopilot=args.autopilot,
        max_autopilot_continues=args.max_autopilot_continues,
        max_ai_credits=args.max_ai_credits,
        disable_github_mcp=args.disable_github_mcp,
    )
    try:
        environment = build_subprocess_environment()
        return subprocess.run(command, check=False, env=environment).returncode
    except OSError as exc:
        print(f"Could not start GitHub Copilot CLI: {exc}", file=sys.stderr)
        return 126


if __name__ == "__main__":
    raise SystemExit(main())

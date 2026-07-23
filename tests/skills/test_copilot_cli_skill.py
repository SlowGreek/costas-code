"""Behavior tests for the GitHub Copilot CLI delegation skill."""

from __future__ import annotations

import importlib.util
from argparse import ArgumentTypeError
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
SKILL_DIR = REPO_ROOT / "skills" / "autonomous-ai-agents" / "copilot-cli"
RUNNER_PATH = SKILL_DIR / "scripts" / "copilot_delegate.py"

SPEC = importlib.util.spec_from_file_location("copilot_delegate", RUNNER_PATH)
assert SPEC and SPEC.loader
copilot_delegate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(copilot_delegate)


def test_command_keeps_path_and_url_boundaries(tmp_path):
    command = copilot_delegate.build_command(
        "copilot",
        workdir=str(tmp_path),
        prompt="Fix the test.",
        model="gpt-5.4",
        name="test-fix",
    )

    assert command[:5] == ["copilot", "-C", str(tmp_path), "-p", "Fix the test."]
    assert "--allow-all-tools" in command
    assert "--no-ask-user" in command
    assert "--no-remote-export" in command
    assert "--allow-all" not in command
    assert "--allow-all-paths" not in command
    assert "--allow-all-urls" not in command
    assert "--yolo" not in command
    assert command[command.index("--model") + 1] == "gpt-5.4"
    assert command[command.index("--name") + 1] == "test-fix"


def test_resume_replaces_new_session_name(tmp_path):
    command = copilot_delegate.build_command(
        "copilot",
        workdir=str(tmp_path),
        prompt="Continue.",
        name="ignored",
        resume="existing-session",
    )

    assert "--resume=existing-session" in command
    assert "--name" not in command


def test_json_mode_preserves_jsonl_output(tmp_path):
    command = copilot_delegate.build_command(
        "copilot",
        workdir=str(tmp_path),
        prompt="Inspect the repository.",
        output_format="json",
        disable_github_mcp=True,
    )

    assert command[command.index("--output-format") + 1] == "json"
    assert "--silent" not in command
    assert "--disable-builtin-mcps" in command


def test_prompt_file_is_loaded_without_shell_interpolation(tmp_path):
    prompt_path = tmp_path / "prompt.txt"
    prompt_path.write_text("Review $(touch should-not-run).", encoding="utf-8")

    assert (
        copilot_delegate.load_prompt(
            prompt=None,
            prompt_file=str(prompt_path),
        )
        == "Review $(touch should-not-run)."
    )
    assert not (tmp_path / "should-not-run").exists()


def test_auth_environment_promotes_supported_gh_token():
    environment = copilot_delegate.build_subprocess_environment({
        "GH_TOKEN": "gho_example"
    })

    assert environment["COPILOT_GITHUB_TOKEN"] == "gho_example"


def test_auth_environment_does_not_promote_classic_pat(monkeypatch):
    monkeypatch.setattr(copilot_delegate, "token_from_gh_cli", lambda: None)

    environment = copilot_delegate.build_subprocess_environment({
        "GH_TOKEN": "ghp_classic"
    })

    assert "COPILOT_GITHUB_TOKEN" not in environment


def test_main_rejects_missing_workdir(tmp_path):
    result = copilot_delegate.main([
        "--workdir",
        str(tmp_path / "missing"),
        "--prompt",
        "Do work.",
    ])

    assert result == 2


def test_empty_prompt_is_rejected():
    with pytest.raises(ValueError, match="non-empty"):
        copilot_delegate.load_prompt(prompt="  ", prompt_file=None)


def test_credit_limit_matches_copilot_minimum():
    assert copilot_delegate.ai_credit_limit("30") == "30"
    with pytest.raises(ArgumentTypeError, match="at least 30"):
        copilot_delegate.ai_credit_limit("29")

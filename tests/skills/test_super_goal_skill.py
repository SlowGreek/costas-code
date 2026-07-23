"""Contract tests for the Hermes-native Super Goal skill."""

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
SKILL_PATH = (
    REPO_ROOT
    / "skills"
    / "autonomous-ai-agents"
    / "super-goal"
    / "SKILL.md"
)


def _skill_parts() -> tuple[dict, str]:
    content = SKILL_PATH.read_text(encoding="utf-8")
    assert content.startswith("---\n")
    _, frontmatter, body = content.split("---", 2)
    return yaml.safe_load(frontmatter), body


def test_super_goal_is_a_hermes_native_supervision_skill():
    metadata, body = _skill_parts()

    assert metadata["name"] == "super-goal"
    assert metadata["description"].startswith("Use when ")
    assert "delegate_task" in body
    assert "todo" in body
    assert "automatic completion notification" in body
    assert "independently" in body


def test_super_goal_does_not_depend_on_copilot_only_surfaces():
    _, body = _skill_parts()

    for copilot_only_surface in (
        "create_session",
        "get_session",
        "invoke_canvas_action",
        "goalctl.py",
        "read_agent",
        "write_agent",
    ):
        assert copilot_only_surface not in body

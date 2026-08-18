from agent.auxiliary_client import _FAST_MODEL_TASKS
from hermes_cli.config_defaults import DEFAULT_CONFIG
from hermes_cli.main import _AUX_TASKS


def test_ideation_workbench_is_a_configurable_auxiliary_task():
    assert "ideation_workbench" in _FAST_MODEL_TASKS
    assert ("ideation_workbench", "Ideation workbench", "ambient voice-canvas updates") in _AUX_TASKS
    assert DEFAULT_CONFIG["auxiliary"]["ideation_workbench"] == {
        "provider": "auto",
        "model": "",
        "prefer_fast_model": True,
        "base_url": "",
        "api_key": "",
        "timeout": 45,
        "extra_body": {},
        "reasoning_effort": "",
    }

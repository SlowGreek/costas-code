from __future__ import annotations

from gateway.platforms.api_server import APIServerAdapter
from gateway.session_context import clear_session_vars, get_lucid_role


class _Bindings:
    def __init__(self, binding):
        self.binding = binding

    def get_external_role_session_binding(self, session_id: str):
        assert session_id == "session-1"
        return self.binding


def _adapter(binding):
    adapter = object.__new__(APIServerAdapter)
    adapter._ensure_session_db = lambda: _Bindings(binding)
    return adapter


def test_exact_sidekick_binding_projects_request_local_role():
    adapter = _adapter(
        {
            "namespace": "agent-experiments",
            "authority": "observe",
            "version": 1,
            "role": "sidekick",
        }
    )
    role = adapter._lucid_role_for_session("session-1")
    assert role == "SIDEKICK"

    tokens = adapter._bind_api_server_session(
        chat_id="session-1",
        session_key="session-1",
        session_id="session-1",
        lucid_role=role,
    )
    try:
        assert get_lucid_role() == "SIDEKICK"
    finally:
        clear_session_vars(tokens)


def test_unbound_session_preserves_enrolled_default_without_minting_a_role():
    adapter = _adapter(None)
    assert adapter._lucid_role_for_session("session-1") is None


def test_foreign_wrong_authority_and_engineer_bindings_fail_closed():
    cases = [
        {"namespace": "other", "authority": "observe", "version": 1, "role": "sidekick"},
        {
            "namespace": "agent-experiments",
            "authority": "control",
            "version": 1,
            "role": "sidekick",
        },
        {
            "namespace": "agent-experiments",
            "authority": "observe",
            "version": 1,
            "role": "engineer",
        },
    ]
    for binding in cases:
        assert _adapter(binding)._lucid_role_for_session("session-1") == ""


def test_missing_database_and_malformed_session_fail_closed():
    adapter = object.__new__(APIServerAdapter)
    adapter._ensure_session_db = lambda: None
    assert adapter._lucid_role_for_session("session-1") == ""
    assert adapter._lucid_role_for_session("") == ""
    assert adapter._lucid_role_for_session(None) == ""

import json

from tui_gateway import penguin_completion as subject


class _Database:
    def __init__(self, binding=None):
        self.binding = binding

    def get_external_role_session_binding(self, session_id):
        assert session_id == "durable-session"
        return self.binding


def test_durable_sidekick_binding_wins_over_em_default(monkeypatch):
    monkeypatch.setenv("HERMES_LUCID_ROLE", "EM")
    binding = {
        "namespace": "agent-experiments",
        "authority": "observe",
        "version": 1,
        "role": "sidekick",
    }
    assert subject.resolve_role(
        {"session_key": "durable-session"}, _Database(binding)
    ) == "SIDEKICK"


def test_unbound_desktop_session_uses_enrolled_em_default(monkeypatch):
    monkeypatch.setenv("HERMES_LUCID_ROLE", "EM")
    assert subject.resolve_role(
        {"session_key": "durable-session"}, _Database(None)
    ) == "EM"


def test_foreign_binding_fails_closed(monkeypatch):
    monkeypatch.setenv("HERMES_LUCID_ROLE", "EM")
    binding = {
        "namespace": "foreign",
        "authority": "observe",
        "version": 1,
        "role": "sidekick",
    }
    assert subject.resolve_role(
        {"session_key": "durable-session"}, _Database(binding)
    ) == ""


def test_missing_codeword_is_visible_and_never_forged():
    params, status = subject.prepare_request(
        role="EM", output="Work completed with exact evidence.", status="complete"
    )
    assert params is None
    assert status == {
        "schema": "penguin-completion-speech-status/1",
        "status": "refused",
        "code": "codeword-missing",
        "principal": "EM",
        "response_id": None,
        "content_free": True,
    }


def test_exact_role_completion_builds_closed_butler_request():
    output = "Work completed with exact evidence.\n\n🎼🐧"
    params, status = subject.prepare_request(
        role="EM", output=output, status="complete"
    )
    assert status["status"] == "pending"
    assert params == {
        "schema": "response-final/1",
        "source": "direct",
        "response_id": status["response_id"],
        "principal": "EM",
        "codeword_state": "exact",
        "expected_codeword": "🎼🐧",
        "output": output,
    }
    assert params is not None
    assert params["response_id"].startswith("turn:")
    assert len(params["response_id"]) == len("turn:") + 64


def test_submit_projects_only_content_free_accepted_receipt():
    params, _ = subject.prepare_request(
        role="SIDEKICK",
        output="The handoff is ready.\n\n🧭🐧",
        status="complete",
    )
    assert params is not None
    request_params = params

    def exchange(wire):
        request = json.loads(wire)
        assert request["method"] == "butler/response-completed"
        assert request["params"] == request_params
        return json.dumps(
            {
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": {
                    "schema": "response-completion-result/1",
                    "speech": {
                        "status": "accepted",
                        "accepted": True,
                        "code": "speech-accepted",
                        "private": "must-not-project",
                    },
                    "event": {"safe_final_prose": "must-not-project"},
                },
            }
        ).encode()

    assert subject.submit(params, exchange=exchange) == {
        "schema": "penguin-completion-speech-status/1",
        "status": "accepted",
        "code": "speech-accepted",
        "principal": "SIDEKICK",
        "response_id": params["response_id"],
        "content_free": True,
    }


def test_submit_projects_butler_refusal_without_content():
    params, _ = subject.prepare_request(
        role="EM", output="The result is ready.\n\n🎼🐧", status="complete"
    )
    assert params is not None

    def exchange(wire):
        request = json.loads(wire)
        return json.dumps(
            {
                "jsonrpc": "2.0",
                "id": request["id"],
                "error": {"code": -32602, "message": "sensitive detail"},
            }
        ).encode()

    result = subject.submit(params, exchange=exchange)
    assert result["status"] == "refused"
    assert result["code"] == "butler-refused"
    assert "sensitive" not in json.dumps(result)

"""A blocking prompt must be recoverable after its one-shot event is missed.

``clarify.request`` (and its sudo/secret/terminal.read siblings) is emitted
once, at the moment the tool blocks. A desktop window that opens afterwards —
reopened chat, app restart, reconnect that dropped the frame — never saw it, so
its inline card can render the stored question but has no ``request_id`` to
answer with, and the agent stays blocked until ``agent.clarify_timeout``.

``session.resume`` / ``session.activate`` therefore carry ``pending_prompts``
so a client can re-arm. These tests exercise the real ``_block`` bridge on a
worker thread rather than hand-stuffing the module dicts.
"""

import threading

import pytest

from tui_gateway import server


@pytest.fixture(autouse=True)
def _clean_prompt_state():
    with server._prompt_lock:
        server._pending.clear()
        server._pending_prompt_payloads.clear()
        server._answers.clear()
    yield
    with server._prompt_lock:
        server._pending.clear()
        server._pending_prompt_payloads.clear()
        server._answers.clear()


def _block_in_thread(sid: str, payload: dict, event: str = "clarify.request"):
    """Start a real ``_block`` wait on ``sid`` and return (thread, answered)."""
    result: dict = {}

    def run():
        result["answer"] = server._block(event, sid, dict(payload), timeout=10)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    # Wait until the bridge has registered the prompt.
    deadline = threading.Event()
    for _ in range(200):
        if server._session_pending_prompts(sid):
            break
        deadline.wait(0.01)
    return thread, result


def _answer(sid: str) -> str:
    prompts = server._session_pending_prompts(sid)
    assert prompts, "no pending prompt to answer"
    return prompts[0]["payload"]["request_id"]


def test_pending_clarify_is_replayable_while_the_agent_waits(monkeypatch):
    monkeypatch.setattr(server, "_emit", lambda *a, **k: None)

    thread, result = _block_in_thread("sid-1", {"question": "Ship it?", "choices": ["yes", "no"]})

    prompts = server._session_pending_prompts("sid-1")
    assert len(prompts) == 1
    assert prompts[0]["event"] == "clarify.request"
    payload = prompts[0]["payload"]
    # The replayed payload must carry everything the one-shot event did — the
    # request_id above all, since that is what `clarify.respond` keys off.
    assert payload["question"] == "Ship it?"
    assert payload["choices"] == ["yes", "no"]
    assert payload["request_id"]

    # Answering through the replayed id releases the blocked tool.
    server._answers[payload["request_id"]] = "yes"
    server._pending[payload["request_id"]][1].set()
    thread.join(timeout=5)
    assert result["answer"] == "yes"


def test_replay_is_empty_once_the_prompt_resolves(monkeypatch):
    monkeypatch.setattr(server, "_emit", lambda *a, **k: None)

    thread, _ = _block_in_thread("sid-1", {"question": "Ship it?"})
    request_id = _answer("sid-1")

    server._answers[request_id] = "yes"
    server._pending[request_id][1].set()
    thread.join(timeout=5)

    # An answered prompt must NOT be replayed — a resuming window would show a
    # card for a question that is already settled.
    assert server._session_pending_prompts("sid-1") == []


def test_replay_is_scoped_to_its_own_session(monkeypatch):
    monkeypatch.setattr(server, "_emit", lambda *a, **k: None)

    thread_a, _ = _block_in_thread("sid-a", {"question": "A?"})
    thread_b, _ = _block_in_thread("sid-b", {"question": "B?"})

    assert [p["payload"]["question"] for p in server._session_pending_prompts("sid-a")] == ["A?"]
    assert [p["payload"]["question"] for p in server._session_pending_prompts("sid-b")] == ["B?"]
    assert server._session_pending_prompts("sid-other") == []

    for sid, thread in (("sid-a", thread_a), ("sid-b", thread_b)):
        request_id = _answer(sid)
        server._answers[request_id] = ""
        server._pending[request_id][1].set()
        thread.join(timeout=5)


def test_replayed_payload_is_a_copy(monkeypatch):
    """A caller mutating the replay must not corrupt the live prompt state."""
    monkeypatch.setattr(server, "_emit", lambda *a, **k: None)

    thread, _ = _block_in_thread("sid-1", {"question": "Ship it?"})

    replay = server._session_pending_prompts("sid-1")
    replay[0]["payload"]["question"] = "tampered"

    assert server._session_pending_prompts("sid-1")[0]["payload"]["question"] == "Ship it?"

    request_id = _answer("sid-1")
    server._answers[request_id] = ""
    server._pending[request_id][1].set()
    thread.join(timeout=5)

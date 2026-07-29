"""The turn must survive a FAILED follow-up request.

When a steer reopens the turn, the answer the model already produced is
withheld (``final_response = None``) while the loop issues one more
request. If that request fails, the withheld answer must still reach the
user and the steer must still be recoverable — otherwise a network hiccup
destroys a completed answer that the parent behavior delivered fine.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

_AGENT: list = [None]


class _FailingFollowupHandler(BaseHTTPRequestHandler):
    """Answers the first turn, then fails every follow-up request."""

    completion_requests: int = 0
    steer_text: str = "and also check staging"

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(length).decode())

        if "messages" not in req:
            self._json(200, {"id": "m", "choices": [
                {"index": 0, "message": {"role": "assistant", "content": "x"}, "finish_reason": "stop"}]})
            return

        type(self).completion_requests += 1

        if type(self).completion_requests == 1:
            # Steer BEFORE responding: by the time the loop reaches its
            # turn-end check the correction is already pending, which is
            # what makes the turn reopen.
            _AGENT[0].steer(type(self).steer_text)
            self._answer(req, "ANSWER ONE")
        else:
            self.send_response(500)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

    def _answer(self, req: dict, text: str) -> None:
        """Reply in whichever transport the client asked for."""
        if req.get("stream") is True:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for chunk in (
                {"id": "m", "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]},
                {"id": "m", "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}]},
                {"id": "m", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
            ):
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        else:
            self._json(200, {
                "id": "m",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                             "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6},
            })

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a, **kw):
        pass


@pytest.fixture()
def failing_followup_env():
    _FailingFollowupHandler.completion_requests = 0
    srv = HTTPServer(("127.0.0.1", 0), _FailingFollowupHandler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    test_home = tempfile.mkdtemp(prefix="hermes_steer_failpath_")
    os.makedirs(os.path.join(test_home, ".hermes"))
    prev_home = os.environ.get("HERMES_HOME")
    os.environ["HERMES_HOME"] = os.path.join(test_home, ".hermes")

    for mod in list(sys.modules):
        if mod == "run_agent" or mod.startswith(("agent.", "tools.", "hermes_")):
            del sys.modules[mod]
    from run_agent import AIAgent

    agent = AIAgent(
        api_key="test-key",
        base_url=f"http://127.0.0.1:{port}/v1",
        provider="openai-compat",
        model="test-model",
        max_iterations=6,
        enabled_toolsets=[],
        quiet_mode=True,
        skip_context_files=True,
        skip_memory=True,
        save_trajectories=False,
        platform="cli",
    )
    _AGENT[0] = agent

    try:
        yield agent, _FailingFollowupHandler
    finally:
        srv.shutdown()
        shutil.rmtree(test_home, ignore_errors=True)
        if prev_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = prev_home


def test_completed_answer_survives_a_failed_followup(failing_followup_env):
    """A network failure on the follow-up must not destroy the real answer."""
    agent, handler = failing_followup_env

    result = agent.run_conversation("do the thing", conversation_history=[], task_id="t")

    assert handler.completion_requests >= 2, (
        f"the steer never reopened the turn (requests={handler.completion_requests}) — "
        "the failure under test was never exercised"
    )
    assert "ANSWER ONE" in (result.get("final_response") or ""), (
        "the model's completed answer was destroyed by a failed steer follow-up"
    )


def test_steer_survives_a_failed_followup(failing_followup_env):
    """The correction must not be silently swallowed by a failed follow-up.

    "Survives" means the model acts on it exactly once — either it already
    reached the model in this turn's history, or it comes back as
    next-turn input. Requiring both would deliver it twice.
    """
    agent, handler = failing_followup_env

    result = agent.run_conversation("do the thing", conversation_history=[], task_id="t")

    in_messages = any(
        m.get("role") == "user" and handler.steer_text in str(m.get("content", ""))
        for m in (result.get("messages") or [])
        if isinstance(m, dict)
    )
    requeued = result.get("pending_steer") == handler.steer_text

    assert in_messages or requeued, "a failed follow-up dropped the user's steer entirely"
    assert not (in_messages and requeued), "the steer would be acted on twice"


class _ContextOverflowHandler(_FailingFollowupHandler):
    """Fails the follow-up with a context-length error.

    This exits the loop through a *different* early ``return`` than the
    retry-exhaustion path — one of ~25 that bypass ``finalize_turn``. The
    protection must be structural, not per-call-site.
    """

    failure_status: int = 400
    failure_body: dict = {
        "error": {
            "message": "This model's maximum context length is 8192 tokens.",
            "type": "invalid_request_error",
            "code": "context_length_exceeded",
        }
    }

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(length).decode())

        if "messages" not in req:
            self._json(200, {"id": "m", "choices": [
                {"index": 0, "message": {"role": "assistant", "content": "x"}, "finish_reason": "stop"}]})
            return

        type(self).completion_requests += 1

        if type(self).completion_requests == 1:
            _AGENT[0].steer(type(self).steer_text)
            self._answer(req, "ANSWER ONE")
        else:
            self._json(type(self).failure_status, type(self).failure_body)


def _make_env(handler_cls, prefix: str):
    handler_cls.completion_requests = 0
    srv = HTTPServer(("127.0.0.1", 0), handler_cls)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    test_home = tempfile.mkdtemp(prefix=prefix)
    os.makedirs(os.path.join(test_home, ".hermes"))
    prev_home = os.environ.get("HERMES_HOME")
    os.environ["HERMES_HOME"] = os.path.join(test_home, ".hermes")

    for mod in list(sys.modules):
        if mod == "run_agent" or mod.startswith(("agent.", "tools.", "hermes_")):
            del sys.modules[mod]
    from run_agent import AIAgent

    agent = AIAgent(
        api_key="test-key", base_url=f"http://127.0.0.1:{port}/v1",
        provider="openai-compat", model="test-model", max_iterations=6,
        enabled_toolsets=[], quiet_mode=True, skip_context_files=True,
        skip_memory=True, save_trajectories=False, platform="cli",
    )
    _AGENT[0] = agent
    return agent, srv, test_home, prev_home


def _teardown(srv, test_home, prev_home):
    srv.shutdown()
    shutil.rmtree(test_home, ignore_errors=True)
    if prev_home is None:
        os.environ.pop("HERMES_HOME", None)
    else:
        os.environ["HERMES_HOME"] = prev_home


@pytest.fixture()
def overflow_followup_env():
    _ContextOverflowHandler.failure_status = 400
    _ContextOverflowHandler.failure_body = {
        "error": {
            "message": "This model's maximum context length is 8192 tokens.",
            "type": "invalid_request_error",
            "code": "context_length_exceeded",
        }
    }
    agent, srv, home, prev = _make_env(_ContextOverflowHandler, "hermes_steer_overflow_")
    try:
        yield agent, _ContextOverflowHandler
    finally:
        _teardown(srv, home, prev)


def test_answer_survives_a_followup_that_exits_on_a_different_path(overflow_followup_env):
    """Protection must not be specific to one failure's return statement."""
    agent, handler = overflow_followup_env

    result = agent.run_conversation("do the thing", conversation_history=[], task_id="t")

    assert handler.completion_requests >= 2, "the steer never reopened the turn"
    assert "ANSWER ONE" in (result.get("final_response") or ""), (
        "a context-overflow exit destroyed the model's completed answer"
    )


# Each shape leaves the loop through a different early return. A guard bolted
# onto one call site passes the first and fails the rest.
_FAILURE_SHAPES = {
    "billing_402": (402, {"error": {
        "message": "Your credit balance is too low to access the API.",
        "type": "insufficient_quota", "code": "insufficient_quota"}}),
    "bad_request_400": (400, {"error": {
        "message": "Invalid request payload.",
        "type": "invalid_request_error", "code": "invalid_request"}}),
    "server_500": (500, {"error": {"message": "internal error"}}),
    "context_overflow": (400, {"error": {
        "message": "This model's maximum context length is 8192 tokens.",
        "type": "invalid_request_error", "code": "context_length_exceeded"}}),
}


@pytest.mark.parametrize("shape", sorted(_FAILURE_SHAPES))
def test_answer_survives_every_followup_failure_shape(shape):
    """The whole bug class, not just the shape the first fix happened to cover."""
    status, body = _FAILURE_SHAPES[shape]
    _ContextOverflowHandler.failure_status = status
    _ContextOverflowHandler.failure_body = body
    agent, srv, home, prev = _make_env(_ContextOverflowHandler, f"hermes_steer_{shape}_")
    try:
        result = agent.run_conversation("do the thing", conversation_history=[], task_id="t")

        assert _ContextOverflowHandler.completion_requests >= 2, (
            f"[{shape}] the steer never reopened the turn"
        )
        assert "ANSWER ONE" in (result.get("final_response") or ""), (
            f"[{shape}] the model's completed answer was destroyed"
        )
    finally:
        _teardown(srv, home, prev)


class _InterruptedFollowupHandler(_FailingFollowupHandler):
    """Answers, accepts a steer, then the user hits /stop mid-follow-up."""

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(length).decode())

        if "messages" not in req:
            self._json(200, {"id": "m", "choices": [
                {"index": 0, "message": {"role": "assistant", "content": "x"}, "finish_reason": "stop"}]})
            return

        type(self).completion_requests += 1

        if type(self).completion_requests == 1:
            _AGENT[0].steer(type(self).steer_text)
            self._answer(req, "ANSWER ONE")
        else:
            _AGENT[0].interrupt()
            self._answer(req, "should not matter")


@pytest.fixture()
def interrupted_followup_env():
    agent, srv, home, prev = _make_env(_InterruptedFollowupHandler, "hermes_steer_interrupt_")
    try:
        yield agent, _InterruptedFollowupHandler
    finally:
        _teardown(srv, home, prev)


def test_stop_during_a_followup_does_not_resurrect_the_steer(interrupted_followup_env):
    """/stop kills a pending steer — the safety net must not undo that."""
    agent, handler = interrupted_followup_env

    result = agent.run_conversation("do the thing", conversation_history=[], task_id="t")

    assert result.get("pending_steer") is None, (
        "a steer cancelled by /stop was resurrected for the next turn"
    )


def test_steer_is_not_delivered_twice(failing_followup_env):
    """Already in `messages` AND handed back as pending_steer = seen twice."""
    agent, handler = failing_followup_env

    result = agent.run_conversation("do the thing", conversation_history=[], task_id="t")

    in_messages = any(
        m.get("role") == "user" and handler.steer_text in str(m.get("content", ""))
        for m in (result.get("messages") or [])
        if isinstance(m, dict)
    )
    assert not (in_messages and result.get("pending_steer")), (
        "the correction is in history AND queued as next-turn input — "
        "the model would act on it twice"
    )


class TestRestoreGate:
    """The wrapper must only rescue turns that actually lost their answer."""

    def test_does_not_clobber_a_successful_turn_that_reports_an_error(self):
        """Some non-failed exits set `error` alongside a legitimate response.

        The compression-defer return (agent/conversation_loop.py) is
        `failed: False` + `error` + a real `final_response`. Treating a
        truthy `error` as failure would replace that live response with a
        stale withheld answer.
        """
        from agent.conversation_loop import _apply_steer_followup_rescue

        result = {
            "final_response": "the follow-up's own answer",
            "failed": False,
            "error": "compression deferred",
            "partial": True,
        }
        rescued = _apply_steer_followup_rescue(result, "STALE withheld answer", "steer text")

        assert rescued["final_response"] == "the follow-up's own answer"
        assert "pending_steer" not in rescued

    def test_rescues_a_genuinely_failed_turn(self):
        from agent.conversation_loop import _apply_steer_followup_rescue

        result = {
            "final_response": "API call failed after 3 retries",
            "failed": True,
            "error": "HTTP 500",
            "messages": [],
        }
        rescued = _apply_steer_followup_rescue(result, "the real answer", "steer text")

        assert rescued["final_response"] == "the real answer"
        assert rescued["response_previewed"] is True
        assert rescued["pending_steer"] == "steer text"


def test_restored_answer_is_marked_as_already_shown(failing_followup_env):
    """The answer was emitted as interim before the turn reopened.

    Surfaces suppress a duplicate send via ``response_previewed``, but the
    gateway only consults it on non-failed turns (gateway/run.py) — and a
    restored answer always rides a failed one. Without the flag the user
    reads the same answer twice.
    """
    agent, _ = failing_followup_env

    result = agent.run_conversation("do the thing", conversation_history=[], task_id="t")

    assert "ANSWER ONE" in (result.get("final_response") or "")
    assert result.get("response_previewed") is True, (
        "a restored answer was not flagged as already delivered — it will be sent twice"
    )

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
    """The drained steer must be recoverable so it is not silently swallowed."""
    agent, handler = failing_followup_env

    result = agent.run_conversation("do the thing", conversation_history=[], task_id="t")

    assert result.get("pending_steer") == handler.steer_text, (
        "a failed follow-up dropped the user's steer entirely"
    )


class _ContextOverflowHandler(_FailingFollowupHandler):
    """Fails the follow-up with a context-length error.

    This exits the loop through a *different* early ``return`` than the
    retry-exhaustion path — one of ~25 that bypass ``finalize_turn``. The
    protection must be structural, not per-call-site.
    """

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
            self._json(400, {"error": {
                "message": "This model's maximum context length is 8192 tokens.",
                "type": "invalid_request_error",
                "code": "context_length_exceeded",
            }})


@pytest.fixture()
def overflow_followup_env():
    _ContextOverflowHandler.completion_requests = 0
    srv = HTTPServer(("127.0.0.1", 0), _ContextOverflowHandler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    test_home = tempfile.mkdtemp(prefix="hermes_steer_overflow_")
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

    try:
        yield agent, _ContextOverflowHandler
    finally:
        srv.shutdown()
        shutil.rmtree(test_home, ignore_errors=True)
        if prev_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = prev_home


def test_answer_survives_a_followup_that_exits_on_a_different_path(overflow_followup_env):
    """Protection must not be specific to one failure's return statement."""
    agent, handler = overflow_followup_env

    result = agent.run_conversation("do the thing", conversation_history=[], task_id="t")

    assert handler.completion_requests >= 2, "the steer never reopened the turn"
    assert "ANSWER ONE" in (result.get("final_response") or ""), (
        "a context-overflow exit destroyed the model's completed answer"
    )

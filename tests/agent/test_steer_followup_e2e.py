"""E2E: a steer pending at turn end reopens the turn.

Hermes delivered ``/steer`` by appending the text to the last ``role:"tool"``
message. When the model answers in plain text with no tool calls there is no
tool result to append to, so the steer was pushed back into the pending slot
and deferred — the user's correction arrived a whole turn late, or not at all
if the session ended.

Codex's turn loop treats pending input as "this turn needs a follow-up": the
text is recorded as a real user message and the loop issues one more sampling
request. These tests exercise that contract end-to-end through the real
``AIAgent.run_conversation`` against an in-process mock provider, asserting on
what the provider actually received.
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


class _MockHandler(BaseHTTPRequestHandler):
    captured_requests: list = []
    response_queue: list = []
    # Called with the agent after each request so a test can steer mid-turn.
    on_request = None

    def do_POST(self):  # noqa: N802 (http.server API)
        length = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(length).decode())
        # The client also probes non-completion endpoints (model metadata);
        # only chat-completion payloads carry `messages` and count as turns.
        if "messages" in req:
            type(self).captured_requests.append(req)

        resp = (
            type(self).response_queue.pop(0)
            if type(self).response_queue
            else _text_resp("DONE")
        )

        if req.get("stream") is True:
            content = resp["choices"][0]["message"].get("content") or ""
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            chunks = [
                {"id": "m", "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]}
            ]
            if content:
                chunks.append(
                    {"id": "m", "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": None}]}
                )
            chunks.append({"id": "m", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
            for c in chunks:
                self.wfile.write(f"data: {json.dumps(c)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        else:
            body = json.dumps(resp).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        hook = type(self).on_request
        if hook is not None:
            hook(len(type(self).captured_requests))

    def log_message(self, *a, **kw):
        pass


def _text_resp(text: str) -> dict:
    return {
        "id": "m",
        "choices": [
            {"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 0, "total_tokens": 10},
    }


@pytest.fixture()
def agent_env():
    _MockHandler.captured_requests = []
    _MockHandler.response_queue = []
    _MockHandler.on_request = None
    srv = HTTPServer(("127.0.0.1", 0), _MockHandler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    test_home = tempfile.mkdtemp(prefix="hermes_steer_followup_")
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
        max_iterations=10,
        enabled_toolsets=[],
        quiet_mode=True,
        skip_context_files=True,
        skip_memory=True,
        save_trajectories=False,
        platform="cli",
    )

    try:
        yield agent, _MockHandler
    finally:
        srv.shutdown()
        shutil.rmtree(test_home, ignore_errors=True)
        if prev_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = prev_home


def _user_texts(req: dict) -> list[str]:
    out = []
    for m in req.get("messages", []):
        if m.get("role") == "user":
            content = m.get("content")
            if isinstance(content, str):
                out.append(content)
            elif isinstance(content, list):
                out.extend(p.get("text", "") for p in content if isinstance(p, dict))
    return out


def test_steer_during_plain_answer_triggers_a_followup_request(agent_env):
    """The turn must not end while the user's correction is still pending."""
    agent, handler = agent_env
    handler.response_queue.append(_text_resp("I deployed to production."))
    handler.response_queue.append(_text_resp("Reverted and redeployed to staging."))

    # Steer lands while the model is composing its (tool-free) first answer.
    handler.on_request = lambda n: agent.steer("wait — staging, not prod") if n == 1 else None

    agent.run_conversation("deploy the service", conversation_history=[], task_id="t")

    assert len(handler.captured_requests) >= 2, (
        "a steer pending at turn end must reopen the turn with another request"
    )


def test_followup_request_carries_the_steer_as_a_user_message(agent_env):
    agent, handler = agent_env
    handler.response_queue.append(_text_resp("I deployed to production."))
    handler.response_queue.append(_text_resp("Reverted and redeployed to staging."))
    handler.on_request = lambda n: agent.steer("wait — staging, not prod") if n == 1 else None

    agent.run_conversation("deploy the service", conversation_history=[], task_id="t")

    second = handler.captured_requests[1]
    assert any("staging, not prod" in t for t in _user_texts(second))


def test_followup_request_retains_the_answer_the_user_already_saw(agent_env):
    """The interrupted answer stays as context — nothing is discarded."""
    agent, handler = agent_env
    handler.response_queue.append(_text_resp("I deployed to production."))
    handler.response_queue.append(_text_resp("Reverted and redeployed to staging."))
    handler.on_request = lambda n: agent.steer("wait — staging, not prod") if n == 1 else None

    agent.run_conversation("deploy the service", conversation_history=[], task_id="t")

    second = handler.captured_requests[1]
    blob = json.dumps(second["messages"])
    assert "I deployed to production." in blob


def test_followup_request_is_a_pure_append_of_the_first(agent_env):
    """Prompt caching holds only if every earlier message is byte-identical."""
    agent, handler = agent_env
    handler.response_queue.append(_text_resp("I deployed to production."))
    handler.response_queue.append(_text_resp("Reverted and redeployed to staging."))
    handler.on_request = lambda n: agent.steer("wait — staging, not prod") if n == 1 else None

    agent.run_conversation("deploy the service", conversation_history=[], task_id="t")

    first = handler.captured_requests[0]["messages"]
    second = handler.captured_requests[1]["messages"]
    assert len(second) > len(first)
    assert second[: len(first)] == first


def test_no_steer_leaves_the_turn_ending_after_one_request(agent_env):
    """Without a pending steer the loop must still stop at the first answer."""
    agent, handler = agent_env
    handler.response_queue.append(_text_resp("All done."))

    result = agent.run_conversation("deploy the service", conversation_history=[], task_id="t")

    assert len(handler.captured_requests) == 1
    assert "All done." in (result.get("final_response") or "")


def test_steer_is_delivered_only_once(agent_env):
    """A drained steer must not reappear on the follow-up's own turn end."""
    agent, handler = agent_env
    handler.response_queue.append(_text_resp("I deployed to production."))
    handler.response_queue.append(_text_resp("Reverted and redeployed to staging."))
    handler.response_queue.append(_text_resp("Anything else?"))
    handler.on_request = lambda n: agent.steer("wait — staging, not prod") if n == 1 else None

    agent.run_conversation("deploy the service", conversation_history=[], task_id="t")

    assert len(handler.captured_requests) == 2
    steer_mentions = sum(
        1 for t in _user_texts(handler.captured_requests[-1]) if "staging, not prod" in t
    )
    assert steer_mentions == 1

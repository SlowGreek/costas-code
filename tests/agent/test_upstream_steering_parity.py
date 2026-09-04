"""Behavioral parity checks against upstream Hermes steering.

Pinned reference: NousResearch/hermes-agent
13e72fb205b735df679e0fd5f5996a34ac4accc6.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)


class _MockHandler(BaseHTTPRequestHandler):
    captured_requests: list[dict] = []
    on_request = None

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        request = json.loads(self.rfile.read(length).decode())
        if "messages" in request:
            type(self).captured_requests.append(request)

        response = {
            "id": "m",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "original answer"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
        }
        if request.get("stream") is True:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            chunks = [
                {
                    "id": "m",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"role": "assistant", "content": ""},
                            "finish_reason": None,
                        }
                    ],
                },
                {
                    "id": "m",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": "original answer"},
                            "finish_reason": None,
                        }
                    ],
                },
                {"id": "m", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
            ]
            for chunk in chunks:
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        else:
            body = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        hook = type(self).on_request
        if hook is not None:
            hook(len(type(self).captured_requests))

    def log_message(self, *args, **kwargs):
        pass


@pytest.fixture()
def agent_env(tmp_path):
    _MockHandler.captured_requests = []
    _MockHandler.on_request = None
    server = HTTPServer(("127.0.0.1", 0), _MockHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    hermes_home = str(tmp_path / ".hermes")
    os.makedirs(hermes_home)
    previous_home = os.environ.get("HERMES_HOME")
    os.environ["HERMES_HOME"] = hermes_home

    for module_name in list(sys.modules):
        if module_name == "run_agent" or module_name.startswith(("agent.", "tools.", "hermes_")):
            del sys.modules[module_name]

    from run_agent import AIAgent

    agent = AIAgent(
        api_key="test-key",
        base_url=f"http://127.0.0.1:{server.server_address[1]}/v1",
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
        server.shutdown()
        if previous_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = previous_home


def test_late_steer_returns_to_post_turn_queue_without_reopening_model_loop(agent_env):
    """Match upstream: a steer arriving after a tool-free answer becomes pending input."""
    agent, handler = agent_env
    handler.on_request = lambda request_count: agent.steer("use staging") if request_count == 1 else None

    result = agent.run_conversation("deploy", conversation_history=[], task_id="parity")

    assert len(handler.captured_requests) == 1
    assert result.get("pending_steer") == "use staging"
    assert result.get("final_response") == "original answer"

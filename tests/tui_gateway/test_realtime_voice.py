import json

from hermes_cli.config_defaults import DEFAULT_CONFIG
from tui_gateway.realtime_voice import create_realtime_client_secret


class _Response:
    status = 200

    def __init__(self, payload):
        self._payload = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit=-1):
        return self._payload


def test_realtime_voice_defaults_are_provider_specific():
    assert DEFAULT_CONFIG["voice"]["realtime"] == {
        "enabled": True,
        "model": "gpt-realtime-2.1",
        "voice": "marin",
        "transcription_model": "gpt-live-transcribe",
        "vad": {"type": "semantic_vad", "eagerness": "auto"},
    }


def test_client_secret_request_uses_current_realtime_session_schema():
    captured = {}

    def opener(request, timeout):
        captured.update(
            url=request.full_url,
            method=request.get_method(),
            headers=dict(request.header_items()),
            body=json.loads(request.data),
            timeout=timeout,
        )
        return _Response({"value": "ek_live_short", "expires_at": 1234})

    result = create_realtime_client_secret(
        api_key="sk-test",
        model="gpt-realtime-2.1",
        voice="marin",
        transcription_model="gpt-live-transcribe",
        opener=opener,
    )

    assert captured == {
        "url": "https://api.openai.com/v1/realtime/client_secrets",
        "method": "POST",
        "headers": {
            "Authorization": "Bearer " + "sk-test",
            "Content-type": "application/json",
        },
        "body": {
            "session": {
                "type": "realtime",
                "model": "gpt-realtime-2.1",
                "audio": {
                    "input": {
                        "transcription": {"model": "gpt-live-transcribe"},
                        "turn_detection": {
                            "type": "semantic_vad",
                            "eagerness": "auto",
                            "create_response": True,
                            "interrupt_response": True,
                        },
                    },
                    "output": {"voice": "marin"},
                },
            }
        },
        "timeout": 15,
    }
    assert result == {
        "client_secret": "ek_live_short",
        "expires_at": 1234,
        "model": "gpt-realtime-2.1",
        "voice": "marin",
    }

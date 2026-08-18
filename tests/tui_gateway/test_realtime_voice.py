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
        "base_url": "",
        "key_cmd": "",
    }


def test_client_secret_request_targets_azure_when_a_resource_is_configured():
    """Azure Foundry mints at the resource, authenticated with an Entra token."""
    captured = {}

    def opener(request, timeout):
        captured.update(
            url=request.full_url,
            headers=dict(request.header_items()),
            body=json.loads(request.data),
        )
        return _Response({"value": "ek_azure_short", "expires_at": 4321})

    result = create_realtime_client_secret(
        api_key="entra-access-token",
        model="gpt-realtime-2.1",
        voice="marin",
        transcription_model="gpt-live-transcribe",
        base_url="https://victo-m40le98w-eastus2.openai.azure.com/openai/v1",
        opener=opener,
    )

    assert captured["url"] == (
        "https://victo-m40le98w-eastus2.openai.azure.com/openai/v1/realtime/client_secrets"
    )
    # Azure Entra auth is still a bearer, so the header shape does not change.
    assert captured["headers"]["Authorization"] == "Bearer " + "entra-access-token"
    assert captured["body"]["session"]["model"] == "gpt-realtime-2.1"
    # The renderer must negotiate SDP against the SAME host that minted the
    # credential; an Azure secret is not valid at api.openai.com.
    assert result["webrtc_url"] == (
        "https://victo-m40le98w-eastus2.openai.azure.com/openai/v1/realtime/calls"
    )
    assert result["client_secret"] == "ek_azure_short"


def test_client_secret_defaults_to_openai_webrtc_url():
    def opener(_request, timeout):
        return _Response({"value": "ek_live_short", "expires_at": 1234})

    result = create_realtime_client_secret(
        api_key="sk-test",
        model="gpt-realtime-2.1",
        voice="marin",
        transcription_model="gpt-live-transcribe",
        opener=opener,
    )

    assert result["webrtc_url"] == "https://api.openai.com/v1/realtime/calls"


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
        "webrtc_url": "https://api.openai.com/v1/realtime/calls",
    }

#!/usr/bin/env python3
"""Mint a Cognitive Services bearer token for Azure OpenAI providers.

Wire this into ``config.yaml`` as a provider ``key_cmd``::

    providers:
      astra:
        base_url: https://<resource>.cognitiveservices.azure.com/openai/v1
        key_cmd: python3 /path/to/cs_token.py
        api_mode: codex_responses

The printed value is an **Entra bearer token**, not an Azure ``api-key``.
Hermes sends it as ``Authorization: Bearer <token>``, which is what
Cognitive Services RBAC expects.

Resolution order (first fresh token wins):

1. Cached token in ``$HERMES_HOME/.cs-token.json`` while more than five
   minutes from expiry. Keeps per-request cost near zero.
2. A Peeps bearer in ``$HERMES_HOME/.peeps-token`` (override with
   ``PEEPS_TOKEN_FILE``), exchanged at the Seastar
   ``getCognitiveServicesToken`` endpoint.
3. ``az account get-access-token --resource https://cognitiveservices.azure.com``.

Tokens are short-lived, so this must run per request — never resolved once
at startup. The token is never logged; only its expiry is inspected.

Cross-platform: pure stdlib, no shell builtins, works on macOS, Linux and
Windows.
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

EXCHANGE_URL = "https://seastarserviceapp-develop.azurewebsites.net/token/getCognitiveServicesToken"
COGNITIVE_RESOURCE = "https://cognitiveservices.azure.com"
REFRESH_MARGIN_SECONDS = 300
EXCHANGE_TIMEOUT_SECONDS = 15
MAX_RESPONSE_BYTES = 128 * 1024


def hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))


def token_expiry(token: str, *, audience: str = COGNITIVE_RESOURCE) -> int:
    """Read expiry only for the expected audience (not signature verification)."""
    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", token):
        return 0
    parts = token.split(".")
    padded = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        claims = json.loads(base64.urlsafe_b64decode(padded))
        if claims.get("aud") != audience:
            return 0
        return int(claims["exp"])
    except Exception:
        return 0


def is_fresh(token: str) -> bool:
    return bool(token) and token_expiry(token) > time.time() + REFRESH_MARGIN_SECONDS


def cache_path() -> Path:
    return hermes_home() / ".cs-token.json"


def read_cache() -> str:
    try:
        return str(json.loads(cache_path().read_text()).get("token") or "")
    except Exception:
        return ""


def write_cache(token: str) -> None:
    path = cache_path()
    temporary = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # mkstemp creates owner-only before any credential bytes are written.
        # Replace atomically so concurrent key_cmd readers never see half JSON.
        fd, temporary = tempfile.mkstemp(prefix=".cs-token-", dir=path.parent)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump({"token": token, "exp": token_expiry(token)}, stream)
        os.replace(temporary, path)
    except OSError:
        pass  # a cache miss is survivable; a crash here is not
    finally:
        if temporary:
            try:
                Path(temporary).unlink(missing_ok=True)
            except OSError:
                pass


def parse_exchange_response(raw: bytes) -> str:
    try:
        decoded = raw.decode("utf-8").strip()
    except UnicodeDecodeError:
        return ""
    try:
        parsed = json.loads(decoded)
    except json.JSONDecodeError:
        parsed = decoded
    if isinstance(parsed, dict):
        for key in ("token", "accessToken", "access_token"):
            if parsed.get(key):
                return str(parsed[key]).strip()
        return ""
    if isinstance(parsed, str):
        return parsed.strip()
    return ""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward a Peeps bearer to a redirect target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def from_peeps() -> str:
    peeps_file = Path(
        os.environ.get("PEEPS_TOKEN_FILE") or (hermes_home() / ".peeps-token")
    )
    try:
        peeps = peeps_file.read_text().strip()
    except (OSError, UnicodeError):
        return ""
    if token_expiry(peeps, audience="https://peeps.asgprototype.com/api") <= time.time():
        return ""
    request = urllib.request.Request(
        EXCHANGE_URL, headers={"Authorization": f"Bearer {peeps}"}, method="GET"
    )
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=EXCHANGE_TIMEOUT_SECONDS) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except (urllib.error.URLError, OSError, ValueError):
        # Header validation errors may contain the bearer. Never print them.
        return ""
    if len(raw) > MAX_RESPONSE_BYTES:
        return ""
    return parse_exchange_response(raw)


def from_azure_cli() -> str:
    az = shutil.which("az")
    if not az:
        return ""
    try:
        completed = subprocess.run(
            [
                az,
                "account",
                "get-access-token",
                "--resource",
                COGNITIVE_RESOURCE,
                "--query",
                "accessToken",
                "-o",
                "tsv",
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return completed.stdout.strip() if completed.returncode == 0 else ""


def main() -> int:
    cached = read_cache()
    if is_fresh(cached):
        print(cached)
        return 0
    for source in (from_peeps, from_azure_cli):
        token = source()
        if is_fresh(token):
            write_cache(token)
            print(token)
            return 0
    sys.stderr.write(
        "cs_token: no Cognitive Services token available. Provide a Peeps "
        "bearer at $HERMES_HOME/.peeps-token or run 'az login'.\n"
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

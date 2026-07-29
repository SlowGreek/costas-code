"""GitHub Copilot authentication utilities.

Implements the OAuth device code flow used by the Copilot CLI and handles
token validation/exchange for the Copilot API.

Token type support (per GitHub docs):
  gho_          OAuth token           ✓  (default via copilot login)
  github_pat_   Fine-grained PAT      ✓  (needs Copilot Requests permission)
  ghu_          GitHub App token      ✓  (via environment variable)
  ghp_          Classic PAT           ✗  NOT SUPPORTED

Credential search order (matching Copilot CLI behaviour):
  1. COPILOT_GITHUB_TOKEN env var
  2. GH_TOKEN env var
  3. GITHUB_TOKEN env var
  4. gh auth token  CLI fallback
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Optional

from hermes_cli._subprocess_compat import IS_WINDOWS, windows_hide_flags

logger = logging.getLogger(__name__)

# OAuth device code flow constants — VS Code's GitHub App client ID.
# The previous opencode OAuth App ID (Ov23li8tweQw6odWQebz) produces gho_*
# tokens that cannot be exchanged for Copilot API JWTs (404 on
# /copilot_internal/v2/token). VS Code's App ID produces ghu_* tokens
# that support exchange, which is required to access internal-only models
# (e.g. claude-opus-4.6-1m) and enterprise endpoints.
# Tested on Individual and Enterprise accounts.
COPILOT_OAUTH_CLIENT_ID = "Iv1.b507a08c87ecfe98"
# Token type prefixes
_CLASSIC_PAT_PREFIX = "ghp_"
_SUPPORTED_PREFIXES = ("gho_", "github_pat_", "ghu_")

# Env var search order (matches Copilot CLI)
COPILOT_ENV_VARS = ("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN")

# Provider identifiers that all denote the GitHub Copilot provider.
#
# Mirrors the ``-> "copilot"`` entries in the provider alias table in
# ``hermes_cli.auth``. Call sites that key Copilot-specific behaviour off a
# bare ``provider == "copilot"`` check silently skip every alias; the
# ``github-copilot`` alias in particular used to miss enterprise endpoint
# resolution entirely and fall back to the generic host.
#
# ``copilot-acp`` is deliberately excluded: it is a separate provider with its
# own transport, not an alias of this one.
COPILOT_PROVIDER_ALIASES = frozenset(
    {"copilot", "github-copilot", "github", "github-models", "github-model"}
)


def is_copilot_provider(provider: object) -> bool:
    """True when ``provider`` names the GitHub Copilot provider or an alias."""
    return str(provider or "").strip().lower() in COPILOT_PROVIDER_ALIASES


# Polling constants
_DEVICE_CODE_POLL_INTERVAL = 5  # seconds
_DEVICE_CODE_POLL_SAFETY_MARGIN = 3  # seconds


def validate_copilot_token(token: str) -> tuple[bool, str]:
    """Validate that a token is usable with the Copilot API.

    Returns (valid, message).
    """
    token = token.strip()
    if not token:
        return False, "Empty token"

    if token.startswith(_CLASSIC_PAT_PREFIX):
        return False, (
            "Classic Personal Access Tokens (ghp_*) are not supported by the "
            "Copilot API. Use one of:\n"
            "  → `copilot login` or `hermes model` to authenticate via OAuth\n"
            "  → A fine-grained PAT (github_pat_*) with Copilot Requests permission\n"
            "  → `gh auth login` with the default device code flow (produces gho_* tokens)"
        )

    return True, "OK"


def _gh_active_login() -> Optional[str]:
    """Return the login of the active ``gh`` account, or None.

    Best-effort and cheap: parses ``gh auth status``. Never raises.
    """
    _popen_kwargs = {"creationflags": windows_hide_flags()} if IS_WINDOWS else {}
    clean_env = {
        k: v for k, v in os.environ.items()
        if k not in {"GITHUB_TOKEN", "GH_TOKEN", "COPILOT_GITHUB_TOKEN"}
    }
    for gh_path in _gh_cli_candidates():
        try:
            result = subprocess.run(
                [gh_path, "auth", "status"],
                capture_output=True,
                text=True,
                timeout=5,
                env=clean_env,
                **_popen_kwargs,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
            logger.debug("gh auth status failed (%s): %s", gh_path, exc)
            continue
        # `gh auth status` reports every account and marks the active one:
        #   ✓ Logged in to github.com account NAME (keyring)
        #   - Active account: true
        blob = f"{result.stdout}\n{result.stderr}"
        current: Optional[str] = None
        for line in blob.splitlines():
            match = re.search(r"Logged in to \S+ account (\S+)", line)
            if match:
                current = match.group(1)
                continue
            if current and "Active account: true" in line:
                return current
    return None


# Emit the env-shadowing warning at most once per process: token resolution runs
# on a hot path and a repeated warning is exactly the log storm this module
# already guards against elsewhere.
_shadow_warning_emitted = False


def env_token_shadows_gh_account(env_var: str, token: str) -> Optional[str]:
    """Return the shadowed ``gh`` login when an env token overrides it.

    Env-var tokens deliberately outrank the GitHub CLI (this matches the
    official runtime, whose ``AuthMethod`` order puts ``GitHubToken`` above
    ``GhCli``), and scripted/CI setups depend on that. The hazard is that it
    is *silent*: with ``COPILOT_GITHUB_TOKEN`` exported, ``gh auth switch``
    appears to change accounts but changes nothing, so an account switch that
    looks successful still authenticates as the old user.

    Returns the active ``gh`` login being shadowed, or None when there is no
    conflict (no gh, not logged in, or gh is serving the same token).
    """
    if not token:
        return None
    gh_token = _try_gh_cli_token()
    if not gh_token or gh_token == token:
        # gh is absent, logged out, or already handing back this same token —
        # nothing is being overridden.
        return None
    return _gh_active_login()


def _warn_once_if_env_token_shadows_gh(env_var: str, token: str) -> None:
    """Log a one-time, actionable warning about a shadowed ``gh`` account."""
    global _shadow_warning_emitted
    if _shadow_warning_emitted:
        return
    try:
        shadowed = env_token_shadows_gh_account(env_var, token)
    except Exception as exc:  # pragma: no cover - diagnostics must never break auth
        logger.debug("env/gh shadowing check failed: %s", exc)
        return
    if not shadowed:
        return
    _shadow_warning_emitted = True
    logger.warning(
        "Copilot is authenticating with the token in %s, which overrides the "
        "GitHub CLI account '%s'. `gh auth switch` will NOT change the Copilot "
        "account while %s is set. To use '%s', unset %s (and GH_TOKEN / "
        "GITHUB_TOKEN) or re-run the Copilot device-code login to replace it.",
        env_var, shadowed, env_var, shadowed, env_var,
    )


def resolve_copilot_token() -> tuple[str, str]:
    """Resolve a GitHub token suitable for Copilot API use.

    Returns (token, source) where source describes where the token came from.
    Raises ValueError if only a classic PAT is available.
    """
    # 1. Check env vars in priority order
    for env_var in COPILOT_ENV_VARS:
        val = os.getenv(env_var, "").strip()
        if val:
            valid, msg = validate_copilot_token(val)
            if not valid:
                logger.warning(
                    "Token from %s is not supported: %s", env_var, msg
                )
                continue
            # Precedence is intentional, but must not be silent: warn when this
            # token is overriding a different signed-in `gh` account.
            _warn_once_if_env_token_shadows_gh(env_var, val)
            return val, env_var

    # 2. Fall back to gh auth token
    token = _try_gh_cli_token()
    if token:
        valid, msg = validate_copilot_token(token)
        if not valid:
            raise ValueError(
                f"Token from `gh auth token` is a classic PAT (ghp_*). {msg}"
            )
        return token, "gh auth token"

    return "", ""


def _gh_cli_candidates() -> list[str]:
    """Return candidate ``gh`` binary paths, including common Homebrew installs."""
    candidates: list[str] = []

    resolved = shutil.which("gh")
    if resolved:
        candidates.append(resolved)

    for candidate in (
        "/opt/homebrew/bin/gh",
        "/usr/local/bin/gh",
        str(Path.home() / ".local" / "bin" / "gh"),
    ):
        if candidate in candidates:
            continue
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            candidates.append(candidate)

    return candidates


def _try_gh_cli_token() -> Optional[str]:
    """Return a token from ``gh auth token`` when the GitHub CLI is available.

    When COPILOT_GH_HOST is set, passes ``--hostname`` so gh returns the
    correct host's token.  Also strips GITHUB_TOKEN / GH_TOKEN from the
    subprocess environment so ``gh`` reads from its own credential store
    (hosts.yml) instead of just echoing the env var back.
    """
    hostname = os.getenv("COPILOT_GH_HOST", "").strip()

    # Build a clean env so gh doesn't short-circuit on GITHUB_TOKEN / GH_TOKEN
    clean_env = {k: v for k, v in os.environ.items()
                 if k not in {"GITHUB_TOKEN", "GH_TOKEN"}}

    _popen_kwargs = {"creationflags": windows_hide_flags()} if IS_WINDOWS else {}
    for gh_path in _gh_cli_candidates():
        cmd = [gh_path, "auth", "token"]
        if hostname:
            cmd += ["--hostname", hostname]
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True, encoding='utf-8', errors='replace',
                timeout=5,
                env=clean_env,
                **_popen_kwargs,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
            logger.debug("gh CLI token lookup failed (%s): %s", gh_path, exc)
            continue
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    return None


# ─── OAuth Device Code Flow ────────────────────────────────────────────────

def copilot_request_device_code(*, host: str = "github.com") -> dict:
    """Request a device code from GitHub. Headless — no printing, no polling.

    Returns the raw GitHub response dict with at least ``device_code``,
    ``user_code``, ``verification_uri`` and ``interval``. Raises ValueError
    when GitHub refuses or returns an unusable payload.

    Split out of :func:`copilot_device_code_login` so non-terminal surfaces
    (the desktop Accounts tab, the dashboard) can drive the same flow without
    inheriting the CLI's blocking loop and stdout prompts.
    """
    import urllib.request
    import urllib.parse

    domain = host.rstrip("/")
    data = urllib.parse.urlencode({
        "client_id": COPILOT_OAUTH_CLIENT_ID,
        "scope": "read:user",
    }).encode()
    req = urllib.request.Request(
        f"https://{domain}/login/device/code",
        data=data,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "HermesAgent/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            device_data = json.loads(resp.read().decode())
    except Exception as exc:
        # Never interpolate the exception into user-facing text: GitHub's
        # error bodies can echo request material.
        logger.error("Failed to initiate device authorization: %s", exc)
        raise ValueError("Failed to start device authorization") from exc

    if not device_data.get("device_code") or not device_data.get("user_code"):
        raise ValueError("GitHub did not return a device code")

    device_data.setdefault("verification_uri", f"https://{domain}/login/device")
    device_data["interval"] = max(
        int(device_data.get("interval") or _DEVICE_CODE_POLL_INTERVAL), 1
    )
    return device_data


def copilot_poll_device_code(
    device_code: str,
    *,
    host: str = "github.com",
) -> tuple[Optional[str], Optional[str]]:
    """Poll GitHub once for a device-code authorization result.

    Returns ``(access_token, error)``:
      * ``(token, None)``  — authorized
      * ``(None, None)``   — still pending / transient failure; poll again
      * ``(None, error)``  — terminal error code from GitHub

    ``slow_down`` is returned as an error so the caller can widen its own
    interval; ``authorization_pending`` is reported as still-pending.
    """
    import urllib.request
    import urllib.parse

    domain = host.rstrip("/")
    poll_data = urllib.parse.urlencode({
        "client_id": COPILOT_OAUTH_CLIENT_ID,
        "device_code": device_code,
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
    }).encode()
    poll_req = urllib.request.Request(
        f"https://{domain}/login/oauth/access_token",
        data=poll_data,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "HermesAgent/1.0",
        },
    )
    try:
        with urllib.request.urlopen(poll_req, timeout=10) as resp:
            result = json.loads(resp.read().decode())
    except Exception:
        # Transient — the caller keeps polling until its own deadline.
        return None, None

    if result.get("access_token"):
        return result["access_token"], None
    error = result.get("error", "")
    if error == "authorization_pending":
        return None, None
    return None, (error or None)


def copilot_device_code_login(
    *,
    host: str = "github.com",
    timeout_seconds: float = 300,
) -> Optional[str]:
    """Run the GitHub OAuth device code flow for Copilot.

    Prints instructions for the user, polls for completion, and returns
    the OAuth access token on success, or None on failure/cancellation.

    This is the terminal-facing wrapper around
    :func:`copilot_request_device_code` + :func:`copilot_poll_device_code`;
    GUI surfaces drive those primitives directly.
    """
    try:
        device_data = copilot_request_device_code(host=host)
    except ValueError as exc:
        print(f"  ✗ {exc}")
        return None

    verification_uri = device_data["verification_uri"]
    user_code = device_data["user_code"]
    device_code = device_data["device_code"]
    interval = device_data["interval"]

    print()
    print(f"  Open this URL in your browser: {verification_uri}")
    print(f"  Enter this code: {user_code}")
    print()
    print("  Waiting for authorization...", end="", flush=True)

    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        time.sleep(interval + _DEVICE_CODE_POLL_SAFETY_MARGIN)

        token, error = copilot_poll_device_code(device_code, host=host)
        if token:
            print(" ✓")
            return token
        if error is None:
            print(".", end="", flush=True)
            continue
        if error == "slow_down":
            # RFC 8628: back off before the next attempt.
            interval += 5
            print(".", end="", flush=True)
            continue
        print()
        if error == "expired_token":
            print("  ✗ Device code expired. Please try again.")
        elif error == "access_denied":
            print("  ✗ Authorization was denied.")
        else:
            print(f"  ✗ Authorization failed: {error}")
        return None

    print()
    print("  ✗ Timed out waiting for authorization.")
    return None


# ─── Copilot Token Exchange ────────────────────────────────────────────────

# Module-level cache for exchanged Copilot API tokens.
# Maps raw_token_fingerprint -> (api_token, expires_at_epoch, base_url).
_jwt_cache: dict[str, tuple[str, float, Optional[str]]] = {}
_JWT_REFRESH_MARGIN_SECONDS = 120  # refresh 2 min before expiry

# Token exchange endpoint and headers (matching VS Code / Copilot CLI)
_TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token"

# Client identity sent to the Copilot API.
#
# These mirror the official runtime (copilot-agent-runtime
# ``src/runtime/src/model/capi_client.rs`` + ``src/helpers/packageVersion.ts``),
# which identifies itself honestly as ``copilot-developer-cli`` and derives
# ``Editor-Version`` / ``User-Agent`` from its own package name and version.
#
# Hermes previously claimed to be ``vscode-chat`` with a fabricated
# ``Editor-Version: vscode/1.104.1``. Impersonating another integration is the
# kind of request managed/enterprise accounts reject with a Terms-of-Service
# 403 — a message that says nothing about the real cause. Identify honestly so
# a policy rejection is a real policy signal rather than self-inflicted.
COPILOT_INTEGRATION_ID = "copilot-developer-cli"

# ``X-GitHub-Api-Version`` pin, matching capi_client.rs GITHUB_API_VERSION_VALUE.
COPILOT_GITHUB_API_VERSION = "2026-07-01"


def _client_version() -> str:
    """Hermes version used in the Editor-Version / User-Agent strings."""
    try:
        from hermes_cli import __version__ as _v
        return str(_v)
    except Exception:  # pragma: no cover - version import is not critical
        return "0.0.0"


def _editor_version() -> str:
    """``{product}/{version}``, matching the reference getEditorVersion()."""
    return f"{COPILOT_INTEGRATION_ID}/{_client_version()}"


def _user_agent() -> str:
    """``{product}/{version} ({platform} {python})``, matching getUserAgent()."""
    import platform as _platform
    return (
        f"{COPILOT_INTEGRATION_ID}/{_client_version()} "
        f"({_platform.system().lower()} python/{_platform.python_version()})"
    )


_EDITOR_VERSION = _editor_version()
_EXCHANGE_USER_AGENT = _user_agent()


def _token_fingerprint(raw_token: str) -> str:
    """Short fingerprint of a raw token for cache keying (avoids storing full token)."""
    import hashlib
    return hashlib.sha256(raw_token.encode()).hexdigest()[:16]


def exchange_copilot_token(raw_token: str, *, timeout: float = 10.0) -> tuple[str, float, Optional[str]]:
    """Exchange a raw GitHub token for a short-lived Copilot API token.

    Calls ``GET https://api.github.com/copilot_internal/v2/token`` with
    the raw GitHub token and returns ``(api_token, expires_at, base_url)``.

    The returned token is a semicolon-separated string (not a standard JWT)
    used as ``Authorization: Bearer <token>`` for Copilot API requests.
    ``base_url`` is the account-specific API host: the authoritative
    ``endpoints.api`` advertised by the exchange (enterprise/proxied
    accounts), falling back to a host derived from the token's ``proxy-ep``
    field. Individual accounts have neither, so ``base_url`` is None.

    Results are cached in-process and reused until close to expiry.
    Raises ``ValueError`` on failure.
    """
    import urllib.request

    fp = _token_fingerprint(raw_token)

    # Check cache first
    cached = _jwt_cache.get(fp)
    if cached:
        api_token, expires_at, base_url = cached
        if time.time() < expires_at - _JWT_REFRESH_MARGIN_SECONDS:
            return api_token, expires_at, base_url

    req = urllib.request.Request(
        _TOKEN_EXCHANGE_URL,
        method="GET",
        headers={
            "Authorization": f"token {raw_token}",
            "User-Agent": _EXCHANGE_USER_AGENT,
            "Accept": "application/json",
            "Editor-Version": _EDITOR_VERSION,
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode())
    except Exception as exc:
        raise ValueError(f"Copilot token exchange failed: {exc}") from exc

    api_token = data.get("token", "")
    expires_at = data.get("expires_at", 0)
    if not api_token:
        raise ValueError("Copilot token exchange returned empty token")

    # Convert expires_at to float if needed
    expires_at = float(expires_at) if expires_at else time.time() + 1800

    # Resolve the account-specific API base URL. GitHub advertises the
    # authoritative endpoint under ``endpoints.api`` in the exchange response
    # (it differs for Copilot Enterprise / proxied accounts). When the
    # response omits it, fall back to deriving the host from the ``proxy-ep``
    # field embedded in the exchanged token. Individual accounts have neither,
    # so ``base_url`` stays None and callers use the registry default.
    base_url: Optional[str] = None
    endpoints = data.get("endpoints")
    if isinstance(endpoints, dict):
        api_endpoint = str(endpoints.get("api") or "").strip().rstrip("/")
        if api_endpoint:
            base_url = api_endpoint
    if not base_url:
        base_url = _derive_base_url_from_proxy_ep(api_token)

    _jwt_cache[fp] = (api_token, expires_at, base_url)
    logger.debug(
        "Copilot token exchanged, expires_at=%s, base_url=%s",
        expires_at,
        base_url,
    )
    return api_token, expires_at, base_url


def _derive_base_url_from_proxy_ep(token: str) -> Optional[str]:
    """Derive the Copilot API base URL from a proxy-ep field in the token.

    The exchanged Copilot token is a semicolon-separated string like
    ``tid=xxx;exp=xxx;proxy-ep=proxy.enterprise.githubcopilot.com;...``.
    This extracts ``proxy-ep`` and converts it to an API base URL by
    replacing the leading ``proxy.`` with ``api.``.

    Returns ``https://{api_hostname}`` or None if proxy-ep is absent.
    """
    import re
    m = re.search(r'(?:^|;)\s*proxy-ep=([^;\s]+)', token)
    if not m:
        return None

    proxy_ep = m.group(1)
    # Strip scheme if present
    for prefix in ("https://", "http://"):
        if proxy_ep.startswith(prefix):
            proxy_ep = proxy_ep[len(prefix):]
            break
    proxy_ep = proxy_ep.rstrip("/")

    # Replace leading "proxy." with "api."
    if proxy_ep.startswith("proxy."):
        api_host = "api." + proxy_ep[len("proxy."):]
    else:
        api_host = proxy_ep

    return f"https://{api_host}"


# Fingerprints of raw GitHub tokens whose Copilot exchange failed, so we are
# sending the RAW token to the generic ``api.githubcopilot.com`` host instead
# of the account-specific endpoint the exchange would have told us about.
#
# This is survivable on individual Copilot plans (the generic host accepts the
# raw token), which is why the fallback in ``get_copilot_api_token`` exists at
# all.  On a managed/enterprise account it is fatal: the generic host answers
# with a Terms-of-Service 403 that says nothing about the real cause.  Record
# the state here so the error path can explain what actually happened instead
# of surfacing GitHub's legal boilerplate.
_exchange_fallback_fingerprints: set[str] = set()


def copilot_raw_token_fallback_active() -> bool:
    """True when at least one Copilot token is in use un-exchanged.

    Set by :func:`get_copilot_api_token` when the exchange fails and we fall
    back to the raw GitHub token; cleared for that token on a later success.
    """
    return bool(_exchange_fallback_fingerprints)


def get_copilot_api_token(raw_token: str) -> tuple[str, Optional[str]]:
    """Exchange a raw GitHub token for a Copilot API token, with fallback.

    Convenience wrapper: returns ``(api_token, base_url)`` on success, or
    ``(raw_token, None)`` if the exchange fails (e.g. network error, unsupported
    account type). This preserves existing behaviour for accounts that don't
    need exchange while enabling access to internal-only models for those that do.

    ``base_url`` is the account-specific API endpoint advertised by the
    exchange (``endpoints.api``, with a ``proxy-ep`` fallback), or None for
    individual accounts.
    """
    if not raw_token:
        return raw_token, None
    fp = _token_fingerprint(raw_token)
    try:
        api_token, _, base_url = exchange_copilot_token(raw_token)
        _exchange_fallback_fingerprints.discard(fp)
        return api_token, base_url
    except Exception as exc:
        logger.debug("Copilot token exchange failed, using raw token: %s", exc)
        _exchange_fallback_fingerprints.add(fp)
        return raw_token, None


# ─── Copilot API Headers ───────────────────────────────────────────────────

def copilot_request_headers(
    *,
    is_agent_turn: bool = True,
    is_vision: bool = False,
) -> dict[str, str]:
    """Build the standard headers for Copilot API requests.

    Mirrors the official runtime's static CAPI header set
    (copilot-agent-runtime ``src/runtime/src/model/capi_client.rs``
    ``push_static_headers``): honest integration id, pinned GitHub API
    version, and a per-request interaction id.

    ``X-Initiator`` defaults to ``user`` in the reference client and is
    overridden per request for agent-initiated calls; ``is_agent_turn``
    carries that same distinction here. The key is kept lower-case because
    several call sites merge an ``x-initiator`` override into these headers,
    and mixing cases would emit the header twice.
    """
    headers: dict[str, str] = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Editor-Version": _editor_version(),
        "User-Agent": _user_agent(),
        "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
        "X-GitHub-Api-Version": COPILOT_GITHUB_API_VERSION,
        "X-Interaction-Id": str(uuid.uuid4()),
        "Openai-Intent": "conversation-agent",
        "x-initiator": "agent" if is_agent_turn else "user",
    }
    if is_vision:
        headers["Copilot-Vision-Request"] = "true"

    return headers

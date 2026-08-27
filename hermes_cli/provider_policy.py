"""Configurable inference-provider policy shared by every Catalyst surface.

``model_catalog.allowed_providers`` is an opt-in allowlist.  When absent, the
upstream provider universe is unchanged.  Provider aliases are canonicalized so
``github-copilot`` and ``copilot`` describe the same route, while
``copilot-acp`` remains a distinct provider.
"""

from __future__ import annotations

from typing import Any, Iterable


def canonical_provider_id(provider: object) -> str:
    """Return the runtime provider id used for allowlist comparisons."""
    value = str(provider or "").strip().lower()
    if not value:
        return ""
    try:
        from hermes_cli.auth import resolve_provider

        return str(resolve_provider(value) or value).strip().lower()
    except Exception:
        return value


def _configured_allowlist(config: dict[str, Any] | None) -> object:
    catalog = (config or {}).get("model_catalog")
    if isinstance(catalog, dict) and "allowed_providers" in catalog:
        return catalog.get("allowed_providers")

    # A named profile inherits the default profile's safety boundary unless it
    # explicitly declares its own list. This keeps newly-created/imported
    # profiles inside a machine-wide Catalyst provider policy without changing
    # standalone upstream Hermes homes that have no policy configured.
    try:
        from pathlib import Path

        import yaml
        from hermes_constants import get_hermes_home

        home = Path(get_hermes_home())
        if home.parent.name != "profiles":
            return None
        root_config = home.parent.parent / "config.yaml"
        root = yaml.safe_load(root_config.read_text(encoding="utf-8")) or {}
        root_catalog = root.get("model_catalog") if isinstance(root, dict) else None
        if isinstance(root_catalog, dict):
            return root_catalog.get("allowed_providers")
    except Exception:
        pass
    return None


def configured_allowed_providers(config: dict[str, Any] | None) -> tuple[str, ...]:
    """Return the ordered canonical allowlist, or ``()`` when unrestricted."""
    raw = _configured_allowlist(config)
    if not isinstance(raw, list):
        return ()

    allowed: list[str] = []
    for item in raw:
        provider = canonical_provider_id(item)
        if provider and provider not in allowed:
            allowed.append(provider)
    return tuple(allowed)


def provider_is_allowed(provider: object, config: dict[str, Any] | None) -> bool:
    """Whether ``provider`` is permitted by the configured inference policy."""
    allowed = configured_allowed_providers(config)
    return not allowed or canonical_provider_id(provider) in allowed


def filter_allowed_provider_rows(
    rows: Iterable[dict[str, Any]], config: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """Filter standard provider rows while preserving their order."""
    return [row for row in rows if provider_is_allowed(row.get("slug"), config)]


def require_provider_allowed(provider: object, config: dict[str, Any] | None) -> None:
    """Reject inference routes outside the configured provider allowlist."""
    if provider_is_allowed(provider, config):
        return
    from hermes_cli.auth import AuthError

    raise AuthError(
        f"Provider {str(provider)!r} is not allowed. Catalyst is restricted to "
        "GitHub Copilot by model_catalog.allowed_providers."
    )

"""Explicit messaging routes into the same title registry used by Desktop Bot Mode.

A route is transport identity, never canonical conversation identity. Peer recovery
cannot resolve a forever-chat after /resume scaffolding leaves reset fences behind.
"""
from gateway.profile_routing import match_profile_route
from tools.bot_mode_probe import BOT_CHAT_TITLE


class BotChatRoutingError(RuntimeError):
    """An explicitly bound route cannot safely resolve its canonical conversation."""


def bot_chat_route(config, source):
    """Only a deliberate, chat-scoped opt-in joins a messaging lane to Bot Chat."""
    if source is None:
        return None
    route = match_profile_route(
        getattr(config, "profile_routes", None) or [], source.platform.value,
        guild_id=getattr(source, "guild_id", None), chat_id=source.chat_id,
        thread_id=source.thread_id, parent_chat_id=getattr(source, "parent_chat_id", None),
    )
    return route if route is not None and route.bot_chat is True else None


def resolve_bot_chat_row(store, source, session_key):
    route = bot_chat_route(store.config, source)
    if route is None:
        return None
    profile = source.profile or store._active_profile_name()
    if profile != route.profile or getattr(source, "profile_route_rejected", False):
        raise BotChatRoutingError("Bot Chat route does not match the authorized profile")
    db = store._db_for_key(session_key)
    if db is None:
        raise BotChatRoutingError("Bot Chat profile storage is unavailable; refusing a new conversation")
    row = db.get_session_by_title(BOT_CHAT_TITLE)
    if row is None:
        raise BotChatRoutingError("No canonical Bot Chat exists for this route; open the bot in Desktop first")
    if row.get("archived"):
        raise BotChatRoutingError("Canonical Bot Chat is archived; refusing a replacement conversation")
    tip = db.get_compression_tip(row["id"])
    if tip != row["id"]:
        row = db.get_session(tip) if tip else None
    if row is None or row.get("archived"):
        raise BotChatRoutingError("Canonical Bot Chat is unavailable; refusing a replacement conversation")
    return row


def resolve_bot_chat_entry(store, source, session_key, now, *, touch_activity):
    row = resolve_bot_chat_row(store, source, session_key)
    if row is None:
        return None
    # Neither retire the displaced side-chat nor rewrite its transcript. Historical
    # reconciliation is a separate backed-up operation, never a routing side effect.
    with store._lock:
        store._ensure_loaded_locked()
        entry = store._entries.get(session_key)
        if entry is not None and entry.session_id != row["id"] and entry.active_turn_token:
            raise BotChatRoutingError("The previous route has an active turn; wait before changing its binding")
        if entry is None or entry.session_id != row["id"]:
            entry = store._create_entry_from_recovered_row(
                row=row, session_key=session_key, source=source, now=now)
            store._entries[session_key] = entry
        if touch_activity:
            entry.updated_at = now
            entry.suspended = False
        entry.origin = source
    # Persistence errors must surface; silently minting/falling back loses context.
    store._db_for_key(session_key).reopen_session(row["id"])
    store._save_entry(session_key)
    return entry

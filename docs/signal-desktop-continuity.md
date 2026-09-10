# Messaging routes into Desktop Bot Chat

A profile route normally chooses an agent profile, not a conversation. Desktop
Bot Mode independently resolves the session titled exactly `Bot Chat`. To make
an explicitly selected messaging chat use that same conversation, set
`bot_chat: true` on its existing `gateway.profile_routes` entry:

```yaml
gateway:
  multiplex_profiles: true
  profile_routes:
    - name: project-bot
      platform: signal
      chat_id: "group:<actual Signal group ID>"
      profile: project-bot
      enabled: true
      bot_chat: true
```

Use the supported config editor/CLI; preserve the other routes. A boolean and
explicit chat ID are required. Keep the adapter's existing sender/group
allowlists: this option changes conversation selection, not authorization.
Only enable it on a chat whose authorized participants may share the bot's
canonical context. Do not enable broad personal or unrelated group routes.

## Behavior

- Resolve the exact `Bot Chat` title in the routed profile's database on each
  turn and on stale-route recovery. No persistent canonical-session-ID pin and
  no most-recent-session fallback is introduced.
- Follow compression lineage, not ordinary side chats. Missing, archived or
  inaccessible canonical storage fails closed instead of creating a replacement.
- `/new` and `/reset` on an opted-in messaging route request normal compression
  while idle. While that gateway turn is busy, they leave the turn and queue
  intact and ask the user to compact after it finishes. Ordinary sessions retain
  their existing reset behavior.
- The agent's existing durable cross-process turn lease remains the writer
  boundary. Canonical Bot Chat reloads its model context after admission even
  when the lease was uncontended; an idle cached Desktop agent must not miss a
  Signal turn that already completed.
- The existing Desktop roster poll retries deferred/failed canonical transcript
  refreshes rather than consuming the activity watermark while busy. This is
  hydration from the authoritative transcript, not periodic transcript copying.
- Context continuity does not imply unsolicited mirroring of Desktop replies
  into Signal. Delivery remains the originating transport's responsibility.

## Existing split histories

Enabling the route does **not** merge old histories. The displaced Signal
session is preserved. Reconcile a known split before enabling its route:

1. Identify the canonical title row, its compression tip and the exact Signal
   work session(s). Verify profile, chat and authorized sender ownership. Do not
   infer ownership from text similarity or recency.
2. At an agreed idle boundary, prevent new turns and confirm no active writer,
   pending turn or compression can race the migration. A momentary empty lease
   table is not an exclusion lock.
3. Take SQLite-consistent backups of each affected profile DB and the gateway's
   routing DB; preserve the routing mirror and relevant configuration. Record
   hashes, schema and exact affected mappings in a private manifest.
4. Reconcile complete turns only, retaining both original sessions as archives
   and preserving tool-call IDs/arguments/results, timestamps, API sidecars,
   reasoning fields, inactive/compacted rows and compression records. Record an
   original-session/original-row mapping for every imported row. Do not replace
   either history with a summary or deduplicate by content alone.
5. Verify row/field correspondence and active model context before activating
   the route. Refresh cached runtimes only at the agreed maintenance boundary.

This document describes the migration gate; it is not an automatic migration
command. There is no live-history rewrite in the routing change.

## Verification gate

Use `scripts/run_tests.sh` for Python checks and the desktop workspace's
`test:ui`, `typecheck`, `lint`, and build scripts. Test installed behavior
separately:

- Send a distinctive marker through Signal; observe the same user/assistant
  turn in the already-open Desktop Bot Chat without reopening the app.
- Ask from Desktop about that marker; send a different marker from Desktop
  and ask about it through Signal. Record actual responses, profile, canonical
  session and compression-tip IDs.
- Send from both surfaces during a held turn. Verify both inputs survive,
  model execution is serialized, and steering/queue and approval behavior remain
  usable. A lease unit test alone does not establish the cross-surface UX.
- Repeat after a controlled restart and compaction; check that ordinary side
  chats still support `/new`.

Do not call an installed repair complete based only on source, routing-table
pointers or a green test with simulated input.

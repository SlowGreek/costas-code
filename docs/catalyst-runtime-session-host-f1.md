# Catalyst RuntimeSessionHost F1 adversarial review receipt

> **Receipt ID:** `F1-RUNTIME-SESSION-HOST-ADVERSARIAL-69ecfb0b7fcb`  
> **Disposition:** **REQUEST ATTEST F1-RUNTIME-SESSION-HOST-EXTRACTION**  
> **Reviewer:** GPT-5.6 Sol adversarial lane  
> **Authority:** none; this receipt does not authorize an endpoint, persistence, external control, AgentExperiments settlement, or Fleet mutation  
> **Costas HEAD:** `77599046d358ca49703b9c76906f9cc3153fb684` (`users/brianhu/ideation`)

## Scope and verdict

Reviewed the committed provider-neutral extraction at Costas HEAD through its contract, Codex facade/session, turn adapter, compaction path, hard close, soft release, retirement, existing focused tests, and sibling handoff. Production was not edited. The only executable addition is `tests/agent/test_runtime_session_host_adversarial.py`.

**Verdict: GREEN for the bounded process-local extraction.** The adversarial suite falsifies the named F1 risks: generic identity leakage, eager process start, post-close reuse/respawn, duplicate close across ownership exits, compatibility-alias retention, loss of legacy IDs during retirement, stale control retargeting, aspirational capability claims, and accidental registry/persistence/endpoint surface. The expanded focused gate is 161/161 GREEN and Ruff is GREEN.

This is not a verdict on enrolled execution hosting, durable resume/replay, externally authenticated control, durable terminal close proof, exact Fleet write mediation, UI projection, or AgentExperiments acceptance.

## Reviewed anchors

| Artifact | SHA-256 |
|---|---|
| `agent/runtime_sessions.py` | `422f967d50408b1077c885ce2ca64ee253ea8db3d42877819477b2f4d3b24f8a` |
| `agent/transports/codex_app_server_session.py` | `ddf133db43fd555d17a185900d2b4faeb1b98fb91c00553a3d6c93c72344c56e` |
| `agent/codex_runtime.py` | `cfde8f61675cd3a89f61dab986d9e683ac3ca5deb6f09351ad1cefded50a88cf` |
| `agent/conversation_compression.py` | `fc6ec18c299c065ca79d4eab840f2abcb96c43a49d4062fed298e34b57c069f7` |
| `run_agent.py` | `48ba0ef73bce43dfe40a5bc7259ca50165b594fdc2def91385d6e0f4b37d0db8` |
| `tests/agent/test_runtime_session_host_adversarial.py` | `a07fe9aa0bed8c2ed4b9554348adf67c9f85f768079d9e62d0a0f10b5ac7d0d0` |
| `../AgentExperiments/docs/CATALYST-EM-HANDOFF-KX.md` | `9fc0e6b069fa6fef5a1f4d11fcc61004ba89186973209cadb8d9a0fc95909ac1` |

The sibling handoff hash differs from the older hash printed inside that handoff, so these live bytes supersede the historical snapshot as instructed by the document.

## Adversarial evidence

| Risk | Falsifier and observed contract |
|---|---|
| Generic identity leakage | Introspects generic result/capability/protocol surfaces, serializes a projected result carrying sentinel Codex IDs in its private legacy pair, and proves no provider/thread/turn/PID/binding/capability/endpoint identity escapes. |
| Lazy start | Constructs the real `CodexAppServerSession` behind the facade with a fake wire; construction and capability reads create no client. First `send` alone initializes and emits `thread/start`, then `turn/start`. |
| Post-close refusal/no respawn | Every consumed operation after close raises the same `RuntimeSessionClosedError`; an unstarted closed host never creates a client, and a started host never creates a replacement client after close. |
| Exactly-once close | Permutes retirement, `release_clients`, and `close`; the underlying backend closes once while both owning host and private alias are cleared. |
| Private alias cleanup | An observing host proves `_runtime_session_host` and `_codex_session` are both cleared before delegated close executes. |
| Legacy result before retirement | Drives `run_codex_app_server_turn` with `should_retire=True`; the returned outer compatibility result retains private Codex thread/turn IDs even though retirement closes and clears the host immediately afterward. The host's retained pair is consumed. |
| Stale steer/interrupt semantics | Before any turn exists, steer returns false and repeated interrupt creates no process or target. The pending interrupt is consumed by the first send after startup without `turn/start`; the following send starts a fresh turn normally. |
| Unsupported capability truth | Resume-after-restart, durable replay, external control, and durable close proof remain immutable false values with no emulation methods. |
| No registry/persistence/endpoint | AST import audit limits the generic module to `__future__`, dataclasses, and typing; public protocol shape remains five operations plus capabilities; registry/binding/receipt/router/app/database/store surfaces are absent. Repository search finds the host only in the contract, one adapter, its existing consumers, and tests—not gateway, TUI gateway, or ACP endpoints. |

## Verification

Focused command:

```text
/Users/mutilar/.hermes/venvs/costas-code/bin/pytest \
  tests/agent/test_runtime_sessions.py \
  tests/agent/test_runtime_session_host_adversarial.py \
  tests/agent/transports/test_codex_app_server_session.py \
  tests/run_agent/test_codex_app_server_integration.py \
  tests/run_agent/test_codex_app_server_compaction.py \
  tests/run_agent/test_steer.py \
  tests/catalyst_capture/test_control_runtime_capture.py -q
```

Observed for the content-addressed manifest: `161 passed in 43.45s`. A final post-receipt rerun also passed: `161 passed in 42.56s`.

Adversarial file alone: `12 passed in 3.19s`.

Lint command:

```text
/Users/mutilar/.hermes/venvs/costas-code/bin/ruff check \
  tests/agent/test_runtime_session_host_adversarial.py
```

Observed: `All checks passed!`.

## Content-addressed manifest

Canonicalization: UTF-8 JSON, sorted keys, compact separators, one trailing LF. The manifest hashes reviewed production, the adversarial test, live sibling handoff, and observed gates; it intentionally excludes this self-referential receipt file.

```json
{"disposition":"REQUEST ATTEST F1-RUNTIME-SESSION-HOST-EXTRACTION","focused_gate":"161 passed in 43.45s","handoff":{"../AgentExperiments/docs/CATALYST-EM-HANDOFF-KX.md":"9fc0e6b069fa6fef5a1f4d11fcc61004ba89186973209cadb8d9a0fc95909ac1"},"head":"77599046d358ca49703b9c76906f9cc3153fb684","production":{"agent/codex_runtime.py":"cfde8f61675cd3a89f61dab986d9e683ac3ca5deb6f09351ad1cefded50a88cf","agent/conversation_compression.py":"fc6ec18c299c065ca79d4eab840f2abcb96c43a49d4062fed298e34b57c069f7","agent/runtime_sessions.py":"422f967d50408b1077c885ce2ca64ee253ea8db3d42877819477b2f4d3b24f8a","agent/transports/codex_app_server_session.py":"ddf133db43fd555d17a185900d2b4faeb1b98fb91c00553a3d6c93c72344c56e","run_agent.py":"48ba0ef73bce43dfe40a5bc7259ca50165b594fdc2def91385d6e0f4b37d0db8"},"ruff":"All checks passed!","test":{"tests/agent/test_runtime_session_host_adversarial.py":"a07fe9aa0bed8c2ed4b9554348adf67c9f85f768079d9e62d0a0f10b5ac7d0d0"}}
```

Manifest SHA-256: `69ecfb0b7fcb5ffa96c3802180e915ca65b87332ea5fdf218beec3e8c6c8fbd3`.

## Residuals and HOLDs

1. Exact provider resume after backend/process restart is unavailable; a released host is intentionally terminal and a future turn creates a new provider thread.
2. Durable event replay/cursor and durable close proof remain unavailable. In-process `client.close()` is not a signed or durable descendant-terminal receipt.
3. External authenticated control and enrolled AgentExperiments execution-host transport remain unavailable; no endpoint, registry, persistent binding, key store, nonce ledger, or authority-bearing receipt exists in this increment.
4. `_codex_session` remains as a temporary private compatibility alias/fallback. It is cleared on host teardown and excluded from the generic contract, but its eventual removal requires migration of remaining tests/plugins/helpers.
5. The compatibility projection intentionally returns raw Codex thread/turn IDs to the existing outer Codex result dictionary. This review proves they do not enter `RuntimeTurnResult`; it does not authorize renderer/public receipt propagation.
6. Control reachability is live-object/process-local. Stale steer refusal is a boolean and interrupt is idempotent/no-target; there is no durable typed stale-target receipt because no public target type was admitted.
7. Runtime completion/retirement does not settle, accept, release, or mutate AgentExperiments work. Fleet mutation remains HOLD pending private runtime profile and exact below-shell lease mediation.

## Rollback

This lane made no production change. Roll back only the two owned artifacts:

```text
git rm tests/agent/test_runtime_session_host_adversarial.py \
       docs/catalyst-runtime-session-host-f1.md
```

If the already-committed extraction itself must be rolled back, use normal Git history to revert the owning commits after preserving intervening work; do not manually delete shared production files and do not reset the branch. Re-run the prior 149-test gate after any such owner-directed revert.

## Disposition request

**REQUEST ATTEST `F1-RUNTIME-SESSION-HOST-EXTRACTION`** at Costas HEAD `77599046d358ca49703b9c76906f9cc3153fb684`, bounded strictly to the provider-neutral process-local abstraction and migrated existing consumers proven by this receipt.

Continue to **HOLD** enrollment, external control, endpoint/persistence/registry work, durable resume/replay/close claims, visible AgentExperiments role projection, and Fleet mutation until separately dispatched and independently evidenced.

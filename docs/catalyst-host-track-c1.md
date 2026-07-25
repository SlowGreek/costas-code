# Catalyst host track C1 — static integration gate and next sequence

> **ID:** `C1-HOST-TRACK-CONTRACT`  
> **Owner:** Costas host-track integration tests/documentation only  
> **Owned paths:** `tests/catalyst_host/test_host_track_contract.py`, `docs/catalyst-host-track-c1.md`  
> **Authority:** none  
> **Production mutation:** none  
> **Disposition:** `GREEN C1-STATIC`; `HOLD F5-LIVE-COSTAS`; `HOLD F5c-MUTATION`

## Outcome

C1 adds one source-and-fixture integration gate without changing production. It imports the realized provider-neutral runtime contract, reads the content-addressed AgentExperiments F1/F5 receipts, and statically checks a later Costas R0 or visible-child claim only after that owner path exists. An absent future owner path is a named `PENDING` skip. Once the path exists, malformed or broadened behavior fails rather than skipping.

The gate encodes these invariants:

1. Costas runtime, Costas R0, Costas C2, and AgentExperiments F5 path ownership is pairwise disjoint and repository-scoped.
2. Generic host names, methods, result fields, and annotations contain no provider/thread/turn/process identity.
3. `resume_after_restart`, `durable_replay`, `external_control`, and `durable_close_proof` remain literal false capability cells with no generic `resume` or `replay` emulation.
4. AgentExperiments F1 remains `authority=none` with the exact `11 reduced / 5 externally observed / 3 explicitly unavailable` disposition.
5. AgentExperiments F5 remains provisional, `authority=none`, and semantically `HOLD`; deterministic integration may advance, while live cryptographic Costas proof and below-shell F5c mediation remain residuals.
6. If `gateway/execution_host_protocol.py` exists, its AST contains no endpoint decorators and no agent/runtime/HTTP-server/socket imports.
7. If `gateway/catalyst_session_bindings.py` exists, its AST contains the literal `observe`, does not store the binding in `model_config`, and does not expose Codex thread/turn identity.
8. Fleet launch and mutation policy are false; the only proposed first canary is read-only and QUINE remains acceptance owner.
9. The native-edge and visible-host dependency graphs are exact, acyclic, and parallel. F5a is not serialized behind F3/F4.

## Current anchors

| Contract | Current owner anchor | Gate treatment |
|---|---|---|
| provider-neutral runtime waist | `agent/runtime_sessions.py`; `agent/transports/codex_app_server_session.py`; `tests/agent/test_runtime_sessions.py` | imported and asserted now |
| SessionDB child/listability foundation | `hermes_state.py`; `tests/hermes_state/test_external_role_session_binding.py` | typed observe-only binding and bounded child projection realized; live adapter remains absent |
| F1 disposition | `../AgentExperiments/butler/conversation-core/F1-RECEIPT.json` | parsed and asserted now |
| F5 live HOLD | `../AgentExperiments/docs/CATALYST-F5-PROVISIONAL-RECEIPT.json`; `../AgentExperiments/docs/CATALYST-F5-FEEDFORWARD.md:40-47` | parsed and asserted now |
| R0 parser/verifier | `[CLAIMED] gateway/execution_host_protocol.py`; `[CLAIMED] tests/gateway/test_execution_host_protocol.py` | source AST is GREEN here; sibling-owned protocol fixtures are 37/37 GREEN |
| C2 observe binding foundation | `hermes_state.py`; `tests/hermes_state/test_external_role_session_binding.py` | realized durable observe-only binding + bounded child projection; gateway/Desktop enforcement still pending |

The C2 owner correctly landed the durable foundation in SessionDB rather than a parallel gateway store. This
does not authorize a gateway/Desktop observer attachment: backend no-effect enforcement and renderer projection
remain a later C2 increment.

## Exact dependency and order graph

An ordered pair `A → B` means B may not claim readiness before A closes.

### Native-edge track

```text
F0a → F0b → F0c → F1
F1 → F2
F1 → F3
F1 → F4 → F6
F2 → F7a
F3 → F7a
F4 → F7a
F7a → F7b
F6 → F7b
F7a → F8
F7b → F8
```

### Visible-host track

```text
C0 → C1
C1 → A0
C1 → A1
A0 → F5a
A1 → F5a
F5a → F5b → F5c
```

### Convergence only

```text
F1  ⇢ F5a    provider-neutral semantics after attestation
F5a → F7b    one admitted live runtime cell
```

Forbidden dependency edges include `F3 → F5a`, `F4 → F5a`, and `F5a → F1`. Neither track owns the other's private session history, runtime internals, or authority.

## Next C1 sequence

The next bounded sequence is owner-serialized even though the two product tracks remain parallel:

1. **R0 parser/verifier owner** lands only `gateway/execution_host_protocol.py` plus `tests/gateway/test_execution_host_protocol.py`.
   - Closed canonical parse and keyed signature verification only.
   - Independently injected process/bundle/project/profile observations, clock, and replay-state interface.
   - Content-free `verified-not-run` or typed refusal.
   - No socket, route, MCP metadata, key persistence, AIAgent import, runtime lookup, dispatch, provider identity, or effect.
2. **C1 integrator** reruns this gate. The former R0 pending cell must become GREEN; any endpoint/runtime import is RED.
3. **AgentExperiments A0/A1 owners** independently close package and enrollment gates. Their provisional unkeyed challenge digest is never accepted as proof of possession.
4. **C2 visible-binding owner** may start only after enrolled binding input exists. Persist a typed opaque binding with literal `authority="observe"`; do not use `model_config` or infer role from source, lineage, depth, label, or provider identity.
5. **C2 observer enforcement** rejects send, steer, interrupt, branch, compress, delete, archive, approve, and authority upgrade before agent construction or effect. Background events update cache/status only and never open, navigate, select, or focus.
6. **F5a read-only canary** remains blocked until package + enrollment + exact binding + bounded content-free events + exact close are independently green.
7. **F5b control** follows F5a and must refuse stale, foreign, and terminal targets.
8. **F5c launch/mutation** remains disabled until descriptor-relative below-shell lease mediation and independent QUINE acceptance exist.

## Fresh receipt

```text
id: C1-HOST-TRACK-CONTRACT
scope: tests/docs only
production_files_changed: 0
authority: none
runtime_contract: realized
r0_source_claim: GREEN static no-endpoint/no-runtime-import AST gate
r0_fixture_claim: GREEN 37/37 sibling-owned focused tests
c2_binding_foundation: GREEN typed SessionDB observe binding; gateway/Desktop no-effect attachment PENDING
f1_disposition: 11/5/3; authority none
ae_f1_receipt_sha256: fcbe71f1930994b3061fb656bff1146798308c51a403590db2d4c464d731b4da
ae_f5_receipt_sha256: 455fdbfab693666516d433916c9d588aedc9dcfbf1e8433fc62d6bb6c6d5c985
f5_live: HOLD INDEPENDENT INTEGRATION REVIEW
fleet_launch: false
fleet_mutation: false
rollback: remove the two C1-owned paths
```

Verification commands and observed results:

```text
HERMES_PYTHON=/Users/mutilar/.hermes/venvs/costas-code/bin/python \
  scripts/run_tests.sh tests/catalyst_host/test_host_track_contract.py -q

1 file; 9 passed; 0 skipped; 0 failed

HERMES_PYTHON=/Users/mutilar/.hermes/venvs/costas-code/bin/python \
  scripts/run_tests.sh tests/gateway/test_execution_host_protocol.py -q

1 file; 37 passed; 0 failed
```

R0 source exists and passes the no-endpoint/no-runtime-import AST assertion. The C2 durable binding foundation
also exists and activates the strict content-free/observe-only checks. Live gateway/Desktop observer enforcement
and F5 transport remain pending; no skip is interpreted as production readiness.

## HOLDs and falsifiers

- Live F5 stays HOLD until Costas supplies cryptographic possession, independent process observation, content-free transport, and exact durable close.
- R0 opening a route/socket, importing agent/runtime owners, persisting keys, or dispatching anything is RED.
- Generic host APIs exposing provider, thread, turn, or process identity are RED.
- An observer attachment that can construct an agent or cause any control/mutation effect is RED.
- Global exposure of internal subagents, changed ordinary list counts, or `model_config` authority storage is RED.
- Fleet launch or mutation before below-shell mediation is RED.
- Provider terminal state never settles or releases AgentExperiments work.
- F5a does not wait for native Store F3 or fake runtime F4; adding either dependency is RED.

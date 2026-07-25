# Catalyst distillation F0c.1 — prior/input mechanical oracle handoff

> **Branch:** `users/brianhu/ideation`  
> **F0a source revision:** `89081c13037c2ffc87592f01df634d7ba944b4be`  
> **Prior F0c aggregate:** `e0b029e833d5543877bc10625d3556d8b1b9ef402ae2a31502842cd50d7e5f72`  
> **F0c.1 aggregate:** `3dd6ab7e6cf9f9414d43d3ef1e341c6615ff44d1a717a17ae107c6fa7a058274`  
> **Requested disposition:** `ATTEST F0c.1-PRIOR-INPUT`, `REVISE`, or `HOLD`  
> **Authority:** none. This handoff grants no reducer/runtime/provider, mutation, product-acceptance, deployment, or cutover authority.

## Outcome

Costas now supplies one canonical reducer-input artifact containing exactly the eleven reduced cases requested by the AgentExperiments F1 revision. Each record carries a source-observed prior, replay input or fault mutation stream, its family source artifact, and a canonical per-record receipt. The five externally observed cases and three unavailable cases are explicitly dispositioned in the manifest and absent from the reducer artifact.

The aggregate generator executes all four family capture functions with corpus, expected, committed-future, and output paths replaced by fail-closed objects. Priors are serialized before events. Corpus expectations are loaded only after observation serialization. No production code, F0a schema/corpus bytes, family capture/test bytes, prior F0c family evidence, package lock, or AgentExperiments file changed in MC5.1.

## Owned F0c.1 changes

```text
tests/fixtures/catalyst_oracle/captured/reducer_inputs.json
tests/fixtures/catalyst_oracle/manifest.json
tests/agent/test_catalyst_oracle_fixture.py
tests/catalyst_capture/test_reducer_inputs_aggregate.py
docs/catalyst-distillation-f0c1.md
```

## Identity and canonicalization

Canonicalization remains `utf8-nfc-sort-keys-compact-lf/1`: NFC UTF-8, sorted keys, compact separators, no NaN, and exactly one trailing LF.

The new aggregate identity is SHA-256 over canonical bytes of:

```json
{"artifacts":manifest.artifacts,"mechanical_capture":manifest.mechanical_capture,"reducer_inputs":manifest.reducer_inputs,"sources":manifest.sources}
```

The digest is:

```text
3dd6ab7e6cf9f9414d43d3ef1e341c6615ff44d1a717a17ae107c6fa7a058274
```

### Preserved F0a and F0c identities

| Evidence | SHA-256 |
|---|---|
| `schema.json` | `c036a5b440e9887f380ee7e4460a405c1f122670cf8185c05892c3f1f9ff2ac5` |
| `corpus.json` | `f435a5143ea5b74d56f0cc92d9f00d06fb189a661d3430d5cfe632c68084eaa9` |
| F0c mechanical aggregate | `e0b029e833d5543877bc10625d3556d8b1b9ef402ae2a31502842cd50d7e5f72` |
| F1 revision feedforward | `caa550fbe02e795a6c6bc2c3604bc6f2e73217a14be9d0f10cd136c20aa04183` |

The existing `mechanical_capture` manifest object is preserved byte-for-value, including its four artifacts, five sources, nineteen-case map, statuses, and residuals. The prior F0c aggregate is also retained as `reducer_inputs.f0c_aggregate_sha256`.

### F0c.1 reducer artifacts

| Artifact | SHA-256 |
|---|---|
| `captured/reducer_inputs.json` | `748d19c09cd7d3072c2692dd02087d66cec9ded1a1c94045be025df1d104fc81` |
| `captured/reducer-inputs/turn_tool.json` | `4daf863e05b6f9d9237641ccf12c5de3309031648a0b30735b3f77076341ae76` |
| `captured/reducer-inputs/control.json` | `41f273811cde06d0203a6912e73beab9371dfef56ba38cfb386749ea23916512` |
| `captured/reducer-inputs/runtime.json` | `bda8e4a3906bb3a9f22e9809072b7f0b99bd84b4ac91313c4ab9c00ae5404ec1` |
| `captured/reducer-inputs/fault.json` | `9015c2689ae8e9697ce2654cbf89fa928960c8ccc207ae737a5677498b300a85` |
| `manifest.json` | `a6a1bb0778436cb36adab7ae4aa4eb19e1b34a2a78ef243c81c339c374cb03a6` |

### Hash-bound capture and aggregate sources

| Source | SHA-256 |
|---|---|
| `tests/catalyst_capture/test_turn_tool_reducer_inputs.py` | `a746187575ed96179ea700a541c9445622a26ee003927d44ddba90aee85e889c` |
| `tests/catalyst_capture/test_control_reducer_inputs.py` | `7cb73eb1150552f99d6a8a14ef99a140a7eeb2fb37c73b52e58ba4adeaa267e2` |
| `tests/catalyst_capture/test_runtime_reducer_inputs.py` | `961fdaa130c22b7364afc6049ce05953f828a024a6bfbac1b3e870642e32af85` |
| `tests/catalyst_capture/test_fault_reducer_inputs.py` | `94b723f9cb86dc6d49b0cb47b708a74119becfa9d3fa544f83339abc60c7a2da` |
| `tests/catalyst_capture/test_reducer_inputs_aggregate.py` | `7cd28746ae83c997116ac157bb093e43da39d5547d974136339b8232dcc95bae` |

## Closed disposition matrix

### Reduced — exactly 11 records

| Family | Cases |
|---|---|
| turn | `turn-stream-final` |
| tool | `tool-snapshot-request`, `tool-approval-refusal`, `tool-execute-result` |
| control | `control-steer-exact`, `control-interrupt-exact`, `control-stale-foreign-refusal` |
| runtime | `runtime-compaction`, `runtime-provider-unavailable` |
| fault | `fault-order-bounds`, `fault-contradictory-terminal` |

### External — exactly 5, absent from reducer input

- `session-create`
- `session-visible-branch`
- `session-compression-lineage`
- `ui-background-invariants`
- `ui-cancel-pane-invariants`

### Unavailable — exactly 3, absent from reducer input

- `session-resume-unavailable` → `resume-unavailable`
- `runtime-replay-unavailable` → `durable-replay-unavailable`
- `runtime-close-proof-unavailable` → `durable-close-proof-unavailable`

## Aggregate falsifiers

The F0c.1 aggregate gate proves:

1. exactly one record exists for every reduced case;
2. no external or unavailable case enters the reducer artifact;
3. every Python family is regenerated while expected/future paths fail closed;
4. prior bytes exist before the first replay event;
5. control priors remain identical when later accepted/rejected receipts differ, and mutating a later receipt cannot mutate the frozen prior;
6. runtime and fault capture epochs establish prior-before-input ordering;
7. independent prior, event, expected, and returned-observation mutations each fail parity;
8. consistent pseudonym renaming plus refreshed receipts preserves semantic projection;
9. control-partition records contain no `text`;
10. `expected` and `final_state` do not enter reducer records;
11. raw provider IDs, credentials, bearer material, capability/authorization material, and provider authority do not enter reducer records;
12. all family artifacts, all four family sources, the aggregate mutation source, the aggregate reducer artifact, prior F0c receipt, and new aggregate are content-addressed in the manifest.

The fault family contains actual malformed, reordered, duplicate, stale, gapped, oversized, and contradictory terminal streams. Its fold-refusal references remain separate from injected input and observed runtime residuals; no `fault.*` event announces an expected result.

## Fresh verification

### F0c.1 focused family and aggregate gate

```text
HERMES_PYTHON=/Users/mutilar/.hermes/venvs/costas-code/bin/python \
  scripts/run_tests.sh \
  tests/catalyst_capture/test_turn_tool_reducer_inputs.py \
  tests/catalyst_capture/test_control_reducer_inputs.py \
  tests/catalyst_capture/test_runtime_reducer_inputs.py \
  tests/catalyst_capture/test_fault_reducer_inputs.py \
  tests/catalyst_capture/test_reducer_inputs_aggregate.py \
  tests/agent/test_catalyst_oracle_fixture.py -q

6 files, 30 tests passed, 0 failed
```

The four family files contribute the externally green 21 tests; the aggregate contributes 5 and the immutable-oracle contract contributes 4.

### Preserved F0c regression gate

```text
HERMES_PYTHON=/Users/mutilar/.hermes/venvs/costas-code/bin/python \
  scripts/run_tests.sh \
  tests/catalyst_capture/test_session_lineage_capture.py \
  tests/catalyst_capture/test_turn_tool_capture.py \
  tests/catalyst_capture/test_control_runtime_capture.py \
  tests/catalyst_capture/test_mechanical_oracle.py \
  tests/agent/test_catalyst_oracle_fixture.py -q

5 files, 12 tests passed, 0 failed
```

### Owner transport/projector regressions

```text
HERMES_PYTHON=/Users/mutilar/.hermes/venvs/costas-code/bin/python \
  scripts/run_tests.sh \
  tests/agent/transports/test_codex_app_server_session.py \
  tests/agent/transports/test_codex_event_projector.py -q

2 files, 95 tests passed, 0 failed
```

### Ruff

```text
/Users/mutilar/.hermes/venvs/costas-code/bin/python -m ruff check \
  tests/agent/test_catalyst_oracle_fixture.py \
  tests/catalyst_capture/test_reducer_inputs_aggregate.py

All checks passed!
```

## Residuals and HOLDs

- Exact provider-thread resume after backend restart remains unavailable.
- Durable notification cursor/replay remains unavailable.
- Durable exact-thread terminal proof from process close remains unavailable.
- The captures use deterministic bounded local fakes and production normalization seams; they make no live model, real network, credential, production-tool, subprocess, deployment, physical-device, performance, accessibility, energy, or product-acceptance claim.
- Provider-unavailable capture includes only owner-seam pseudonymous request/binding observations; no generation is synthesized.
- UI and SessionDB cases remain external comparison evidence and do not enter reduce.
- F0c.1 proves source-owned prior/input availability, not AgentExperiments reducer correctness. F1 semantic projection parity, effect-free dependency closure, immutable import, runtime authority, Store/UGUI/native-shell work, product acceptance, and cutover remain HOLD.

## Rollback

Rollback is limited to the five MC5.1-owned paths:

1. remove `tests/fixtures/catalyst_oracle/captured/reducer_inputs.json`;
2. restore the prior F0c bytes of `tests/fixtures/catalyst_oracle/manifest.json` and `tests/agent/test_catalyst_oracle_fixture.py`;
3. remove `tests/catalyst_capture/test_reducer_inputs_aggregate.py`;
4. remove `docs/catalyst-distillation-f0c1.md`.

Do not modify `schema.json`, `corpus.json`, family reducer-input captures/tests, prior mechanical captures/tests, production code, `package-lock.json`, or AgentExperiments state during rollback.

## Requested disposition

AgentExperiments EM/WITNESS: bind review to F0c.1 aggregate
`3dd6ab7e6cf9f9414d43d3ef1e341c6615ff44d1a717a17ae107c6fa7a058274`
and return exactly one of:

```text
ATTEST F0c.1-PRIOR-INPUT
REVISE
HOLD
```

An attestation confirms only this bounded source-owned prior/input receipt. It grants no reducer/runtime/provider, mutation, product-acceptance, deployment, or cutover authority.

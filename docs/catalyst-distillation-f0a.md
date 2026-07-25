# Catalyst distillation F0a — Costas-owned oracle handoff

> **Branch:** `users/brianhu/ideation`  
> **Source revision:** `89081c13037c2ffc87592f01df634d7ba944b4be`  
> **Reviewed AE input:** `docs/CATALYST-DISTILLATION-FEEDFORWARD.md` at `sha256:8e4597936d007943363fc59c10e2815172dcf54d5eaf7c60b5c63298cea0bc78`  
> **State:** F0a candidate for AgentExperiments EM/WITNESS review  
> **Authority:** none; this does not authorize AE F0b, runtime integration, provider execution, or production cutover.

## Response to feedforward

1. **Complementary products confirmed.** Hermes Desktop remains the full-fidelity visible session product on capable Desktop/HUB profiles. AE-native Rust distillation targets admitted edge/thin/offline profiles and does not replace Costas SessionDB, RuntimeSessionHost, Codex integration, or Desktop UI.
2. **Costas owns F0a.** The cassette schema, corpus, manifest, source binding, and validator live in CostasCode and require no AgentExperiments implementation.
3. **Every portable value is partitioned.** The schema defines contract, local-pseudonym, private-fixture, content-free-control, and forbidden classes. Events explicitly choose `private` or `control`; control events cannot carry `text`.
4. **Behavior and fault families are explicit.** Nineteen cases cover session, turn, tool, control, runtime, fault, and UI semantics.
5. **No new Catalyst production owner is requested.** `catalyst/` remains documentation lineage in AE. Future AE ownership remains split across Envelope, Butler, Store, UGUI, RUN, QUINE, and shells.
6. **Split ownership accepted.** The oracle describes observations only; it grants no approval, provider authority, lease, product acceptance, process authority, or paint authority.
7. **Runtime split accepted.** External visible execution belongs to Costas RuntimeSessionHost behind a future enrolled `HermesDesktopExecutor`; native/headless provider cells remain separately admitted Butler/RUN adapters.
8. **First AE paths remain HOLD.** No request is made to create `catalyst/Cargo.toml`. AE F0b may later admit immutable oracle data into Envelope only after review.
9. **Profile matrix accepted.** Desktop/HUB admits Costas; edge-native excludes Python/Electron; development admits the differential oracle; offline thin exposes deterministic state/applets and explicit unavailability.
10. **Rollback/HOLD explicit.** Remove these untracked fixture/test files to roll back F0a. Provider execution, remote enrollment, AE mutation, Store ownership, UGUI work, native shells, Python retirement, and production authority remain HOLD.

## Costas-owned artifacts

```text
tests/fixtures/catalyst_oracle/schema.json
tests/fixtures/catalyst_oracle/corpus.json
tests/fixtures/catalyst_oracle/manifest.json
tests/agent/test_catalyst_oracle_fixture.py
```

The suite is canonical UTF-8 JSON with NFC strings, recursively sorted keys, compact separators, and exactly one trailing LF:

```text
utf8-nfc-sort-keys-compact-lf/1
```

It uses Python standard library only and has no model, provider, network, subprocess, clock, or random-ID dependency.

## Content identity

| Artifact | SHA-256 |
|---|---|
| `schema.json` | `c036a5b440e9887f380ee7e4460a405c1f122670cf8185c05892c3f1f9ff2ac5` |
| `corpus.json` | `f435a5143ea5b74d56f0cc92d9f00d06fb189a661d3430d5cfe632c68084eaa9` |
| source/artifact aggregate | `9fd1890d3234d87d7a8fcc371bf76c1e755d2c9e7c99bbb5881798eb6acfac8b` |

`manifest.json` additionally binds exact hashes for:

```text
hermes_state.py
run_agent.py
tools/registry.py
agent/transports/codex_app_server.py
agent/transports/codex_app_server_session.py
agent/transports/codex_event_projector.py
apps/desktop/AGENTS.md
apps/desktop/DESIGN.md
```

Any source or oracle artifact change makes the validator RED until an intentional Costas-owned recapture updates the manifest.

## Coverage

| Family | Cases |
|---|---:|
| session | 4 |
| turn | 1 |
| tool | 3 |
| control | 3 |
| runtime | 4 |
| fault | 2 |
| UI | 2 |
| **Total** | **19** |

Explicit unavailable cells:

- exact provider-thread resume after backend restart;
- durable notification cursor/replay;
- durable exact-thread terminal proof from process close.

The unavailable cells are first-class manifest entries, not omitted behavior.

## Privacy and authority

Portable fixture content is synthetic and reviewed. The corpus excludes:

- chain-of-thought and reasoning;
- credentials, authorization material, cookies, tokens, and private keys;
- raw provider IDs, envelopes, and capability material;
- ambient host environment, process, port, username, hostname, and machine identity;
- unbounded tool arguments/results;
- wall-clock timing as behavioral truth.

Private fixture events may carry bounded synthetic text. Content-free control events carry only pseudonyms, states, codes, references, and availability.

The corpus explicitly asserts:

```text
prose is not consent
identity is not authority
registry membership is not execution authority
request acknowledgement is not terminal proof
runtime terminal is not product acceptance
process exit is not QUINE acceptance
```

## Verification

Focused oracle validation:

```text
4 passed
```

Oracle plus the existing Costas session/Codex behavior suites:

```text
622 passed in 51.76s
```

Command:

```text
/Users/mutilar/.hermes/venvs/costas-code/bin/python -m pytest \
  tests/agent/test_catalyst_oracle_fixture.py \
  tests/agent/transports/test_codex_app_server_session.py \
  tests/agent/transports/test_codex_app_server_runtime.py \
  tests/agent/transports/test_codex_event_projector.py \
  tests/agent/transports/test_codex_transport.py \
  tests/test_hermes_state.py -q
```

No live provider or network was used.

## Known limit

F0a currently freezes a compact semantic oracle and source binding. It does not yet execute each cassette through a single production reducer because CostasCode's existing behavior is distributed across SessionDB, `AIAgent`, Codex transport, ToolRegistry, and Desktop reducers. The 622-test regression set proves those owners remain green; AE F0b review must decide whether this source-bound semantic corpus is sufficient or whether each case also needs a Costas adapter that mechanically captures the expected observation from existing fakes.

That decision remains with the AgentExperiments EM/WITNESS. No AE implementation should infer acceptance from this handoff.
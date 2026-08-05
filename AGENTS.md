<!-- GENERATED — DO NOT EDIT. The quine daemon regenerates it from AXIOMS.json (the human-in-the-loop canon). Read as SOT. (Also derives from this area's SPEC.) -->

---
applyTo: 'catalyst/**'
---

# `catalyst` — area instructions (delta only)

> Root `AGENTS.md` governs and is always loaded — the 🐧 protocol, RLHF/eng-manager rules, and the *daemon-gates-you-don't* validation doctrine live THERE. This file adds ONLY what is specific to `catalyst`.

## AREA — `catalyst`

> Catalyst desktop product shell — Electron + React hosts the canonical RUN executive and UGUI Documents, routes bounded semantic intents to their exact owners, and packages one immutable AE generation without owning RUN, Butler, QUINE, or Store authority

### Codegen passes (this area's generators — source → artifact)

The quine daemon runs these automatically on change — you never invoke them (read `QUINE.md`). Listed for provenance:

| **PASS** | **INPUTS** | **OUTPUTS** | **GENERATOR (DAEMON-RUN)** |
|---|---|---|---|
| `lint` (receipt) | `SPEC.json`, `package.json`, `package-lock.json`, `scripts/quality/**/*`, `apps/desktop/**/*` | `quality/lint-report.json` | `node catalyst/scripts/quality/lint.mjs` |
| `test` (receipt) | `SPEC.json`, `package.json`, `package-lock.json`, `scripts/quality/**/*`, `apps/desktop/**/*` | `quality/test-report.json` | `node catalyst/scripts/quality/test.mjs` |
| `coverage` (receipt) | `SPEC.json`, `package.json`, `package-lock.json`, `scripts/quality/**/*`, `apps/desktop/**/*` | `quality/coverage-report.json` | `node catalyst/scripts/quality/coverage.mjs` |


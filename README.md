<!-- GENERATED/DO-NOT-EDIT: rust-quine-project-readmes/v1 -->
# Catalyst

Catalyst is the Electron and React desktop product shell that composes, inspects, and authors against one staged AgentExperiments generation.

**Role:** Catalyst is a peripheral desktop executive surface: it hosts native lifecycle and renderer interaction while routing canonical runtime and projection semantics to their owners.

## Purpose
- Compose the canonical executive and UGUI-derived experiences into an operable Electron desktop shell. Evidence: `evidence.executive`, `evidence.electron-main`.
- Execute local pinned quality tools and publish deterministic machine reports without converting known failures into green claims. Evidence: `evidence.spec`, `evidence.quality-common`, `evidence.quality-lint`, `evidence.quality-test`, `evidence.quality-coverage`.

## Invariants and boundaries

### Invariants
- **invariant.host-does-not-own-runtime.** Desktop composition never transfers canonical runtime, projector, evaluator, or persistence ownership into Catalyst. Evidence: `evidence.executive`, `evidence.generation`.
- **invariant.report-equals-observation.** A committed quality report equals the stable shaping of the adapter execution that produced it. Equation: `committed_report = stable_json(shape(executed_local_tool_output))` Evidence: `evidence.quality-common`, `evidence.quality-lint`, `evidence.quality-test`, `evidence.quality-coverage`.
- **invariant.default-writes-check-compares.** Default mode writes atomically; check mode performs the same observation, writes nothing, and fails on any byte drift. Evidence: `evidence.quality-common`.

### Boundaries
- **boundary.host-not-authority.** Catalyst owns desktop composition, packaging, and interaction, not RUN, Butler, QUINE, Store, Envelope, or UGUI semantic authority. Evidence: `evidence.executive`, `evidence.generation`.
  - Rejects: desktop copies of canonical runtime semantics; renderer claims of external effect success; mutable edits to a staged generation
- **boundary.observed-quality-only.** Quality reports represent executed TypeScript, ESLint, Vitest, and V8 observations and remain red when exact findings exist. Evidence: `evidence.quality-lint`, `evidence.quality-test`, `evidence.quality-coverage`.
  - Rejects: fabricated green reports; discarded skipped tests; coverage percentages without measured totals

## Mechanisms and flow

### Mechanisms
- **mechanism.desktop-composition.** Electron and React compose one selected AgentExperiments generation into desktop host and renderer surfaces. Evidence: `evidence.generation`, `evidence.electron-main`, `evidence.executive`.
  - Steps: Resolve and stage the parent-pinned repository generation.; Atomically select the complete generation.; Start Electron host lifecycle.; Render the executive surface and route bounded interactions.
  - Consequences: Incomplete generations are not selected.; Canonical owners remain outside Catalyst.
- **mechanism.deterministic-quality.** Each adapter executes its pinned local tool, shapes bounded stable JSON, then atomically writes or exactly compares its owned report. Evidence: `evidence.quality-common`, `evidence.quality-lint`, `evidence.quality-test`, `evidence.quality-coverage`.
  - Steps: Collect and hash the declared source closure.; Execute TypeScript and ESLint, Vitest, or Vitest V8 coverage.; Preserve failures, skips, and measured totals.; Serialize stable JSON.; Write by rename or compare exact bytes in check mode.
  - Consequences: Known lint findings remain visible and red.; Skipped test truth and coverage denominators survive projection.; Source or tool-output drift makes check mode fail.

### Inputs
| Contract | Source | Meaning |
| --- | --- | --- |
| input.ae-generation | A parent-pinned AgentExperiments repository generation | A staged immutable generation with repository-root and current-generation selection rules. |
| input.desktop-interaction | Renderer interaction and Electron host events | Typed desktop intents and bounded host messages admitted by the owning renderer and Electron seams. |
| input.quality-source | Catalyst manifests, quality scripts, Desktop configuration, Electron source, renderer source, scripts, and tests | The deterministic source closure declared by SPEC and collected by scripts/quality/common.mjs. |

### Outputs
| Contract | Target | Meaning |
| --- | --- | --- |
| output.desktop-shell | Electron desktop users | A React renderer hosted by an Electron main process over one selected AgentExperiments generation. |
| output.quality-reports | quality/lint-report.json, quality/test-report.json, and quality/coverage-report.json | Stable JSON preserving exact lint findings, per-suite test truth, and measured line and branch totals. |
| output.project-canon | Envelope project-canon discovery and MORPH projection | agentexperiments-project-canon/1 for catalyst at registry row 19. |

### Handoffs
- **handoff.catalyst-canon-to-envelope.** output.project-canon Evidence: `evidence.spec`.
  - Preconditions: Catalyst CANON validates against the closed parent schema.; Evidence paths and line ranges resolve.; Known lint and physical-proof residue remain explicit.
  - Postconditions: Envelope may admit Catalyst semantics for MORPH projection.; Projection may change presentation but not ownership, observations, evidence, residue, or handoff meaning.
  - From: output.project-canon
  - To project: envelope
  - To input: input.project-canon

## Evidence and current truth

| Evidence | Location | Establishes |
| --- | --- | --- |
| evidence.package | `package.json` | The root workspace exposes the three Catalyst quality adapters and pins the Node engine. |
| evidence.spec | `SPEC.json` | The area manifest registers lint, test, and coverage report passes, source closures, and quality obligations. |
| evidence.quality-common | `scripts/quality/common.mjs` | Shared quality code bounds source capture, executes local tools, normalizes diagnostics, and atomically writes or exactly checks stable JSON. |
| evidence.quality-lint | `scripts/quality/lint.mjs` | The lint adapter executes three TypeScript projects plus ESLint and preserves every observed violation in checks and findings. |
| evidence.quality-test | `scripts/quality/test.mjs` | The test adapter executes UI and Electron Vitest projects and records per-suite passed, failed, skipped, todo, total, and failures. |
| evidence.quality-coverage | `scripts/quality/coverage.mjs` | The coverage adapter runs V8 coverage and records measured line and branch totals. |
| evidence.vitest-config | `apps/desktop/vitest.config.ts` | Desktop Vitest configuration defines the UI and Electron projects consumed by the quality adapters. |
| evidence.executive | `apps/desktop/src/app/ae-executive/index.tsx` | The renderer composes the AgentExperiments executive experience in the desktop product shell. |
| evidence.electron-main | `apps/desktop/electron/main.ts` | The Electron main process owns native desktop lifecycle and bounded host integration. |
| evidence.generation | `apps/desktop/scripts/ae-generation.mjs` | Generation staging publishes immutable AgentExperiments assets and atomically selects a current generation. |

## Limitations and residuals

### Residuals
- **residue.known-lint-red.** The current Catalyst lint report is RED because exact ESLint violations remain; this contract records rather than conceals them. Evidence: `evidence.quality-lint`.
  - Cause: Existing Desktop source includes lint errors and warnings outside this contract task.
  - Visibility: explicit-in-every-projection
- **residue.physical-desktop-proof.** Source tests and machine reports do not prove installation, signing, accessibility, graphics, audio, network, or physical desktop behavior. Evidence: `evidence.spec`, `evidence.electron-main`.
  - Cause: Those claims require separate packaged-host and physical execution evidence.
  - Visibility: explicit-in-every-projection

### Failure modes
- **failure.quality-findings-or-drift.** Typecheck or ESLint reports a violation, tests fail, coverage execution fails, or regenerated stable JSON differs from committed bytes. Evidence: `evidence.quality-common`, `evidence.quality-lint`, `evidence.quality-test`, `evidence.quality-coverage`.
  - Consequence: The corresponding adapter exits nonzero and does not claim green.
  - Detection: Tool status, exact findings, test failure counts, missing coverage summary, and byte comparison are checked.
  - Behavior: reject-and-report
- **failure.generation-or-host-unavailable.** The AgentExperiments repository root, required staged artifact, generation publication, or Electron host prerequisite is unavailable. Evidence: `evidence.generation`, `evidence.electron-main`.
  - Consequence: The desktop experience cannot safely represent the canonical generation.
  - Detection: Repository-root resolution, staging checks, atomic selection, and host startup surface the failure.
  - Behavior: fail-closed

## Glossary

| Term | Definition |
| --- | --- |
| generation | A completely staged immutable AgentExperiments artifact set selected atomically for the desktop host. |
| machine report | Stable committed JSON derived from a fresh local quality execution rather than a narrated or fabricated status. |

<details>
<summary>Generation details</summary>

| Fact | Value |
| --- | --- |
| Source | `catalyst/CANON.json` |
| Source SHA-256 | `sha256:5dd9028e7d4410d28cd45470986447f8a0450af0bf444bc8496c5847ddc50d4d` |
| Generator | `quine/src/project_readmes.rs` |
| Registry | `quine/canon/repo_map.json#/19` |
| Projection schema | `rust-quine-project-readmes/v1` |
| Tool version | `0.1.0` |

</details>

# Catalyst voice-first developer control — Twitch reflex, bounded SLM, receipted effects

> **Kind:** architecture and first vertical slice  
> **Date:** 2026-07-25  
> **Source contracts:** AE `docs/TWITCH-KX.md`; AE two-flow SLM seam; Catalyst voice conversation  
> **Authority:** voice grants none  
> **Invariant:** no transcript, SLM output, or renderer component becomes an arbitrary shell command

## 0 · Disposition

Catalyst should be voice-first for controlling its own development environment, but voice is an input modality—not
process authority.

The architecture is two-flow:

```text
microphone / injected transcript
             │
             ▼
      closed Twitch matcher ── exact hit ──▶ local navigation / reveal
             │ miss
             ▼
 bounded developer classifier (future admitted local SLM)
             │
             ├─ known read-only plan ──────▶ Electron developer host
             ├─ known consequential plan ─▶ WITNESS confirmation ─▶ Electron developer host
             └─ unknown / semantic work ──▶ Butler conversation / engineering dispatch
```

The forbidden architecture is:

```text
transcript → generated shell string → exec
```

No lane accepts that shape.

## 1 · What AE contributes

### 1.1 Twitch fire path

AE's Twitch invariant is the key design move:

- closed codebook;
- deterministic normalized matching;
- model-free fire path;
- miss escalates rather than fuzzy-firing;
- generated vocabulary from the affordance source of truth;
- no network/model/allocation dependency on the reflex;
- off-path learning may propose codebook changes but never joins the fire path;
- refusal and feedback prevent bad aliases from silently repopulating.

### 1.2 Transcript-source K(x)

Transcription is a producer behind one event contract. The matcher does not care whether text came from:

- hosted/browser STT;
- native host STT;
- current Catalyst `/api/audio/transcribe`;
- a deterministic dev injection fixture.

Catalyst already has the production-quality pieces needed by this model:

- microphone capture;
- VAD and silence closure;
- transcription;
- voice-conversation state;
- streaming TTS;
- barge-in that retains the user's first syllable;
- explicit start/end/mute controls.

The first developer-control slice therefore reuses the existing voice conversation. Dictation remains dictation.
Only submitted voice-conversation transcripts enter the reflex matcher.

### 1.3 Two-flow SLM

AE's SLM contract exposes one bounded distinction:

```text
reflex     enable_thinking=false
           deterministic mechanical classification

deliberate enable_thinking=true
           bounded reasoning for semantic ambiguity
```

The currently checked-out AE tree no longer exposes the historical Python seam named in the one-pager. Catalyst must
not pretend an unavailable SLM exists. The future lane requires a registered local model endpoint, exact model identity,
fixed sampling, response schema validation, and telemetry receipt before activation.

## 2 · Shipped first slice: local developer Twitch

The first slice is intentionally effect-free.

### 2.1 Derived executive navigation

Voice phrases are generated from `AE_EXECUTIVE_TABS`, including Marketplace:

```text
open home
show dashboard
go to lucid
open quine
show scores
show metrics
show logs
open studio
show settings
show marketplace
```

A new registered executive anchor automatically gains these phrases. There is no second hand-authored route map.

### 2.2 Existing Desktop actions

A tiny allowlist maps exact phrases to existing keybind action IDs:

```text
open command palette  → nav.commandPalette
show command palette  → nav.commandPalette
show files             → view.showFiles
open files             → view.showFiles
show terminal          → view.showTerminal
open terminal          → view.showTerminal
```

The voice layer does not reimplement handlers. It emits one validated registered action ID through the same mounted
keybind runtime keyboard users invoke.

### 2.3 Exact-match behavior

```text
show marketplace
  → Twitch hit
  → local navigation
  → haptic selection
  → voice loop settles to idle/listening
  → no user chat bubble
  → no model turn

review the rich twitch architecture
  → codebook miss
  → unchanged Butler submission
  → normal thinking/streaming speech flow
```

Fuzzy forms such as `show me the logs` intentionally miss today. False negatives are cheap—they reach Butler. False
positive process control is not acceptable.

## 3 · Closed intent wire

```ts
type DevControlIntent =
  | {
      schema: 'hermes-dev-control-intent/1'
      lane: 'twitch'
      action: 'navigate'
      phrase_id: string
      route: `/ae/${string}`
    }
  | {
      schema: 'hermes-dev-control-intent/1'
      lane: 'twitch'
      action: 'invoke'
      phrase_id: string
      action_id: 'nav.commandPalette' | 'view.showFiles' | 'view.showTerminal'
    }
```

Properties:

- transcript text is not carried after matching;
- external event payloads are validated against the exact generated registry;
- forged routes and unknown action IDs are ignored;
- no filesystem path, argument vector, environment, shell, or arbitrary payload exists in the wire;
- the listener is renderer-local and has no native bridge.

## 4 · Developer operation taxonomy

### D0 — Twitch, local and immediate

Allowed:

- navigate to a registered Catalyst/UGUI destination;
- reveal an existing pane idempotently;
- open command palette;
- focus a named accessible control when derived from the live accessibility tree;
- read a cached, non-sensitive status through a bounded projection.

No confirmation, model, backend, or process spawn.

### D1 — read-only developer plans

Examples:

```text
inspect repository status
show changed files
show current build stamp
show test status
show Catalyst health
show backend logs
```

These may be classified by a future deterministic SLM but execute only a registered argv template. They return a
content-free receipt plus a bounded display projection.

### D2 — bounded build/test plans

Examples:

```text
run focused tests
run Desktop typecheck
build Catalyst
package Catalyst without launch
```

These are process effects. They require:

- an enrolled source checkout identity;
- clean registered plan ID;
- fixed executable and argv template;
- bounded cwd and timeout;
- one active instance per plan/profile;
- streamed status and cancel handle;
- terminal receipt with exit code and output digest.

They do not require destructive confirmation, but voice must repeat the exact admitted plan before launch when the
classifier confidence is not exact.

### D3 — consequential lifecycle plans

Examples:

```text
restart Catalyst
replace the running package
apply migrations
publish or deploy
reset state
```

These require explicit WITNESS confirmation bound to:

- operation ID;
- source checkout hash;
- build artifact hash;
- exact plan ID and argv digest;
- affected process/app identity;
- expiry and idempotency key.

No automatic retry after possible dispatch. Ambiguity becomes `dev-control-outcome-unknown` and must be reconciled.

### D4 — semantic engineering work

Examples:

```text
fix the failing test
refactor the Marketplace state model
review this architecture
implement voice-first developer control
```

These are not local process plans. They remain Butler/Engineer work through the existing chat and dispatch system.

## 5 · Future SLM classifier

The SLM never emits commands. It selects among a closed candidate list supplied by the host:

```json
{
  "schema": "hermes-dev-control-classify/1",
  "utterance_hash": "sha256:<hex>",
  "candidates": [
    "desktop.status",
    "desktop.test.focused",
    "desktop.typecheck",
    "desktop.build",
    "desktop.package",
    "desktop.restart",
    "butler.fallback"
  ],
  "reasoning": false
}
```

Validated response:

```json
{
  "schema": "hermes-dev-control-classification/1",
  "plan_id": "desktop.typecheck",
  "confidence_milli": 997,
  "needs_confirmation": false,
  "reason_code": "exact-typecheck-request"
}
```

Rules:

- deterministic model identity, seed, and temperature zero;
- transcript byte bound;
- closed candidates supplied by the host;
- no path, argv, environment, or shell in model input/output;
- confidence is advisory and cannot authorize;
- low confidence routes to Butler or asks a closed clarification;
- deliberate mode may explain ambiguity but still selects only one candidate or fallback;
- model output is never persisted with raw transcript in a public receipt.

## 6 · Electron developer host

Electron is the only valid owner for local process effects. A future narrow capability should expose:

```text
listPlans()                   read-only plan metadata
preflight(plan_id, scope)     resolved checkout/artifact hashes; no spawn
start(plan_id, operation_id)  spawn fixed executable/argv; returns process receipt
status(operation_id)          bounded log projection + state
cancel(operation_id)          exact process cancellation
reconcile(operation_id)       post-ambiguity observation
```

Plan example:

```json
{
  "id": "desktop.typecheck",
  "effect": "read-build",
  "executable": "npm",
  "argv": ["run", "typecheck"],
  "cwd_owner": "enrolled-costas-checkout",
  "timeout_ms": 600000,
  "confirmation": "none",
  "concurrency": "singleton"
}
```

The registry is code/data owned by Electron. Renderer, voice, SLM, and Butler may select a plan ID but cannot alter its
execution template.

## 7 · Receipt model

```text
hermes-dev-control-receipt/1
  operation_id
  plan_id
  lane                 twitch | slm-reflex | slm-deliberate | butler
  principal
  source_checkout_hash
  artifact_hash
  argv_digest
  started_at / completed_at
  state                admitted | running | completed | refused | cancelled | outcome-unknown
  exit_code
  stdout_digest / stderr_digest
  named_losses[]
  confirmation_receipt
  receipt_sha256
```

Twitch navigation receipts may remain in-memory observability events. D1–D3 process plans require durable bounded
receipts. Raw transcript, secrets, full environment, and unbounded output are omitted.

## 8 · Barge-in and cancellation

Catalyst's current barge-in behavior becomes developer-control behavior naturally:

```text
Catalyst speaks build progress
→ WITNESS says “cancel build”
→ playback stops at first syllable
→ transcript is classified
→ exact operation ID is selected from the sole active cancellable plan
→ Electron cancel
→ cancellation receipt
→ spoken settlement
```

`cancel build` is not a Twitch until there is exactly one visible cancellable operation and the phrase is derived from
that live operation identity. Otherwise it asks a closed clarification.

## 9 · Voice coverage gate

Omnimodality must be generated and gated:

```text
registered D0 affordances ⊆ generated voice phrases
registered developer plans ⊆ classifier candidates
consequential plans ⊆ confirmation policy
all executable plans ⊆ Electron plan registry
```

Adding a D0 navigation/view action without at least one generated phrase should fail the voice-coverage gate. Adding a
process plan without effect class, timeout, checkout owner, cancellation policy, and receipt schema should fail plan
validation.

## 10 · Next implementation sequence

1. **Landed:** derived D0 executive navigation and safe view action reflexes.
2. Add an in-app dev-control pulse/receipt projection so local hits are visible and screen-reader announced.
3. Define Electron `desktop.status` as the first D1 plan; no process spawn.
4. Add `desktop.typecheck` as the first D2 registered process plan with status/cancel receipt.
5. Admit a local SLM classifier only after exact runtime/model telemetry is available.
6. Add package/restart only after D3 confirmation and outcome reconciliation exist.
7. Add voice-coverage generation from keybind/palette/UGUI action registries.

## 11 · Exit predicates

```text
voice-first developer control
= exact local reflexes bypass the model
∧ misses preserve normal Butler behavior
∧ transcript sources are swappable behind one contract
∧ SLM selects only closed plan IDs
∧ no model or renderer emits shell text
∧ Electron owns every process effect
∧ consequential effects require WITNESS confirmation
∧ every process has status, cancellation, and terminal receipt
∧ barge-in can cancel the exact active operation
∧ voice coverage is generated and red-on-drift
```

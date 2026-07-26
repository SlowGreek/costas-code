# RUN-UGUI WITNESS audit — profile workspaces, one evidence ladder

> **Kind:** Costas consumer audit and enrichment feedforward  
> **Date:** 2026-07-25  
> **Costas structural UGUI admission:** `c8a628d441d65fb311e780cb1dfbf8419bfd6217`  
> **Costas honest structural status:** `48f221a1b744f264cbb54f30fd87fa44d6d2f2cc`  
> **Packaged Scene batch SHA-256:** `73515bf88870dc5c2915f2855876c866d873a1134c4f534c5da07eebb827b3cb`  
> **Authority:** none  
> **Audit subject:** signed Catalyst package using the packaged `ae-executive-scene` adapter

## 0 · Disposition

The current nine tabs remain a useful **WITNESS BRIANHU workspace preset**, but they are not a universal ontology.
A generalized UGUI shell adds MARKETPLACE as the discovery/recovery anchor and permits profile-specific qualified
applet tabs such as Calculator or Snake.

```text
BRIANHU preset
  HOME · DASHBOARD · LUCID · QUINE · SCORES · METRICS · LOGS · STUDIO · SETTINGS · MARKETPLACE

compact example
  HOME · MARKETPLACE · CALCULATOR · SNAKE
```

The missing cross-cutting capability remains a WITNESS evidence ladder:

```text
signal
→ exact subject identity
→ source owner and observation episode
→ canonical evidence / content hash
→ receipt chain and named losses
→ bounded drilldown
→ human disposition only when WITNESS authority is required
```

Evidence inspection should be available from every tab without duplicating canonical evidence or creating a tenth
static dashboard.

A future WITNESS inbox is justified only if pending attestations, consent gates, and irreversible human decisions
become durable cross-domain work. It must not be introduced as a substitute for making the existing controls and
drilldowns real.

## 1 · Measured packaged state

The packaged batch is renderer-neutral and structurally semantic:

```text
schema        ae-executive-scene-batch/1
authority     none
scenes        9
batch bytes   144,955
terminal text 0 ANSI / box-drawing rows
tab handlers  9 ordered shell.tab.* handlers per Scene
elastic GEOM  1 height:"*" region per Scene
```

Live restart evidence:

```text
Catalyst PID                  89717
backend port                  59713
boot failures                 0
MCPServerTask exceptions      0
Event loop closed traces      0
packaged Butler               live
```

### 1.1 Tab matrix

| Tab | Nodes | Primary semantics | Unique local intents | Scene receipt | Current limiting fact |
|---|---:|---|---:|---:|---|
| HOME | 17 | identity, companion, voice state | 0 | no | `asset://` companion has no Desktop catalog |
| DASHBOARD | 51 | system tree, readiness, evidence summaries | 0 | no | rows are not selectable |
| LUCID | 28 | command, output, request status | 2 | no | command/change and execute are not bridged |
| QUINE | 65 | board, fleet, routing, cost, evidence | 9 | yes | every detail route is inert in Desktop |
| SCORES | 48 | seven score families and aggregate status | 0 | no | unavailable appears as zero-like progress |
| METRICS | 36 | CPU, RSS, power, fidelity, readiness | 0 | no | sample canvases are empty and uncited |
| LOGS | 21 | bounded stream, query, source, receipt slice | 2 | no | filter values are not bridged |
| STUDIO | 769 | gallery, lenses, applet metadata | 9 | no | giant eager Scene; every lens/action is inert |
| SETTINGS | 268 | grouped constants, selected detail, access | 1 | no | rows are not selectable; toggle is inert |

There are 23 unique non-tab handler intents in the packaged batch. Costas currently executes none of them. Tab
navigation works because `shell.tab.*` has a dedicated, closed route. Other handlers produce a bounded notice and
no effect, which is safe but not yet a drilldown experience.

## 2 · Cross-cutting trust audit

### 2.1 Structural validity is not trust

Costas validates:

- exact nine-tab order;
- Scene major/version and node graph references;
- stable card identity where applicable;
- one elastic region for normalized card Scenes;
- exact ordered shell handlers;
- absence of terminal-shaped ANSI/box prose.

That proves the input is structurally admissible. It does not prove:

- producer identity;
- source commit;
- observation time;
- current freshness;
- content-hash preimage;
- signature or attestation;
- final painter fidelity;
- authority or settlement.

The Desktop footer now says:

```text
Rendered · structure valid · authority none · freshness unverified
```

and uses a neutral structural indicator rather than an emerald trust indicator.

### 2.2 Receipts are incomplete

Only QUINE currently carries a top-level Scene receipt. The other eight Scenes have no producer receipt. The batch
has no closed batch receipt.

Required end state:

```text
batch receipt
  batch_id
  producer identity/version
  source commit + source aggregate
  emitted_at
  observation episode / sequence
  canonical batch hash
  per-tab Scene hashes

Scene receipt
  scene_id + revision
  subject identity
  source fact identities
  observed_at + max_age
  canonical Scene hash
  effect/refusal references
  upstream fidelity

Desktop realization receipt
  source Scene hash
  surface identity/metrics
  painter version
  observed losses by node
  final fidelity
```

The Desktop realization receipt must downgrade upstream fidelity when Costas introduces a loss. HOME currently
renders `asset-catalog-unavailable`; it may not inherit an upstream `FULL` claim unchanged.

### 2.3 Freshness is not bounded

`loadExecutiveScenes()` retains one module-level Promise for the renderer lifetime. A successful batch never
refreshes; a rejected Promise also remains cached. Text such as `fresh`, `running`, `Ready`, and `LIVE` can therefore
outlive its observation episode.

Required:

- `revision` and monotonic `sequence`;
- `observed_at`, `emitted_at`, and `max_age`;
- active-tab refresh or subscription;
- profile/runtime invalidation;
- retry after failed load;
- stale-response rejection by revision;
- explicit stale/expired/unknown rendering.

### 2.4 Identity must be typed and layered

The experience uses BRIANHU and profile-scoped language, but the batch does not bind:

- profile identity;
- repository identity;
- role-session identity;
- host process episode;
- observation episode;
- request/operation identity;
- Scene subject identity.

Use opaque or hash-bound correlation identities where raw identifiers are private. Distinguish:

```text
eligible
observed
bound
attested
capability-authorized
confirmed
executed
settled
```

No earlier rung implies a later rung.

## 3 · Interaction architecture audit

### 3.1 Dead controls

Current local handlers include:

```text
LUCID
  lucid.command.change
  lucid.execute

QUINE
  shell.navigation.open.quine.executive.health
  shell.navigation.open.quine.executive.fleet
  shell.navigation.open.quine.executive.routing
  shell.navigation.open.quine.executive.cost
  shell.navigation.open.quine.skilltree
  shell.navigation.open.quine.plexus
  shell.navigation.open.quine.mermaid
  shell.navigation.open.quine.evidence
  shell.applet.close

LOGS
  logs.query.change
  logs.source.change

STUDIO
  studio.lens.gallery
  studio.lens.play
  studio.lens.inspector
  studio.lens.source
  studio.lens.ops
  studio.lens.ports
  studio.applet.previous
  studio.applet.next
  studio.applet.open

SETTINGS
  settings.toggle
```

None are reduced or dispatched today.

### 3.2 Values are lost

The current painter callback carries only an action string. Input/select values are not part of the event. React
retains input drafts by `node.id`; LUCID and LOGS both use `card-act-0`, allowing cross-Scene draft collision.
A later authoritative Scene value can also be masked by the retained React draft.

The smallest safe next protocol is a closed event envelope:

```json
{
  "schema": "ae-executive-event/1",
  "tab": "lucid",
  "scene_id": "run-lucid",
  "scene_revision": 42,
  "node_id": "card-act-0",
  "event": "change",
  "value": "show --view pulse"
}
```

Rules:

- Desktop sends node identity + event + bounded typed value, never an arbitrary handler supplied by the model.
- The authoritative UGUI runtime re-resolves the handler from the exact current Scene.
- Stale revisions fail closed.
- UGUI folds presentation-only state.
- Effectful/domain intent crosses to RUN/Butler/domain owner.
- The response is a revised Scene, typed navigation, receipt, or refusal.
- Desktop paints; it does not own the reducer.

### 3.3 Geometry fidelity

Costas currently maps `height:"*"` to flex remainder and numeric heights to shrink-only. This is an important
improvement, but it is not yet the full UGUI GEOM result. Row `justify`, resolved boxes, overflow, focus order, and
quantized extents remain partly CSS-derived.

Target:

```text
Scene + Desktop surface metrics
→ UGUI GEOM resolved boxes/focus/overflow
→ Desktop realizes exact boxes
→ Desktop records quantization/losses
```

## 4 · Tab-by-tab enrichment

### 4.1 HOME

Keep WITNESS identity and presence here.

Add:

- registered asset catalog for companion/background composition;
- explicit observed/unobserved voice state;
- identity-detail affordance with alias, animal, world, enrollment episode, profile scope, freshness, and source;
- local UGUI onboarding reducer;
- enrollment persistence intent and receipt;
- no implication that identity grants role or capability.

### 4.2 DASHBOARD

Make every system-tree subject selectable.

Detail panel:

- exact subject identity and owner;
- current state and reason;
- freshness and observed time;
- evidence path/hash/receipt;
- dependencies and children;
- blocker and typed next action;
- links to canonical QUINE evidence and filtered LOGS.

Add snapshot diff (`current` versus prior accepted observation) rather than duplicating full evidence.

### 4.3 LUCID

Highest-priority effect surface.

Add:

- typed command draft in UGUI view state;
- grammar-aware verb/argument assistance;
- preflight posture without authority inflation;
- pending, refusal, confirmation, outcome-unknown, and settled states;
- exact receipt card and reconciliation action;
- link to QUINE evidence and correlated LOGS slice;
- no automatic retry for effect-capable verbs.

### 4.4 QUINE

Make this the canonical evidence drilldown owner.

Required route stack:

```text
executive overview
→ board / fleet / routing / cost / skilltree / plexus / diagram / evidence
→ selected fact or receipt
→ exact cited source
→ back to prior lens with selection retained
```

Every claim should show subject, owner, freshness, reason, hash, receipt, and next action. Missing evidence remains an
explicit blocker.

### 4.5 SCORES

Do not render unavailable evidence as zero-looking progress.

For each score family expose:

- observed value or nonnumeric unavailable state;
- maximum/threshold;
- observation window;
- source set and source hashes;
- attribution/completion identity;
- computation receipt;
- trend/delta;
- recovery action.

### 4.6 METRICS

Add actual bounded samples or an explicit no-samples state.

Drilldown:

- observation timestamp/window and cadence;
- unit and aggregation method;
- source identity;
- threshold and current disposition;
- unavailable/stale cause;
- exact sample export/hash;
- correlated QUINE receipt.

### 4.7 LOGS

Make query/source/paging UGUI view state.

Selected entry detail:

- source and stream;
- exact sequence/time;
- severity;
- operation/dispatch correlation;
- bounded payload;
- content hash and receipt citation;
- retention/truncation evidence.

### 4.8 STUDIO

The current 769-node eager Scene is too large for the default overview.

Add:

- paged/virtualized gallery;
- selection state in UGUI;
- lazy Gallery/Play/Inspector/Source/Ops/Ports lenses;
- canonical selected applet Scene hosting;
- Scene/model/state diff;
- source and replay hashes;
- effect and port-fidelity receipts;
- no flattening of applet Scene into prose.

### 4.9 SETTINGS

The current 268-node Scene needs selection/search/folding.

Separate:

- LIVE presentation preferences;
- LOCKED authored constants;
- effective value;
- authored value/source;
- profile override;
- pending mutation;
- accepted receipt or rollback.

Permitted presentation changes become typed persistence intents. Domain/authority changes route to registered LUCID
SET targets and Butler confirmation.

## 5 · WITNESS inspector — cross-cutting, not a tenth tab

Every selectable fact should open one generic inspector with:

```text
Summary
  human-readable claim and state

Identity
  subject · owner · scope · correlation IDs

Time
  observed · emitted · max age · sequence · freshness

Evidence
  source URI/path · source commit · canonical bytes/hash · receipt ID

Authority
  none / capability required / confirmation required / settled

Fidelity
  upstream fidelity · Desktop losses · fallback · final fidelity

History
  prior state/hash · current state/hash · transition receipt

Actions
  copy citation · open canonical owner · reconcile · request WITNESS disposition
```

The inspector consumes typed evidence references. It never reads arbitrary paths from Scene text.

## 6 · WITNESS decision workflow

If cross-domain human decisions become durable work, define one closed workflow before considering a tenth tab:

```text
pending item
why WITNESS authority is required
bounded evidence bundle
closed choices with no implicit default
confirmation
immutable decision receipt
settlement link
```

A future `/ae/witness` tab should be an inbox/detail/disposition surface for those items only. It must not become a
second QUINE evidence board or a generic notification center.

## 7 · Prioritized implementation

### P0 — truth before breadth

1. `ae-executive-event/1` typed event/value/revision bridge.
2. UGUI presentation reducer response path.
3. Effect routing to RUN/Butler with receipt/refusal settlement.
4. Revisioned active-tab refresh and failed-load retry.
5. Closed batch/Scene receipts with temporal semantics.
6. Desktop realization receipt and named losses.

### P1 — evidence-addressable drilldown

1. QUINE route stack and cited evidence detail.
2. Generic WITNESS inspector.
3. Dashboard subject selection and cross-links.
4. LUCID settled operation timeline.
5. Logs entry detail and correlation.
6. Score/metric evidence details.

### P2 — scale and fidelity

1. Studio lazy lenses and canonical Scene hosting.
2. Settings search/selection/folding.
3. Registered UGUI asset catalog.
4. UGUI-resolved Desktop GEOM boxes.
5. Scene patching/streaming for large or live tabs.
6. Optional WITNESS inbox only after a closed decision contract exists.

## 8 · Exit predicates

```text
WITNESS-ready executive
= every visible claim has typed identity and freshness
∧ every drilldown resolves to canonical evidence
∧ every effect settles with receipt or refusal
∧ every painter loss is named and chained
∧ no structural-validity indicator implies trust
∧ no unavailable state appears as an observed zero
∧ no enabled control is inert
∧ no renderer owns domain or authority transitions
∧ stale results cannot overwrite newer state
∧ every pinned tab preserves one UGUI semantic/GEOM authority
∧ Marketplace exposes only catalog-qualified applets and grants no authority
```

The current nine remain a preset. Marketplace and the qualified applet catalog generalize the workspace without
weakening the evidence ladder.

# Costas as a UGUI theme-morphing projection engine

> **Kind:** keystone GenUI alignment proposal + first implemented vertical slice
> **Date:** 2026-07-26
> **Status:** first slice implemented; visual attestation remains `pending`
> **Canonical skin owner:** AgentExperiments UGUI generated StyleModel catalog
> **Host:** Catalyst / Hermes Desktop (`costas-code/apps/desktop`)

## 0 · Executive disposition

Costas previously called color palettes **skins**, but its type contract explicitly confined themes to colors and
typography while geometry, radius, density, line-height, shadows, motion, and chrome remained static CSS. That made a
Windows 95 skin impossible without ad hoc component forks: silver/teal colors could be applied, but the same rounded,
blurred, airy, glass-native React tree remained underneath.

The corrected model is:

```text
theme         optional palette/typography seed (VS Code themes, Hermes terminal skins)
render profile UGUI StyleModel point over eight closed axes
skin          canonical generated identity + provenance + render profile
projection    host realization of the profile over unchanged semantic UI
codebook      interaction/semantic vocabulary, invariant under skin change
```

A skin is not a CSS file and not a React component. It is a canonical, generated, validated parameter bundle over:

1. palette;
2. typography;
3. geometry;
4. border model;
5. elevation/material;
6. density;
7. motion;
8. chrome.

The same semantic UI must retain node IDs, accessible names, values, navigation, actions, and authority when these axes
change.

## 1 · Canonical evidence

UGUI owns the authored market census and generated bindings:

```text
AgentExperiments/ugui/skins/skins.json
AgentExperiments/ugui/skins/binding-values.json
AgentExperiments/ugui/skins/bindings/*.json
AgentExperiments/ugui/json/capability-model.json#/style
AgentExperiments/ugui/src/theme*.rs
```

The closed StyleModel slots are declared in `capability-model.json`:

```text
palette typography geometry border-model elevation density motion chrome
```

The generated Windows 95 binding carries, among other facts:

```text
surface             #c0c0c0
on-surface          #000000
accent/titlebar     #000181
desktop             #008081
radius              0px
stroke              2px
bevel               outset
shadow blur         0px
spacing             4px
control height      23px
motion              0ms
scrollbar            16px
```

The generated glassmorphism binding carries:

```text
surface             rgba(17,25,40,0.75)
on-surface          #ffffff
accent              #60a5fa
radius              12/16/20px
stroke              1px
shadow blur         24px
backdrop blur       20px
spacing             8/16/24/32/48px
motion              150/250/400ms
window frame        none
```

Every generated binding states:

```text
visual_attestation: pending
```

Vocabulary coverage is not visual fidelity proof. Costas preserves that posture.

## 2 · Implemented dependency direction

```text
UGUI authored census + binding values
              │ codegen
              ▼
UGUI generated binding JSON ────────────────┐
UGUI public theme catalog                   │
              │                             │
              ├─ ae-skin-settings-scene ───▶ nested UGUI card ─▶ checked Scene
              │                             │
              └─ staged binding JSON ──────▶ Electron strict adapter
                                              │
                                              ▼
                                    hermes-render-profile/1
                                              │
                                 renderer independent admission
                                              │
                                  root data attrs + closed CSS vars
                                              │
                                  shared semantic slots/primitives
```

Costas does not re-author Windows 95 or glass values. Its adapter reads the generated UGUI binding bytes, validates
provenance and all eight slots, hashes the source bytes, and normalizes the values into bounded renderer-neutral axes.

## 3 · First UGUI-owned cog Settings slice

The HERMES DESKTOP cog Appearance page now mounts a UGUI-owned skin settings Scene before legacy controls.

Producer:

```text
AgentExperiments/run/src/bin/ae-skin-settings-scene.rs
```

Closed request:

```json
{
  "schema": "ae-skin-settings-request/1",
  "committed_id": "glassmorphism",
  "preview_id": "windows-95"
}
```

Closed response:

```json
{
  "schema": "ae-skin-settings-scene/1",
  "authority": "none",
  "projector": "ugui::theme::CATALOG->nested-card->ugui::project_checked",
  "scene": {}
}
```

The card is composed from the public generated `ugui::theme::CATALOG`, uses the nested-card resolver, and exposes only:

```text
skin.preview.<canonical-id>
skin.apply
skin.revert
```

It surfaces committed/preview identity, all eight axis counts, fidelity disposition, named losses, and pending visual
attestation. React does not author the preset list or evidence rows.

## 4 · Typed Scene events

The generic Costas Scene painter now supports a typed event seam while retaining the legacy executive adapter:

```ts
interface UguiSceneEvent {
  schema: 'ugui-scene-event/1'
  scene_id: string
  revision: number
  node_id: string
  gesture: 'change' | 'key' | 'submit' | 'tap'
  action: string
  payload: null | { value: string }
}
```

Properties:

- button taps carry no arbitrary payload;
- input submit carries the current value;
- select change carries the selected value;
- scene and node identity are explicit;
- revision is projected from the Scene receipt when present;
- existing executive tabs can still consume `onAction(action)` during migration;
- skin settings consumes typed events and rejects unexpected scene/revision/payload/action combinations.

The next UGUI phase should move this schema into canonical generated Rust/TypeScript bindings and add the full closed
key/drag/numeric payload variants.

## 5 · Electron authority and durable state

Renderer preview is ephemeral and immediate. Durable apply is Electron-owned.

```text
get(profile)
  -> revision + profile_id

commit(profile, profile_id, expected_revision, idempotency_key)
  -> compare-and-swap
  -> private atomic file write
  -> fresh authoritative read-back
  -> bounded hash receipt
```

Implementation:

```text
apps/desktop/electron/render-profile-prefs.ts
```

Guarantees:

- profile scope is explicit;
- revision conflicts fail closed;
- identical idempotency keys replay one terminal receipt;
- private mode-0600 temporary writes are atomically renamed;
- a fresh read-back must match the committed profile and revision;
- renderer accepts apply only after response plus explicit read-back;
- failure visibly restores the previously committed projection;
- preview never persists.

## 6 · Closed renderer realization

The admitted profile projects to 22 closed CSS variables plus four root data attributes:

```text
data-ugui-skin
data-ugui-border
data-ugui-chrome
data-ugui-motion
```

```text
--morph-surface
--morph-on-surface
--morph-accent
--morph-border-color
--morph-desktop
--morph-titlebar
--morph-translucency
--morph-font-family
--morph-radius-sm/md/lg
--morph-stroke-width
--morph-grid-unit
--morph-spacing
--morph-control-height
--morph-hit-target
--morph-shadow
--morph-backdrop-blur
--morph-motion-duration/easing
--morph-scrollbar-width
--morph-titlebar-height
```

No raw binding value becomes a selector, module import, script, external asset, shell command, or arbitrary host call.

The initial realization covers globally shared semantic slots:

```text
buttons and tabs
inputs and select triggers
menus, dialogs and popovers
UGUI Scene roots
root/app surfaces and desktop background
radius and stroke
control density
bevel/outline treatment
shadow/backdrop blur
motion policy
titlebar height
scrollbar width
```

Legacy hardcoded classes still exist in long-tail components. The shared-variable layer intentionally overrides the
highest-leverage semantic slots first; each later migration should delete hardcoded render assumptions rather than add
skin-specific component branches.

## 7 · Theme beneath skin

VS Code imports and Hermes terminal-shaped backend skins remain useful as palette sources. They cannot claim full-skin
identity because they do not carry all eight axes.

The application order is:

```text
palette theme paint
→ active UGUI render-profile paint/geometry/chrome projection
```

Thus a user may retain a preferred code/color palette beneath a canonical render profile, while a profile such as
Windows 95 can override semantic surface roles required for its fidelity.

## 8 · Semantic and authority laws

1. Skin changes never alter routes, node IDs, accessible names, state meaning, action IDs, or authority.
2. Generated Scenes and bindings have `authority: none`.
3. Host effects are selected only by closed action IDs.
4. Unknown profiles, fields, axes, actions, primitives, malformed graphs, unsafe IDs, and stale revisions fail closed.
5. Preview is optimistic and reversible; Apply is authoritative only after Electron read-back.
6. Profile persistence never bleeds across Hermes profiles.
7. Reduced-motion preferences override authored motion.
8. Visual fidelity remains pending until packaged evidence passes.
9. Skin-specific semantic React branches are forbidden.
10. Agent-authored arbitrary CSS is forbidden.

## 9 · What is deliberately not claimed

This slice does **not** yet claim:

- complete migration of every hardcoded component radius/shadow/spacing;
- pixel parity with original Windows 95 or Apple glass materials;
- native traffic-light/caption-button replacement;
- completed assistive-technology execution evidence;
- a final generic revisioned UGUI reducer host;
- visual attestation;
- cross-platform native material parity.

The legacy Appearance controls remain below the UGUI card as a tested fallback during migration.

## 10 · Next migration phases

### Phase 1 — completed in this slice

- stage canonical generated binding JSON;
- strict Electron and renderer admission;
- global eight-axis projection;
- UGUI-owned nested cog settings Scene;
- typed Scene event compatibility seam;
- Electron-owned CAS persistence and read-back;
- Windows 95 versus glass proof pair.

### Phase 2 — canonical editable GenUI loop

- add canonical `ugui-scene-event/1`, reducer-result, and host-effect schemas in AE;
- generate Rust and TypeScript bindings;
- move committed/preview/pending/revision state into a deterministic UGUI reducer;
- return effect result events to the reducer;
- reject stale/replayed events at the canonical boundary;
- remove the skin-settings surface's local action reducer.

### Phase 3 — host abstraction cleanup

- migrate titlebar, pane shell, sidebar, composer, tool cards, trees, inputs, tabs, scrollbars, and overlays onto semantic
  morph variables;
- delete fixed radii/shadows/density from shared primitives;
- derive hit targets and accessibility fallbacks separately from visual density;
- keep native chrome facts as named approximations/refusals.

### Phase 4 — evidence and attestation

- packaged screenshots for the same semantic scenarios under Windows 95 and glass;
- computed-style assertions across all eight axes;
- keyboard focus order and screen-reader labels invariant;
- contrast and hit-target checks;
- reduced-motion verification;
- profile/window/restart persistence and rollback;
- source/artifact hash-bound receipts;
- only then update target-specific visual attestation.

## 11 · Current evidence

Focused gates at implementation time:

```text
AE skin settings producer:          2 passed
Electron generated binding adapter: 3 passed
Electron settings Scene admission:  2 passed
Electron preference authority:      3 passed
Renderer render-profile admission:  3 passed
Renderer profile lifecycle:         3 passed
Typed Scene painter events:         2 passed
Existing theme context:             3 passed
Existing executive consumer:       20 passed
TypeScript / ESLint / diff:          green
```

Live staging produced:

```text
25 generated canonical skin binding JSON files
78-node nested skin-settings Scene
closed preview/apply/revert action family
```

## 12 · Exit predicate

```text
Costas is a UGUI theme-morphing projection engine
= skin ontology is generated by UGUI
∧ all eight axes are admitted and projected
∧ semantic Scene/actions remain invariant
∧ cog settings is UGUI/GenUI-owned
∧ preview is ephemeral and reversible
∧ durable apply is Electron-owned, CAS-bound, and read back
∧ no arbitrary CSS/code/effect authority crosses the Scene
∧ Windows 95 and glass visibly diverge without component forks
∧ every named loss remains visible
∧ visual attestation changes only after packaged evidence
```

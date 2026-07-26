# UGUI Marketplace K(X) — profile workspaces, qualified applets, stable mnemonics

> **Kind:** architecture and integration contract  
> **Date:** 2026-07-25  
> **State:** Costas dynamic consumer landed; UGUI shell implementation pending  
> **Costas checkpoint:** `4b8b4b9df01b73800065675dbeb4a116404f77eb`  
> **Authority:** presentation and profile workspace preference only  
> **Invariant:** pinning an applet grants no capability or domain authority

## 0 · Correction

The current nine executive tabs are not a universal ontology. They are the current WITNESS BRIANHU workspace seed.

A generalized UGUI shell supports profile-specific pinned applet instances:

```text
WITNESS BRIANHU default
  HOME · DASHBOARD · LUCID · QUINE · SCORES · METRICS · LOGS · STUDIO · SETTINGS · MARKETPLACE

Example compact profile
  HOME · MARKETPLACE · CALCULATOR · SNAKE

Example operations profile
  DASHBOARD · QUINE · METRICS · LOGS · MARKETPLACE
```

MARKETPLACE is the discovery/recovery anchor. It exposes qualified UGUI applets, their trust/fidelity evidence, and
profile-scoped pinning. It is not a second package manager, authority broker, or app runtime.

## 1 · Existing owners to reuse

### 1.1 Canonical catalog

`ugui/json/applet-catalog.schema.json` already provides `ugui-applet-catalog/2.0.0` with:

- stable applet ID and source path;
- source SHA-256;
- name/category/header glyph;
- grid/dock placement metadata;
- capability availability and reason;
- Studio document identity/hash;
- interaction kinds;
- qualification evidence and receipt;
- per-surface playable / playable-with-loss / unavailable disposition;
- named losses and capability-manifest binding.

MARKETPLACE consumes this catalog. It must not scrape `ugui/apps/`, infer trust from filenames, or create a parallel
manifest.

### 1.2 Runtime

The existing UGUI app host already mounts interpreted Rhai applets and compiled twins under the same Scene contract.
Current evidence includes calculator and snake packages. Pinning selects an applet instance for the workspace; it does
not alter the runtime or bypass admission.

### 1.3 Studio

Studio remains the development workbench:

- source, inspector, ops, ports;
- replay and revisions;
- applet authoring/editing;
- canonical Scene hosting.

Marketplace is the user discovery/install/pin surface. It may link to Studio for inspect/edit, but it does not absorb
Studio.

### 1.4 Costas

Costas is a generic Scene consumer. It now accepts:

- the exact legacy nine-tab seed; or
- a bounded profile workspace of 1–36 safe unique tab IDs containing `marketplace`.

For every Scene it requires:

- the exact same ordered `shell.tab.<id>` list;
- one unique bracketed mnemonic per tab;
- the same mnemonic mapping across all Scenes;
- safe slug IDs;
- no duplicate tabs.

Costas validates the allocation but does not allocate hotkeys.

## 2 · Workspace model

The UGUI shell owns one profile-scoped workspace state:

```text
WorkspaceState
  schema
  profile_scope
  revision
  preset
  pinned[]
  selected_instance
  hotkey_policy
  hotkey_assignments[]
  source_catalog_sha256
  receipt
```

A pinned row is conceptually:

```json
{
  "instance_id": "calc",
  "applet_id": "calc",
  "label": "Calculator",
  "glyph": "🧮",
  "source_sha256": "<catalog-bound sha256>",
  "qualification_receipt_sha256": "<receipt sha256>",
  "pin_order": 2,
  "mnemonic": "A",
  "mnemonic_source": "name-scan",
  "surface_status": "playable"
}
```

`instance_id` permits multiple instances later (`calc-tax`, `calc-budget`) without changing applet identity.

### 2.1 Anchors and presets

- `marketplace` is required in a generalized workspace so users can recover/add tabs.
- The legacy exact-nine batch remains accepted during migration.
- A preset is a seed, not authority and not a permanent core set.
- HOME may be included by profile policy but is not required by the dynamic wire.
- Unpinning does not delete applet data or uninstall source.
- Pinning does not execute the applet.

### 2.2 Bounds

```text
catalog entries     ≤ 256  (existing catalog bound)
pinned direct tabs  ≤ 36   (A–Z + 0–9 mnemonic space)
instance id bytes   ≤ 128
label bytes         ≤ 128
workspace revision  monotonic
```

A workspace may expose more applets through Marketplace than it can pin as direct mnemonic tabs.

## 3 · MARKETPLACE card

MARKETPLACE uses the existing normalized card grammar and Scene primitives.

Conceptual card:

```json
{
  "id": "ugui-marketplace",
  "header": [
    {"type":"text","text":"MARKETPLACE","style":"heading","height":1},
    {"type":"text","text":"Qualified UGUI applets","style":"caption","height":1}
  ],
  "sections": [
    {"id":"market-results","type":"nested","title":"Discover","sections":[],"height":"*"},
    {"id":"market-selection","type":"key_value","rows":[],"height":1},
    {"id":"market-fidelity","type":"key_value","rows":[],"height":1}
  ],
  "actions": [
    {"id":"market-search","type":"input","label":"Search applets","value":"","width":7,"height":1},
    {"id":"market-category","type":"select","label":"Category","options":[],"width":3,"height":1},
    {"id":"market-pin","type":"button","label":"Pin","action":"marketplace.pin","width":2,"height":1},
    "WORKSPACE_TAB_ACTIONS"
  ]
}
```

`WORKSPACE_TAB_ACTIONS` is documentation shorthand for the expanded, UGUI-generated action list.

### 3.1 Catalog row

Each result exposes:

- name, glyph, category, applet ID;
- source SHA-256;
- qualification receipt SHA-256 and status;
- interaction kinds;
- capability availability/reason;
- Desktop/native/web/terminal fidelity;
- named losses;
- pinned/open state;
- assigned mnemonic or unassigned reason.

Unavailable applets remain discoverable with an explicit reason. They cannot be pinned as runnable tabs unless the
workspace policy permits a visible unavailable placeholder.

### 3.2 Marketplace actions

Presentation-only:

```text
marketplace.search.change
marketplace.category.change
marketplace.select
marketplace.page.next
marketplace.page.previous
marketplace.inspect
```

Profile persistence intents:

```text
marketplace.pin
marketplace.unpin
marketplace.reorder
marketplace.hotkey.request
marketplace.hotkey.swap
```

Runtime/navigation:

```text
marketplace.open
marketplace.open-in-studio
shell.tab.<instance-id>
```

UGUI folds view state. A registered profile preference owner persists accepted pin/hotkey changes and returns a
receipt. Applet runtime effects remain separately admitted.

## 4 · Deterministic mnemonic allocation

### 4.1 Scope

A mnemonic is allocated in the `executive-tabs` scope. The host keybind registry maps that scope to a chord or
leader behavior. UGUI allocates symbols; Costas must not hardcode global OS key combinations.

Tab labels may display the mnemonic inline:

```text
MA[R]KETPLACE
C[A]LCULATOR
S[N]AKE
```

For non-Latin labels or labels where inline marking is inappropriate, the painter may render a separate key badge
from the same assigned mnemonic.

### 4.2 Inputs

```text
reserved shell mnemonics
existing sticky assignments
profile overrides
pinned instances in stable pin order
applet preferred mnemonic candidates
localized display name
stable applet/instance ID
```

### 4.3 Allocation order

For a newly pinned instance:

1. Accept a valid profile override if unclaimed and not reserved.
2. Accept the applet's preferred mnemonic candidates in authored order.
3. Scan ASCII letters in the display name from left to right.
4. Scan ASCII letters in the stable applet ID from left to right.
5. Scan remaining `A..Z`.
6. Scan `0..9`.
7. If no symbol remains, retain the pin without a direct mnemonic and emit `hotkey-unassigned`.

Case folds to uppercase. Existing assignments are sticky.

### 4.4 Stability rules

- Pinning a new applet never silently remaps existing tabs.
- Unpinning releases its symbol but does not compact/remap survivors.
- Renaming/localization does not change an existing assignment.
- Reordering tabs does not change assignments.
- A requested override that collides fails closed and offers an explicit swap.
- A swap lists both displaced assignments and requires confirmation.
- Marketplace always retains a recovery route even if its visual tab is temporarily hidden by form factor.

### 4.5 Example

Existing BRIANHU seed claims:

```text
H D L Q C M O T S
```

Pin MARKETPLACE with preferred `R`:

```text
MA[R]KETPLACE
```

Pin Calculator with preferred `C`:

```text
C is occupied by SCORES
A is first free name letter
→ C[A]LCULATOR
```

Pin Snake with preferred `S`:

```text
S is occupied by SETTINGS
N is next free name letter
→ S[N]AKE
```

### 4.6 Assignment receipt

Every allocation/reallocation returns a content-addressed receipt:

```text
schema
profile_scope_hash
workspace_revision_before/after
catalog_source_sha256
reserved_set_hash
pinned_order_hash
assignments[]
conflicts[]
displacements[]
losses[]
receipt_sha256
```

The receipt contains no private profile payload beyond bounded opaque/hash identity.

## 5 · Trust and capability posture

Marketplace surfaces catalog evidence; it does not certify applets independently.

```text
catalog presence       ≠ qualification
qualification          ≠ capability grant
pin                     ≠ install authority
pin                     ≠ runtime execution
open                    ≠ domain authority
identity                ≠ capability
```

Before pin/open, show:

- source and catalog digest;
- qualification status/receipt;
- surface-specific losses;
- emitted capabilities;
- native catalogs;
- interaction kinds;
- sandbox/resource limits;
- capability availability and reason.

Runtime capability requests cross the existing admission boundary and may be refused. The tab remains visible with a
bounded refusal state.

## 6 · Dynamic Scene batch contract

Migration keeps `ae-executive-scene-batch/1` compatible:

```text
legacy mode
  exact current nine in canonical order

generalized mode
  1..36 safe unique tab IDs
  marketplace present
  every Scene contains exact same ordered shell.tab.* set
  every tab has one unique mnemonic
  mapping is byte-stable across Scenes
```

Future wire versions should add explicit workspace metadata rather than infer it:

```json
{
  "schema": "ugui-workspace-scene-batch/1",
  "authority": "none",
  "workspace": {
    "revision": 42,
    "preset": "witness-brianhu",
    "catalog_source_sha256": "...",
    "tabs": [],
    "hotkey_receipt_sha256": "..."
  },
  "scenes": []
}
```

Costas checkpoint `4b8b4b9df` already accepts legacy mode and generalized Marketplace mode, validates the exact shared
action list, validates unique mnemonic markers, and routes dynamic `shell.tab.<id>` actions without a code change.

## 7 · Form factors

The pinned workspace is semantic state; each surface may realize it differently:

```text
desktop  full tab/action row, overflow through Marketplace
terminal bounded tab row + Marketplace command/palette
mobile   active applet + compact switcher
wear     active applet + Marketplace recovery gesture
voice    spoken applet switch intent resolved against pinned IDs/names
```

Named losses record hidden labels, omitted direct mnemonics, compacted tabs, or unavailable native catalogs.

## 8 · Implementation sequence

### M0 — landed in Costas consumer

- dynamic safe tab IDs;
- profile-specific Marketplace workspace acceptance;
- exact shared action parity;
- 36-tab bound;
- unique mnemonic validation;
- dynamic `/ae/<id>` routing.

### M1 — UGUI shell owner

- workspace state and revision;
- deterministic mnemonic allocator + receipt;
- Marketplace system applet card;
- pin/unpin/reorder reducers;
- generated workspace action row.

### M2 — runtime and persistence

- profile preference persistence intent/receipt;
- catalog search/filter/paging;
- qualified applet selection and open;
- applet runtime mounting;
- capability refusal/receipt projection.

### M3 — fidelity and scale

- Desktop asset catalog;
- lazy per-applet Scene loading;
- form-factor switchers;
- Marketplace evidence inspector;
- sharing/import under content-addressed catalog authority.

## 9 · Exit predicates

```text
generalized UGUI workspace
= current nine are a preset, not universal constants
∧ Marketplace is the discovery/recovery anchor
∧ applets come from the qualified catalog
∧ pinning is profile-scoped presentation preference
∧ dynamic tab actions are generated by UGUI
∧ mnemonic allocation is deterministic, sticky, collision-free, and receipted
∧ Costas consumes but never allocates
∧ pin/open grant no capability
∧ every surface records named realization losses
∧ calculator, snake, and future applets require no Costas route code
```

# SH[E]LL — an honest developer projection laboratory

> **Kind:** architecture + first read-only vertical slice
> **Date:** 2026-07-26
> **Status:** structural viewport implemented; native/physical attestation not claimed
> **Mnemonic:** `SH[E]LL` (`E` is reserved; Marketplace retains `R`)

## 0 · Thesis

`SH[E]LL` is not a device emulator and not a responsive-design iframe. It is a developer projection laboratory that
keeps four axes independent:

```text
host shell          Android / macOS / Windows / Linux / Apple device shell owners
surface profile     desktop / handset / wearable / spatial geometry and chrome facts
semantic experience one invariant UGUI Scene identity/action set
style model         independent UGUI skin projection
```

It combines those axes with explicit source, build, package, physical, capability, authority, and effect evidence. The
result may visualize structure, but it must never imply a physical run merely because a rectangle resembles a device.

## 1 · Canonical evidence owners

### Shell and target matrix

```text
AgentExperiments/run/SHELL-BUILDS.json
AgentExperiments/run/SHELLS.json
AgentExperiments/run/BUNDLE.json
AgentExperiments/<shell>/BUILD.json
```

`SHELL-BUILDS.json` owns matrix membership. A shell `BUILD.json` owns fixed commands, not target membership. Build
qualification has four independent rungs:

```text
source → artifact → package-install → physical-runtime
```

A compile cannot establish install or physical execution. A simulator cell cannot establish device execution. Two thin
binaries cannot establish a universal binary.

### Capability matrix

```text
AgentExperiments/envelope/capabilities/generated/SHELL-CAPABILITY-PARITY.json
```

Availability is exactly:

```text
available | degraded | unavailable | unknown
```

`UNKNOWN` is visible evidence, not a hidden failure. Legacy `worked`/`native`, source presence, API names, and oracle
recipes do not establish availability. `AVAILABLE` requires implementation, provisioning, consent, and current artifact
plus physical evidence.

### Surface geometry

```text
AgentExperiments/ugui/json/surface-profiles.json
AgentExperiments/ugui/json/surface-profiles.schema.json
AgentExperiments/ugui/src/surface_profiles.rs
```

UGUI explicitly defines the surface-geometry axis as orthogonal to:

```text
host-platform
interaction-shell
seastar-content-role-overlay
ugui-style-model
```

A Pixel viewport does not prove Android capability. A Windows skin does not prove Windows runtime. A macOS shell does
not grant a fixed display geometry when the profile says display-derived.

## 2 · Lessons from seastar-shell

`seastar-shell` already demonstrates useful projection mechanics:

- desktop, landscape, portrait, and lockscreen view states;
- bounded width, height, preset, and UI-scale controls;
- one semantic card system projected across form factors;
- data-driven skins above surfaces;
- closed LUCID view control;
- browser evidence that asserts form-factor and semantic outcomes.

It also exposes the confounds this tab must avoid:

- host-window breakpoints can override emulated dimensions;
- toolbar portrait and LUCID portrait may choose different IA state;
- a browser rectangle remains browser evidence;
- copied shell chrome would create a second renderer;
- a demo surface cannot promote capability or physical evidence.

Therefore SHELL consumes canonical AE matrices and surface profiles; it does not copy Seastar's React shell or OS chrome.

## 3 · First implemented slice

### Launcher

The Desktop launcher now contains:

```text
SH[E]LL
route: /ae/shell
mnemonic: E
```

The launcher has eleven anchors. The existing RUN executive batch remains ten Scenes; SHELL is a separate host-derived
read-only Scene. This prevents the dynamic developer surface from changing every canonical RUN Scene's handler set.

### Staged sources

The Desktop package stages exact AE artifacts under `Resources/ae/shell-viewport/`:

```text
shell-builds.json
shell-capability-parity.json
surface-profiles.json
```

Electron reads only those staged bytes, applies byte bounds, validates schemas, hashes the normalized content, and
returns a closed `ae-shell-viewport-scene/1` response. The renderer never reads the AE worktree.

### Initial model

```text
ae-shell-viewport-model/1
```

contains:

- authority `none`;
- hashes for all three staged sources;
- selected shell owner/platform/manifest;
- selected surface profile, form factor, production hosts, geometry, safe area, radii, chrome, window policy, and sources;
- selected target architecture/SDK/ABI/package/artifact kind/disposition/owner/reason;
- exact source/artifact/package-install/physical-runtime rung states;
- complete capability status counts for the target platform;
- a bounded non-unknown capability sample;
- compatible shell/surface/target selector sets;
- posture `structural-projection`;
- warning `STRUCTURAL PROJECTION — NOT A PHYSICAL RUN`.

### Default projection

```text
shell:   android-shell
surface: google-pixel-9
build:   android-arm64-v8a
```

Current capability evidence from the generated matrix:

```text
available     0
degraded      2
unavailable   0
unknown     151
```

Current build rungs:

```text
source             declared
artifact           missing
package-install    missing
physical-runtime   missing
```

These values are projected as text, not inferred colors.

## 4 · Structural viewport, not native realization

The registered host catalog is named:

```text
shell-structural-viewport
```

It draws a bounded geometry glass from an admitted surface profile and places the same fixed semantic demo inside it.
The frame always displays:

```text
STRUCTURE ONLY · AUTHORITY NONE · NOT RUN
```

and repeats the full structural-projection warning.

It does not:

- boot or emulate an OS;
- use iframe or webview;
- load remote pages or screenshots;
- spawn a process;
- run a build or package;
- install an application;
- claim native materials or accessibility;
- establish performance, GPU, network, permission, or physical evidence.

Unsupported shell/surface combinations refuse. Windows and Linux remain visible matrix owners, but no macOS geometry is
borrowed to draw them.

## 5 · Semantic invariance proof

Android handset and macOS desktop structural projections retain exactly the same semantic demo nodes:

```text
viewport-demo-title
viewport-demo-body
viewport-demo-action → shell.inspect
```

Text, label, and action are invariant. The structural model, geometry, chrome, capability posture, and evidence rungs
differ. This is the falsifier:

```text
same semantic Scene + different admitted shell constraints
```

A projection that changes meaning or authority fails this contract.

## 6 · Closed action family

V1 admits selection only:

```text
shell.target.<safe-shell-id>
shell.surface.<safe-surface-profile-id>
shell.build.<safe-target-id>
shell.inspect
```

No build, launch, install, exec, dispatch, download, confirmation, package mutation, or domain-effect action exists.
Selections are ephemeral in v1. Each selection requests a fresh source-bound Scene; stale async responses are rejected by
a generation counter.

## 7 · Ownership

```text
AE matrices/catalogs     target, capability, and geometry facts
Costas Electron          staged-file admission, hashing, pure composition IPC
UGUI Scene grammar       normalized semantic evidence/control tree
Costas renderer          Scene validation, typed events, structural paint
pane/route system        placement, sizing, focus, persistence
Butler/native owners     all future real effects
```

The first slice still contains a transitional pure model/composer in Electron. The canonical destination is an AE
`ae-shell-scene` adapter over UGUI-owned workspace/reducer contracts, generated Scene/event bindings, and revision-bound
reductions. The renderer must not become a second long-term shell reducer.

## 8 · Red lines

- No fake device bezel or copied OS desktop.
- No iframe, webview, nested browser, screenshot, or remote page.
- No shell-specific pane tree.
- No arbitrary Scene action execution.
- No source path, argv, environment, credential, or generic IPC exposed to renderer.
- No inference of AVAILABLE, installed, authorized, executed, or settled from lower evidence.
- No omission of UNKNOWN cells or missing physical receipts.
- No compile receipt promoted to package-install or physical-runtime.
- No simulator promoted to device.
- No host window dimensions substituted for pane-local or profile geometry.
- No unsupported shell borrowing another platform's surface profile.
- No visual or physical attestation from unit/browser tests.

## 9 · Next phases

1. Move the model/composer into a UGUI-owned `ae-shell-scene` snapshot/reduce adapter.
2. Add canonical schemas for shell workspace, snapshot, event, reduction, evidence claim, and receipts.
3. Reuse a generic revisioned `UguiSceneSurface` with pane-local ResizeObserver measurements.
4. Add the existing Projects UGUI applet as a second instance through the same lifecycle.
5. Project a bounded exact capability slice with complete cell provenance rather than counts/sample only.
6. Add target-bound freshness, process/package/profile episodes, and stale/refused states.
7. Add actual simulator/package/physical receipts only when independently generated and bound.
8. Keep literal evidence labels in UI and release notes by tier.

## 10 · Current evidence

```text
Electron source-bound shell model: 5 tests
Desktop SHELL route/native structural frame: 1 test
Existing executive consumer: 20 tests
Typed Scene painter: 2 tests
TypeScript / ESLint / diff: green
```

Skin morph package boundary already running concurrently:

```text
signed Catalyst package: valid
Costas stamp: 7e9d41131b8021b6a7241bb4528b266285e32ae1
live Catalyst PID after restart: 96248
post-restart fatal boot failures: 0
```

This does not yet attest SHELL packaging; the SHELL source checkpoint and package verification follow this document.

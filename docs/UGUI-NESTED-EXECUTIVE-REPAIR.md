# Nested UGUI executive compatibility repair

> **Date:** 2026-07-26
> **Incident:** Desktop displayed `ae-executive-projector-invalid`
> **Root cause:** Costas required every `run-*` Scene to contain at least one `layout.height == "*"` node
> **Disposition:** stale host inference removed; closed graph/layout validation strengthened

## What changed in AE

AE's nested-card refactor resolves by-reference and inline `nested` card content before structural projection:

```text
card + cards registry
→ ugui::nested::resolve_card
→ normalized nested sections
→ flat Scene 1.0.0 adjacency list
```

The producer still emits the same render seam:

```json
{
  "sceneVersion": "1.0.0",
  "root": "card",
  "nodes": []
}
```

No unresolved `nested` primitive crosses into Desktop. The changed Dashboard Scene is a legitimate content-sized tree of
intrinsic and fixed blocks. It no longer needs a remaining-height block.

Canonical UGUI block extents are:

```text
Intrinsic
Fixed(n)
Remaining        represented by layout.height == "*"
```

All three are valid. `Remaining` is a layout choice, not a Scene-validity requirement.

## Why Costas failed

Costas Electron admission contained this stale rule:

```text
if scene.id starts with run-
  require some node with layout.height == "*"
```

The current Dashboard had thirteen fixed layout nodes and no remaining-height node, so otherwise-valid producer output
failed as:

```text
ae-executive-elastic-layout:dashboard
```

`runAeExecutiveProjector()` intentionally projects internal admission errors to the closed public code:

```text
ae-executive-projector-invalid
```

This made the surface symptom look like a schema/version failure even though Scene 1.0.0 and nested resolution were valid.

## Repair

The stale universal remaining-height requirement was removed from both Electron semantics and renderer tests.

It was replaced with closed structural validation:

- Scene 1.0.0;
- 1..4096 nodes;
- safe unique node IDs;
- closed primitive vocabulary;
- root exists;
- children are strings and exist;
- only row/column/stack may have non-empty children;
- layout contains only `height`;
- height is integer 1..4096 or `"*"`;
- graph is acyclic;
- maximum depth 64;
- every node is reachable from root;
- executive tab action/hotkey/card-identity invariants remain independently enforced.

Electron and renderer validate independently.

## Evidence

Direct admission of the exact current and packaged producer bytes:

```text
/tmp/current-ae-executive.json  OK 10 Scenes
/tmp/packaged-ae-executive.json OK 10 Scenes
```

The full asynchronous boundary now succeeds:

```text
runAeExecutiveProjector(build/ae/ae-executive-scene)                         OK 10
runAeExecutiveProjector(Catalyst.app/.../ae/ae-executive-scene)              OK 10
```

Focused gates:

```text
Electron executive tests:          8 passed
Renderer executive/painter/SHELL: 24 passed after nested regression addition
TypeScript / ESLint / diff:        green
```

Regression coverage includes:

- nested content-sized Dashboard with no `height:"*"`;
- intrinsic nested Dashboard paints in the generic Scene painter;
- elastic and fixed layout still paint correctly when authored;
- malformed primitives, dangling children, leaf children, invalid heights, cycles, depth, and unreachable nodes fail
  closed.

## Invariant

```text
Host validates the canonical render seam.
Host does not infer semantic validity from one historical realization of layout.
```

Nested cards remain UGUI composition semantics. Desktop consumes their flattened Scene result generically and does not
reimplement nested resolution in React.

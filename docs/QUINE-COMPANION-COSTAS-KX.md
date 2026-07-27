# CostasCode as QUINE's first companion repository

> **Date:** 2026-07-26
> **Relationship:** independent sibling companion, not submodule or AE area
> **AE registry:** `AgentExperiments/quine/companions.json`
> **Costas manifest:** `costas-code/QUINE-COMPANION.json`
> **Artifact exchange:** immutable `build/ae/generations/<digest>` selected by `CURRENT.json`

## 0 · Decision

Costas remains an independent Git repository. It is enrolled into QUINE automation through a separate companion lane,
not through:

- `.gitmodules`;
- `quine/areas.json`;
- `quine/canon/repo_map.json`;
- `run/BUNDLE.json`;
- `Graph.extra_roots`;
- a cross-root Graph or shared heartbeat/state directory.

This preserves two independent authorities:

```text
AgentExperiments / QUINE   semantic acceptance, UGUI/RUN producer truth, leases, settlement
CostasCode                 Desktop consumer, Electron effects, package and release lifecycle
```

A companion relationship grants observation and declared gate execution. It grants no mutation, acceptance,
capability, settlement, commit, push, or release authority.

## 1 · Exact companion admission

AE owns one closed registry row:

```json
{
  "$schema": "quine-companions/v1",
  "companions": [
    {
      "name": "costas-code",
      "path": "../costas-code",
      "remote": "https://github.com/SlowGreek/costas-code.git",
      "manifest": "QUINE-COMPANION.json"
    }
  ]
}
```

Admission requires:

- canonical AE root;
- exact parent sibling `../costas-code`;
- direct directory, never symlink;
- direct `.git` directory with object/ref identity;
- exact normalized credential-free origin remote;
- bounded direct UTF-8 manifest;
- safe descendant watched roots/workdirs;
- no symlink in admitted descendants;
- closed program and argv allowlist;
- bounded timeout/output.

The canonical AE Graph remains repository-confined. Companion snapshotting is a separate implementation in
`quine/src/companion.rs`.

## 2 · Costas-owned manifest

Costas owns the watched roots and gates:

```text
apps/desktop/src
apps/desktop/electron
apps/desktop/scripts
apps/desktop/package.json
apps/desktop/tsconfig*.json
apps/desktop/vite.config.ts
```

The only executable family is:

```text
npm run <closed-approved-script>
```

Approved scripts:

```text
check:ae-generation
check:test:desktop:platforms
check:test:ui
check:test:desktop:all
check:lint
```

No command string or shell is accepted. Gate execution uses:

- canonical npm resolution under approved Node/npm installation roots;
- no inherited arbitrary environment;
- sanitized PATH;
- HOME and npm cache under `/tmp`;
- `CI=1`, `NO_COLOR=1`, `GIT_TERMINAL_PROMPT=0`;
- null stdin;
- bounded stdout+stderr drains;
- timeout and process-group termination.

## 3 · QUINE daemon integration

`shipping::run` starts the companion service beside the canonical watcher service. The companion has its own:

- admitted root;
- snapshot;
- generation counter;
- polling loop;
- gate executions;
- stop flag and exact join lifecycle;
- content-free atomic receipt.

Receipt path:

```text
AgentExperiments/quine/state/companions/costas-code.json
```

The receipt reports only:

- schema and companion identity;
- phase/generation/observation epoch;
- source snapshot hash;
- freshness and verdict;
- gate IDs, status, code, duration and byte count.

It does not retain source text, stdout, stderr, credentials, paths outside the stable companion ID, or capabilities.

The first live service run exposed and then fixed a real integration bug: Homebrew's `npm` entry is a symlink. The
resolver now canonicalizes it and requires the final executable to remain under an approved Node/npm prefix, be a direct
regular executable, and carry execute mode.

## 4 · Transactional AE→Costas generation

The old staging script copied each binary independently into mutable `build/ae`. A partial AE source edit or later build
failure could therefore leave mixed generations.

The new transaction is:

```text
capture exact AE commit + dirty status hash
→ isolated Cargo target directories
→ cargo build --locked --offline for all producers
→ copy exact just-built binaries into candidate
→ copy generated skins and SHELL source contracts into candidate
→ run real producer→Costas admission smoke
→ recapture AE commit/status; refuse if changed
→ hash artifacts and complete resource directories
→ write content-derived generation manifest
→ independently revalidate candidate + rerun smoke
→ rename candidate to immutable generations/<digest>
→ atomically replace CURRENT.json
→ read back CURRENT
```

Failure before pointer replacement preserves the previous selected generation. A source change during build returns:

```text
AgentExperiments changed during candidate build
```

The first real failure-injection run observed exactly that refusal and left:

```text
CURRENT unchanged
0 candidate directories
0 candidate Cargo roots
last-good artifacts intact
```

## 5 · Generation contract

```text
costas-ae-generation/1
```

binds:

- content-derived generation ID;
- AE canonical root, commit, dirty state and status hash;
- exact SHA-256 and size for all three binaries;
- aggregate deterministic path+byte hashes for skins and SHELL resources;
- executive Scene count and exact output hash;
- skin settings node count.

Artifacts:

```text
ae-executive-scene
ae-skin-settings-scene
butler
skins/**
shell-viewport/**
```

`CURRENT.json` is:

```text
costas-ae-current/1
{ generation_id, manifest_sha256 }
```

Electron resolves it once at process startup and independently validates:

- pointer schema and hash formats;
- selected generation confinement;
- manifest hash and generation identity;
- every binary hash/size/type;
- resource file counts, bytes and aggregate hash;
- no unexpected top-level file.

No runtime fallback to sibling `target/debug`, flat `build/ae`, or an environment-selected producer remains.

## 6 · Packaging

`prepare-ae-package.mjs` creates a package-only projection containing exactly:

```text
ae/CURRENT.json
ae/generations/<selected-generation>/**
```

Candidates, temporary pointers, other generations, rollback state, mutable target directories and local diagnostics are
excluded.

`test-desktop.mjs` requires the packaged pointer, manifest hash, exactly one generation, exact root inventory, and a
successful packaged executive producer smoke.

## 7 · TDD and fault evidence

Costas focused tests cover:

- validation failure preserves last-good;
- complete candidate publication;
- rename rollback;
- atomic CURRENT publication;
- pointer failure preserves prior CURRENT;
- manifest exact fields/artifact/resource completeness;
- content-derived generation identity;
- runtime pointer/manifest/artifact/resource validation;
- artifact tamper, pointer tamper, extra file and symlink refusal;
- real executive producer through the exact Electron admission;
- real skin settings producer;
- bounded Butler liveness.

AE focused tests cover:

- registry path escape and unknown fields;
- malformed companion manifest;
- unsafe program, argv and workdir;
- symlinked sibling;
- wrong remote;
- timeout;
- stale snapshot;
- bounded content-free atomic receipt;
- exact stop/join;
- installed npm canonical confinement.

## 8 · Current authority posture

Dirty development generations are allowed only as local authority-none evidence. They are not release or settlement
proof. The portable release design still requires a clean reviewed AE producer receipt and Costas lock tuple.

A GREEN companion gate means the named Costas command exited successfully against one exact companion snapshot. It does
not mean:

- QUINE accepted the repository;
- a package was released;
- a capability was granted;
- a mutation occurred;
- a lease settled;
- commits are atomically synchronized across repositories.

## 9 · Exit predicate

```text
Costas is a QUINE companion
= exact independent repository identity admitted
∧ companion changes independently observed
∧ only closed argv gates may execute
∧ receipts are bounded and content-free
∧ AE Graph confinement remains unchanged
∧ AE artifacts publish as one immutable validated generation
∧ all runtime consumers resolve one CURRENT generation
∧ packaged Desktop contains only that selected generation
∧ no submodule or shared Git authority exists
```

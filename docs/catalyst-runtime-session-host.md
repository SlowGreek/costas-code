# Catalyst runtime-session host — CostasCode ideation contract

> **Branch:** `users/brianhu/ideation`  
> **State:** decision evidence only; no production routing change  
> **Owner:** CostasCode runtime/session boundary  
> **External consumer:** AgentExperiments may consume only a later enrolled typed host protocol. It does not own this implementation.

## Decision

CostasCode already owns the strongest candidate runtime for visible AgentExperiments EM and engineer sessions: one `CodexAppServerSession` per `AIAgent`, native thread/turn identity, steering, interruption, approvals, compaction, usage, and event projection (`agent/transports/codex_app_server_session.py:265-427,470-789,983-1224`; `agent/codex_runtime.py:273-612,615-872`).

Do not add a Copilot SDK dependency merely to mirror Butler. Do not add an unconsumed universal manager. The first implementation must have one concrete consumer and preserve current Codex behavior exactly.

The desired narrow waist is a capability-advertised runtime-session contract:

```text
create | send | steer | interrupt | compact | close
```

The following remain explicitly unavailable until separately proven:

```text
resume-after-backend-restart | durable event replay | external authenticated control
shared-process independent sessions | lease-safe mutation Fleet mode
```

## Current capability census

| Capability | State | Evidence |
|---|---|---|
| create thread | **WIRED** | `ensure_started()` initializes and calls `thread/start` (`agent/transports/codex_app_server_session.py:315-373`). |
| send turn | **WIRED** | `run_turn()` calls `turn/start` with the exact thread (`agent/transports/codex_app_server_session.py:470-562`). |
| steer active turn | **WIRED** | `turn/steer` binds `threadId` and `expectedTurnId` (`agent/transports/codex_app_server_session.py:397-427`). |
| interrupt active turn | **WIRED** | `turn/interrupt` binds thread and turn (`agent/transports/codex_app_server_session.py:983-997`). |
| foreign-event rejection | **WIRED** | notifications with foreign thread/turn identity are rejected (`agent/transports/codex_app_server_session.py:95-165,611-735`). |
| interactive approvals | **WIRED** | command and patch requests use Hermes approval; permission escalation declines (`agent/transports/codex_app_server_session.py:998-1118`). |
| compaction | **WIRED** | host triggers `thread/compact/start` and observes completion (`agent/transports/codex_app_server_session.py:791-979,1194-1224`). |
| usage and UI events | **WIRED** | Codex events project into Hermes accounting, messages, and stable tool cards (`agent/codex_runtime.py:46-270,273-612`). |
| process close | **WIRED in process** | client terminates, waits, then kills; session clears active IDs (`agent/transports/codex_app_server.py:185-209`; `agent/transports/codex_app_server_session.py:375-393`). |
| resume exact thread after backend restart | **UNAVAILABLE** | production path always starts a thread and clears its ID on close. |
| durable event cursor/replay | **UNAVAILABLE** | notifications are process-local queues (`agent/transports/codex_app_server.py:143-156,260-279`). |
| external exact session control | **UNAVAILABLE** | redirect/interrupt reach the in-memory `_codex_session` object (`run_agent.py:2876-2888,3031-3066`). |
| exact QUINE lease mediation | **UNAVAILABLE** | current sandbox/approval policy is interactive/workspace-oriented, not dispatch-generation authority. |

## Identity rule

Never collapse:

```text
Hermes durable session
Hermes live/UI session
Hermes lineage root
provider thread
provider active turn
runtime process episode
AgentExperiments role session
AgentExperiments dispatch identity
AgentExperiments lease generation
```

Desktop guidance already requires explicit durable/runtime/lineage translation (`apps/desktop/AGENTS.md:48-56`). The renderer may join a row but cannot own or infer authority.

## Fleet boundary

Current Codex integration has useful primitives:

- caller-supplied `CODEX_HOME`;
- centrally filtered subprocess environment;
- app-server extra arguments;
- network-off and extra writable roots for the Kanban worker case;
- deterministic decline when no approval callback exists
  (`agent/transports/codex_app_server.py:71-124`; `agent/transports/codex_app_server_session.py:254-263,998-1118`).

That does not yet prove an AgentExperiments mutation worker. A Fleet profile requires:

- private generated `CODEX_HOME` and config;
- exact supported runtime/model;
- no ambient user plugins or MCP servers;
- minimal provider credential only;
- network off by default;
- deterministic non-interactive policy;
- content-free control journal;
- exact write mediation below shell syntax;
- verified process/session teardown.

Until exact write mediation exists, the only admissible tandem canary is read-only/research.

## Enrolled-host boundary

A future Butler caller must not gain authority from localhost, stdio parentage, or a claimed session ID. The Costas-owned endpoint must require an enrolled host proof bound to:

```text
host instance
measured executable or signed bundle
PID + process-start episode
opaque Costas project/profile handles
Butler challenge + single-use nonce
expiry + revocation generation
requested operation capability
```

Parsing these claims is not authorization. No endpoint or runtime wiring should land until the shared schema has an exact consumer and threat-model tests.

## First consumer-backed implementation

The first code increment should occur only when the Desktop or enrolled Butler adapter is ready to consume it.

### Scope

Wrap existing Codex behavior behind provider-neutral value types without changing production routing:

```text
RuntimeSessionCapabilities
RuntimeSessionBinding
ActiveTurnTarget
RuntimeControlReceipt
RuntimeSessionHost
```

### Required behavior

- `create`, `send`, `steer`, `interrupt`, `compact`, and `close` map to existing methods.
- `resume` and `replay` return typed unavailable results.
- calls before create, after close, or against a stale turn return deterministic state errors.
- existing event projection, approvals, transcript persistence, and cleanup remain unchanged.
- provider RPC names and raw thread IDs remain adapter-private.

### Exact first paths

```text
agent/transports/codex_app_server_session.py
agent/runtime_sessions/               [proposed only when consumed]
tests/agent/transports/test_codex_app_server_session.py
```

### Falsifiers

- public contract contains `thread/start`, `turn/steer`, or another Codex RPC name;
- resume/replay is emulated or implied;
- approval, event order, transcript, or interrupt behavior changes;
- raw provider identity reaches renderer state;
- a new module lands without a production/test consumer;
- a Fleet write is admitted through command-string inspection.

## First canary order

1. Deterministic capability census against fake Codex wire.
2. Provider-neutral adapter parity with no routing change.
3. Read-only visible child-session projection.
4. Process-bound host enrollment with no runtime operation.
5. One read-only/research engineer with content-free events.
6. Exact STEER/interrupt and crash/restart matrix.
7. Mutation only after exact path mediation and independent acceptance.

## Relationship to AgentExperiments

AgentExperiments remains authoritative for role, plan, dispatch identity, leases, correction, acceptance, settlement, and release. CostasCode owns runtime sessions, private provider identity, transcript/history, live UI, and runtime process lifecycle.

The sibling rationale is evidence, not an edit surface:

- `../AgentExperiments/docs/CATALYST-KX.md`
- `../AgentExperiments/docs/CATALYST-SDK-KX.md`
- `../AgentExperiments/docs/CATALYST-COUNTER-STEER-KX.md`

No AgentExperiments process may receive an `AIAgent` object or raw provider thread ID. No CostasCode runtime result may settle or release AgentExperiments work.

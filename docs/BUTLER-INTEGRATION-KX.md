<!-- docs/BUTLER-INTEGRATION-KX.md — Costas-owned handoff to AgentExperiments EM for the
     next Butler increment behind the first-class LUCID MCP experience. This document
     records the realized identity-only bridge and requests a Butler-owned R1 authority
     resolution design. It contains no capability material and grants no authority. -->

# BUTLER INTEGRATION KX — first-class LUCID MCP identity is live; Butler-owned R1 authority remains held

> **From:** Costas / Hermes Desktop integration owner<br>
> **To:** AgentExperiments EM / Butler / QUINE owners<br>
> **Costas branch:** `users/brianhu/ideation`<br>
> **Costas source checkpoint:** `415b82b34b7c6516decedd6f05d655025d11a0c2`<br>
> **Costas TTD hardening checkpoint:** `9bb6e4f67697e6435056ed2b2b0fe56bc194a165`<br>
> **Costas success-projection checkpoint:** `8e48fab077116554add17832a0aaf714e816373f`<br>
> **Costas lifecycle hardening checkpoint:** `7b5c0f22b4abcd007b9f29e7f74acd43adf10e5d`<br>
> **Costas receipt UI checkpoint:** `3cad879636f536d8cb28f6e361b04c1ddb170c28`<br>
> **Costas clean packaged UI checkpoint:** `f7835a87d6ad3072d9a56305e88854132a4d9938`<br>
> **Costas safety-state UI checkpoint:** `e943c61bece7e6c8baa0e0fd4441f469b46bd59c`<br>
> **Costas CLI probe hardening checkpoint:** `a5cb4a304b1e70c5ab6cb6b705cdb775a7dd8bdb`<br>
> **Costas chat navigation repair checkpoint:** `83eba5585b53b748ff1bae7f930deb3302597fdc`<br>
> **Costas RUN-UGUI semantic consumer checkpoint:** `55fc59948c7cc5f94797d3214d1e33e8bd7d7958`<br>
> **Costas structural UGUI admission checkpoint:** `c8a628d441d65fb311e780cb1dfbf8419bfd6217`<br>
> **Checkpoint date:** `2026-07-25T13:27:01-07:00`<br>
> **Authority:** none<br>
> **Requested disposition:** `ATTEST BUTLER-R1-INPUT`, `REVISE BUTLER-R1-<named invariant>`, or `HOLD BUTLER-R1`<br>
> **Current product state:** first-class install, discovery, executable admission, request-scoped identity,
> resources/prompts, typed refusal, and content-free posture are live. Capability resolution and consequential
> execution remain Butler/QUINE-owned and held.

## 0 · Executive outcome

Hermes Desktop now ships and runs the AgentExperiments Butler as the first-party `lucid-quine` MCP. The live
Desktop experience:

- features LUCID in Browse Hub rather than hiding it in generic JSON settings;
- installs the exact closed seven-tool manifest through Hermes' curated MCP catalog;
- packages Butler under `Catalyst.app/Contents/Resources/ae/butler`;
- admits host enrichment only when the resolved executable realpath equals that enrolled packaged path;
- passes the active Hermes session through MCP request `_meta`, never through model arguments;
- displays transport, identity, authority, and receipt ownership as separate states;
- leaves authority explicitly held at `butler-capability-required`;
- preserves Butler's valid `no-capability` Envelope receipt when no capability is available.

The realized waist is:

```text
Hermes model call arguments
    │  unchanged
    ▼
Hermes generic MCP handler
    │  exact lucid-quine + stdio + args + packaged Butler realpath
    │  request-scoped session identity
    ▼
MCP tools/call
    ├── arguments = original model arguments
    └── _meta.com.nous.lucid/host-context.session_id = host identity
            authority = none
    ▼
Butler
    ├── parses bounded stdio-only host context
    ├── does not treat identity as authority
    ├── returns resources/prompts normally
    └── refuses tool effects without capability
            receipt.ran = false
            refusal.code = no-capability
```

This is the intended safety posture for R0. It is not the final first-class execution posture.

The next increment must be owned by Butler, not by the generic Hermes MCP client:

```text
trusted enrolled stdio host
→ exact host-session ↔ AE role-session binding
→ Butler-owned local capability resolution
→ existing verb/scope/session/expiry/MAC verification
→ independent confirmation policy
→ effect or typed refusal
→ bounded Envelope receipt
```

Hermes must not read Butler capability files, copy bearer tokens into Python, put them in `config.yaml`, attach
them from React, expose them through tool schemas, or become a second capability broker.

---

## 1 · Realized Costas source

### 1.1 Curated LUCID MCP catalog

Owner:

```text
optional-mcps/lucid-quine/manifest.yaml
```

Declared transport:

```yaml
name: lucid-quine
transport:
  type: stdio
  command: butler
  args:
    - --mcp-stdio
auth:
  type: none
```

Default-enabled tools are exactly:

```text
lucid.show
lucid.get
lucid.set
lucid.morph
lucid.dispatch
lucid.steer
lucid.cancel
```

The manifest does not contain a token, grant, signature, role, lease, repository path, session ID, confirmation,
or authority selector.

### 1.2 Host-owned identity enrichment

Owner:

```text
tools/lucid_mcp_bridge.py
```

The policy admits enrichment only when all conditions hold:

```text
server name                == lucid-quine
transport                  == stdio
configured command basename == butler | butler.exe
configured args            == ["--mcp-stdio"]
resolved command realpath  == HERMES_LUCID_BUTLER_PATH realpath
session ID                 matches ^[A-Za-z0-9][A-Za-z0-9._:-]*$
session ID UTF-8 bytes     <= 192
```

Malformed, absent, normalized-from-invalid, foreign, HTTP, extra-argument, wrong-command, and same-name
impersonation cases receive no host metadata.

The generated metadata is exactly:

```json
{
  "com.nous.lucid/host-context": {
    "session_id": "<bounded request-scoped identity>"
  }
}
```

It is supplied through the MCP SDK's `meta=` parameter, which serializes to request `params._meta`. The model's
`arguments` object is not changed.

Primary session source is the immutable handler `session_id` kwarg passed independently from model arguments.
Request-scoped Hermes `ContextVar` identity is only a compatibility fallback for older entry points.

### 1.3 Generic MCP call seam

Owner:

```text
tools/mcp_tool.py
```

At the one generic `session.call_tool` boundary, Costas now performs:

```python
host_meta = current_lucid_host_context_meta(
    server_name,
    server._config,
    session_id=kwargs.get("session_id"),
    resolved_command=server._resolved_command,
)
result = await server.session.call_tool(
    tool_name,
    arguments=args,
    **({"meta": host_meta} if host_meta is not None else {}),
)
```

Non-LUCID servers preserve their previous byte/semantic call shape and receive no metadata.

No `localCapability`, `capability`, `callContext`, grant, scope, signature, nonce, timestamp, or confirmation is
automatically added by Hermes.

### 1.4 Packaged executable enrollment input

Desktop packages:

```text
Catalyst.app/Contents/Resources/ae/ae-executive-scene
Catalyst.app/Contents/Resources/ae/butler
```

Electron supplies the backend with:

```text
HERMES_LUCID_BUTLER_PATH=<exact packaged Butler path>
```

The MCP runtime records the command after its normal executable resolution. Per-call enrichment requires the
resolved realpath to match the enrolled path. First-party naming alone is not admission.

Current packaged Butler SHA-256:

```text
2def1edd20590cc3d30ca01d859231d5d95515ef222747a9e651ddf7314fc27c
```

This path/hash evidence is useful package provenance. It is not by itself role, lease, session, or mutation
authority.

### 1.5 First-class Desktop posture

Owners:

```text
apps/desktop/src/app/skills/hub.tsx
apps/desktop/src/app/skills/mcp-tab.tsx
apps/desktop/src/app/skills/lucid-bridge-status.tsx
apps/desktop/src/types/hermes.ts
hermes_cli/web_server.py
```

Hub and MCP inspector share one status component. The user sees:

```text
Host identity bound
  request-scoped MCP metadata

Authority held
  Butler capability required per call

Receipts native
  Butler/Envelope
```

The authenticated catalog response exposes only:

```json
{
  "schema": "hermes-lucid-host-bridge/1",
  "server": "lucid-quine",
  "transport_admitted": true,
  "identity_binding": "request-scoped",
  "authority": "butler-capability-required",
  "capability_material_exposed": false,
  "arguments_mutated": false,
  "receipt_owner": "Butler/Envelope"
}
```

It contains no session ID, token, grant, signature, key, token path, role-private identity, capability bytes, raw
resource, raw Envelope, or model content.

### 1.6 First-class chat receipt rendering

Owners:

```text
apps/desktop/src/lib/lucid-receipt.ts
apps/desktop/src/components/assistant-ui/tool/lucid-receipt-card.tsx
apps/desktop/src/components/assistant-ui/thread/message-parts.tsx
```

The assistant Thread now renders valid LUCID tool results as a dedicated receipt card rather than a generic MCP
JSON row. Admission requires both:

```text
exact tool name mcp__lucid_quine__lucid_<closed verb>
exact closed hermes-lucid-receipt/1
```

The TypeScript parser independently revalidates exact receipt keys, verb/tool agreement, ID, timestamp, trust,
content hash, refusal code, `ran`, and `needs_user`. Foreign MCPs cannot trigger the card by forging only the
schema. Malformed, open, mismatched, and secret-shaped lookalikes fall back to the existing generic renderer.

The card visibly distinguishes:

```text
Executed
Refused · not run
Needs user · not run
Verified · not run
```

It shows only the intended result/error plus the already-closed receipt fields. It does not parse raw Envelopes,
load capability state, or claim authority.

Receipt-less hardening states are also first-class. Exact-provenance, exact-shape `lucid-outcome-unknown` and
`lucid-invalid-receipt` DTOs render as a distinct safety card rather than a generic tool row:

```text
Outcome unknown
  Do not retry automatically

Invalid receipt
  No effect status accepted from this response
```

Outcome unknown is rejected for `lucid.get` and requires exact server/tool echoes for one effect-capable verb.
Invalid receipt accepts only the two exact backend messages for refusal/success receipt validation failure. Open,
retryable, mismatched, foreign, and forged shapes stay on the generic fallback path. The safety card never claims
execution or Butler refusal.

Two Desktop lifecycle regressions discovered during packaged verification are closed separately from Butler
authority:

- a healthy local `hermes --version` measured 8.6 seconds, exceeding the old shared 5-second probe and causing a
  false bootstrap attempt; CLI liveness now has a bounded 15-second budget while runtime import probes remain 5s;
- selecting the already-loaded main conversation from a full-page tab previously fronted the workspace pane but
  skipped React Router navigation, leaving the page visible; session-open disposition now distinguishes `tile`,
  `main`, and `load`, and both `main` and `load` navigate to the conversation route.

Neither repair changes LUCID identity, authority, capability, retry, or receipt semantics.

### 1.7 RUN-UGUI semantic GUI alignment

Costas now consumes the architecture in `AgentExperiments/docs/RUN-UGUI-KX.md` rather than a literal port of
RUN's terminal presentation. The accepted path is:

```text
typed RUN facts
→ ugui::executive normalized card composition
→ ugui::project Scene 1.0.0
→ one generic Desktop Scene painter
```

The Desktop no longer authors a second executive tab strip or per-tab heading. UGUI-owned `shell.tab.*` Scene
handlers are the sole executive navigation source. Scene `layout.height` is realized generically (`"*"` consumes
the flex remainder; fixed extents remain shrink-only), with no tab-specific React layout branches. Costas admits
an informational projector label only when the closed semantic structure is valid, and rejects:

- empty projector provenance or semantic structure inconsistent with the claimed batch;
- missing/reordered shared shell handlers;
- mismatched `run-<tab>` card identity;
- card Scenes without elastic layout intent;
- ANSI or box-drawing terminal-shaped text.

`asset://` images currently produce a named `asset-catalog-unavailable` painter loss with authored alt text; Costas
does not invent or silently substitute art before a registered UGUI asset port exists.

The staging freshness set now includes all four `ugui/src/executive/*.rs` composers, projection action/section/
projector, GEOM Scene layout, and the Scene schema so a stale terminal-first adapter cannot survive a landed AE
refactor.

The packaged adapter now emits nine semantic Scenes accepted by the exact Electron validator. Every Scene has the
nine ordered `shell.tab.*` handlers, one elastic layout region, and zero ANSI/box-drawing terminal text. HOME,
DASHBOARD, LUCID, SCORES, METRICS, LOGS, STUDIO, and SETTINGS carry stable `run-<tab>` card identity; QUINE
retains its canonical hosted Scene identity. The adapter's projector label still names the historical route, but
closed structural evidence—not that informational string—controls admission.

---

## 2 · Live observed evidence

The packaged Catalyst app was rebuilt and restarted from checkpoint `415b82b34`.

Observed live process chain:

```text
Catalyst
└── hermes serve
    └── mcp_stdio_watchdog
        └── Catalyst.app/Contents/Resources/ae/butler --mcp-stdio
```

The active backend environment contains the exact packaged Butler path. After lifecycle checkpoint `7b5c0f22b`,
Catalyst was restarted across an exact saved Desktop log boundary:

```text
old Catalyst PID                 14636
new Catalyst PID                 24009
new backend port                 52559
new log lines                    13
MCPServerTask ignored exceptions 0
Event loop is closed traces      0
```

The unrelated node-pty `spawn-helper` app-asar packaging warning remains outside the LUCID MCP lifecycle claim.

The live authenticated MCP catalog
reports:

```text
installed                  true
enabled                    true
transport_admitted         true
identity_binding           request-scoped
authority                  butler-capability-required
capability_material_exposed false
arguments_mutated          false
receipt_owner              Butler/Envelope
```

The live MCP probe returns:

```text
protocol    2025-06-18
tools       7
prompts     8
resources   25
stderr      empty for LUCID probe
```

Safe operations observed:

```text
resources/read lucid://projects/onboarding/universal    GREEN
resources/read lucid://projects/system/current          GREEN, explicit unavailable enrichment
prompts/get lucid.get                                   GREEN, non-authorizing recipe
tools/call lucid.get path=fleet without capability     typed no-capability refusal
```

After receipt UI checkpoint `3cad87963` was packaged into clean Desktop checkpoint `f7835a87d`, Catalyst was
restarted and the installed MCP was invoked through the active Hermes session. The live tool boundary returned:

```json
{
  "error": "Butler refused LUCID call (no-capability)",
  "lucid_receipt": {
    "schema": "hermes-lucid-receipt/1",
    "verb": "get",
    "ran": false,
    "trust": "untrusted",
    "refusal_code": "no-capability",
    "needs_user": false
  }
}
```

The actual receipt also carried its bounded ID, timestamp, and SHA-256 content hash. They are omitted from this
prose excerpt to avoid making one ephemeral receipt identity part of the protocol claim. The Desktop Thread
parser accepted the same closed shape covered by its component/integration tests; malformed or foreign
lookalikes remain on the generic fallback path.

The enriched direct frame preserved the original arguments and returned:

```text
receipt.ran      false
receipt.trust    untrusted
receipt.effect   capability is required
refusal.code     no-capability
refusal.reason   capability is required
capability       null
```

This proves identity projection without authority widening.

---

## 3 · Verification evidence

Focused backend/security/API suites:

```text
HERMES_PYTHON=/Users/mutilar/.hermes/venvs/costas-code/bin/python \
  scripts/run_tests.sh \
  tests/tools/test_lucid_mcp_bridge.py \
  tests/tools/test_mcp_tool.py \
  tests/hermes_cli/test_mcp_catalog.py \
  tests/hermes_cli/test_dashboard_admin_endpoints.py -q

4 files
368 passed
0 failed
```

Coverage includes:

- exact packaged Butler admission;
- same-name wrong-realpath impersonation refusal;
- malformed and over-bound session refusal;
- LUCID metadata attached outside model arguments;
- explicit handler session identity preferred over ambient context;
- ordinary MCP receives no LUCID metadata;
- no capability/signature material attached;
- closed content-free `hermes-lucid-receipt/1` projection;
- raw Butler error text and raw Envelope fields omitted for admitted LUCID calls;
- malformed LUCID structured errors fail closed as `lucid-invalid-receipt`;
- successful LUCID calls discard raw text and raw `structuredContent.envelope`;
- successful LUCID calls expose only intended `result` plus the closed receipt;
- malformed successful LUCID receipts fail closed without result/text fallback;
- foreign MCP success/error behavior remains unchanged;
- policy refusals do not trip the MCP transport circuit breaker;
- automatic retry disabled for SHOW/SET/MORPH/DISPATCH/STEER/CANCEL;
- exact `lucid-outcome-unknown` on effect-capable transport ambiguity;
- GET alone retains bounded generic transport recovery;
- lifecycle waiter cancellation checks its owner loop before `Task.cancel()`;
- the exact `Event loop is closed` finalization race is swallowed without widening other errors;
- normal pending lifecycle tasks are still cancelled and awaited;
- content-free public status;
- Hub install/open behavior and trust ladder;
- MCP catalog/API projection.

Additional gates:

```text
Ruff focused paths          GREEN
Desktop TypeScript          GREEN
Desktop ESLint              GREEN, baseline unrelated warnings only
Hub UI tests                GREEN
Receipt/safety UI + Thread  31 passed
Chat route regression       56 passed
CLI probe tests             11 passed
UGUI semantic consumer UI   73 passed
UGUI Electron boundary      15 passed
Production renderer build   GREEN
Electron main/preload       GREEN
Packaged Catalyst.app       GREEN
git diff --check            GREEN
```

Current source hashes:

```text
2185981336c7267328024e7f43251c5d3ee6a86d4a7666212f72dee8c963ce12  tools/lucid_mcp_bridge.py
0ac404021e8ec1866c1927ac0bc5f2c7cd2f712495513038596b05fa5d38e998  tools/mcp_tool.py
b89e1911232904751638ce2832667d940b85d897a317f4dbd12d3195a628ff2b  hermes_cli/web_server.py
96ce91596e89e58f6b5cd7684bfa8e6b2930b68881b6aaf6f4ce700667df1244  apps/desktop/src/app/skills/lucid-bridge-status.tsx
41001efad2646ca1b22ce1d150439f4ea59f3c0bdf27bb4f125d896437d5085f  optional-mcps/lucid-quine/manifest.yaml
8ca0160475047b7cb841e63ab8e9d8d1d9d7c1a435bdccb977354a68b1911a17  tests/tools/test_lucid_mcp_bridge.py
262ccac4a40eed120e23fbd0a4d86117d1886084826f5a5156c109517eea438e  tests/tools/test_mcp_tool.py
708668edeb985a173f2d7bf30e01ae56a05aec30227389129b7c558c580b6ee3  apps/desktop/src/lib/lucid-receipt.ts
1a0ebefcf4a13b993afb0e2acfb5a680ae8909828ff5727b093bd2aad14cc3c8  apps/desktop/src/components/assistant-ui/tool/lucid-receipt-card.tsx
e64a389ccd67ef0b10c017ff3249eadbe28352523f344a6ef850c6736178fc90  apps/desktop/src/components/assistant-ui/tool/lucid-safety-state-card.tsx
738240b5ffb2232a35640603707046251dd46f08c14b8c6f22c22dca6acc8643  apps/desktop/src/components/assistant-ui/thread/message-parts.tsx
2dd43df0534cd3f3e783cc65ef921d37111f621faa15eb89c417c2b619356b53  apps/desktop/src/lib/lucid-receipt.test.ts
7d8edae58402d0927df42f72ed03be04228f876e21d116cf34f6c813b78ffd93  apps/desktop/src/components/assistant-ui/tool/lucid-receipt-card.test.tsx
05bc52313044d0b22fefed0d658107ab638cc0e2f550e5c296a7c0529e887bb9  apps/desktop/src/components/assistant-ui/thread/streaming.test.tsx
b98b2eb698af7d01e10ab334c3d0b2678cba275eee94ffd8027982acc9bf80b6  apps/desktop/electron/backend-probes.ts
644614bfe36b17ac40a3b4b133810ff49f09561f1804ce20a9fcae1b735c6089  apps/desktop/electron/backend-probes.test.ts
7e41c7d2a18b50ab796856fbd1fe6975197a8502afdc1599055b913e84638d9f  apps/desktop/src/store/session-states.ts
70ac25cc7df510b535af0115ccf3f195babd20276b2a8150903d1831960383e6  apps/desktop/src/store/session-states.test.ts
fbb0fe6394c45e4d9869dc0c9c8fb34bba2c15d801d48ef5ca45470ba32cddb0  apps/desktop/src/app/contrib/wiring.tsx
6f0cc30876d6a553744022dda93daea197169c4249065583e33a8f871f0d495e  apps/desktop/electron/ae-executive.ts
4bd458bdcafc7a093c25bc2a090fa612451452d5557ba832d5edfdc2fb12c48e  apps/desktop/scripts/stage-ae-executive.mjs
297580d44bddf79e374c2194c3f35cb415460bb534e47ed7d4672e30fb8f0899  apps/desktop/src/app/ae-executive/index.tsx
07078a6eb8e4ac5c6f8e8a1e38db5e1742a4fad053e299c5420f1ed057fea917  apps/desktop/src/app/ae-executive/scene.ts
a2e7e0ccfaed38a1d43abbbe4d3b0f5e3685540a99affd2be07d487a29e5a831  apps/desktop/src/app/ae-executive/scene-painter.tsx
daf59af27222c3967a6461f32f791771566d51f00d8799aff8820f3aaca6a2ef  apps/desktop/src/app/ae-executive/index.test.tsx
adf47cc9ef158d07e0448c42c5b84b9ee9f5c5190d131cc7b056c7d618d00c1f  apps/desktop/electron/ae-executive.test.ts
```

---

## 4 · Why Costas stops at identity

Butler already defines the critical law:

```text
host context authority = none
```

The `session_id` in MCP `_meta` identifies the originating Hermes request. It does not prove:

- an AE role;
- a live role lease;
- repository authority;
- a canonical LUCID grant;
- scope authority;
- confirmation;
- capability possession;
- enrollment of the stdio parent;
- a process/package episode;
- permission to retry a consequential operation.

The existing Butler local capability is:

- owner-private;
- repository-bound;
- session-hash-bound;
- role-policy-bound;
- lease-sensitive;
- verb/scope checked;
- expiring;
- MAC verified;
- stored outside MCP telemetry.

Hermes cannot safely load it because that would:

1. duplicate Butler's broker policy in Python;
2. place bearer material in the generic MCP client's memory;
3. expand logging, crash, middleware, and plugin exposure surfaces;
4. create a second authority that can drift from QUINE and role-session state;
5. risk cross-session reuse on process-global MCP connections;
6. make identical model-visible calls gain hidden ambient authority.

Therefore Costas intentionally sends identity only and preserves the no-capability receipt.

---

## 5 · Requested Butler R1 increment

### 5.1 Required owner

Butler remains the sole capability issuer/loader/verifier. QUINE remains policy, acceptance, and settlement
owner. Costas remains transport/presentation/session-origin owner.

### 5.2 Requested behavior

For exact admitted stdio LUCID calls only, Butler should be able to consume the bounded host context and resolve
one exact internal authority decision without returning capability material to Hermes.

Conceptual flow:

```text
1. Parse request _meta host context.
2. Verify transport is stdio and the host/process enrollment is admitted.
3. Resolve exactly one host-session ↔ AE role-session binding.
4. Re-observe canonical repository, role, lease, and revocation state.
5. Load or issue the owner-private local capability internally.
6. Verify capability against the same exact session, verb, scope, expiry, repository, role policy, and MAC.
7. Apply independent confirmation policy.
8. Execute once, refuse, escalate, or report outcome-unknown.
9. Return only the bounded Envelope receipt/result.
```

### 5.3 Binding requirement

Do not treat the Hermes session ID itself as an AE role session. R1 needs an exact, typed binding owner.

A valid design must answer:

```text
Which registry owns the binding?
Which side enrolls it?
What package/process observation admits the host?
How is profile/repository identity bound?
How is session rotation handled?
How is role/lease/revocation freshness rechecked?
How is ambiguous or absent binding represented?
How is the binding closed and garbage-collected?
```

Costas already has a durable observe-only external role-session binding foundation in SessionDB. That foundation
must not be silently upgraded to authority. AE EM should decide whether R1 consumes a separately attested
projection of that binding, defines a Butler-owned binding registry, or remains HOLD pending the broader
execution-host enrollment track.

### 5.4 No token crossing

R1 must not require Hermes to send any of:

```text
localCapability
capability
grant
scope
signature
broker key
token path
token bytes
role text as authority
lease material
```

The preferred R1 shape is Butler-internal capability resolution after trusted host and exact binding validation.
If that cannot be made safe, return a typed hold/refusal. Do not add a compatibility bypass.

### 5.5 Confirmation

Identity and capability must not imply confirmation.

For operations requiring confirmation, Butler must consume a separately host-owned confirmation decision bound
to the exact request/operation. The existing QUINE confirmation policy remains authoritative. Hermes must not
force `confirmed=true`, infer it from a click that was not bound to the call, or retry a refused call as confirmed.

### 5.6 Replay and outcome ambiguity

Hermes' generic MCP client has bounded reconnect/auth/session retry paths. Costas TTD hardening now intercepts
the exact admitted LUCID tool before either generic retry helper:

```text
lucid.get                                            bounded generic recovery remains eligible
lucid.show|set|morph|dispatch|steer|cancel          automatic retry disabled
transport exception after effect-capable invocation lucid-outcome-unknown; retryable=false
```

The no-retry decision requires the same exact packaged-Butler realpath admission as host identity. Foreign and
same-name MCP servers retain generic behavior. This prevents one immediate duplicate-effect class but is not a
durable outcome ledger.

Before mutation-capable R1 is GREEN, Butler/QUINE should still define one of:

```text
A. end-to-end idempotency key + durable outcome lookup; or
B. no automatic retry for consequential LUCID verbs, with typed outcome-unknown.
```

Local timeout/cancellation does not prove the Butler effect did not run.

### 5.7 Response projection

Costas TTD hardening now consumes Butler's `structuredContent.envelope` only through a closed validator and emits:

```text
schema = hermes-lucid-receipt/1
id
timestamp
verb
ran
trust
content_hash
refusal_code
needs_user
```

The projector requires exact closed Envelope/intent/receipt/refusal/escalation shapes and canonical verb, trust,
refusal-code, content-hash, timestamp, ID, and boolean forms. It structurally omits:

```text
intent.args
capability
fidelity
receipt.effect
refusal.reason
escalation.reason
result
unknown fields
session identity
```

For an admitted successful LUCID call, generic MCP text is also never forwarded. Costas returns only the intended
`structuredContent.result` plus the same closed receipt. Missing or malformed successful receipts fail closed as
`lucid-invalid-receipt`; there is no fallback to text or raw structured content. Foreign MCP success and error
projection remains unchanged.

For an admitted LUCID `isError`, raw Butler text is never forwarded. A valid receipt yields a generic bounded
summary such as `Butler refused LUCID call (no-capability)` plus the closed DTO. An invalid receipt yields only
`lucid-invalid-receipt` with `retryable=false`. Ordinary MCP errors retain generic behavior. Valid Butler policy
refusals do not increment the MCP transport circuit breaker.

AE EM should attest or revise `hermes-lucid-receipt/1`. Costas will not widen it without an AE-owned disposition.

---

## 6 · Acceptance tests requested from AE

### R1 identity and binding

- valid admitted stdio host context plus exact live binding resolves one role session;
- absent, malformed, duplicate, HTTP, foreign-parent, stale, and ambiguous context refuse;
- model arguments containing `_meta`, host-context keys, `localCapability`, or forged call context refuse;
- Hermes session A cannot resolve or reuse session B authority;
- session rotation invalidates the old binding;
- profile/repository mismatch refuses;
- process/package episode mismatch refuses or holds according to the attested enrollment contract.

### R1 capability custody

- token bytes never cross the Butler process boundary;
- token/key paths never enter responses or ordinary logs;
- exact grant, scope, session, repository, role, expiry, revocation, and MAC are reverified per call;
- a read-only role cannot perform set/dispatch/steer/cancel;
- role text or first-party branding alone never authorizes;
- weak permissions, symlinks, replacement races, expiry, and stale key generation refuse.

### Confirmation and effects

- capability does not imply confirmation;
- unconfirmed consequential calls do not reach the host effect;
- confirmed calls bind confirmation to the exact request;
- response loss produces duplicate-safe replay or typed outcome-unknown;
- no generic reconnect path repeats a mutation without reconciliation;
- receipt `ran` is true only after the effect owner's execution boundary.

### Isolation and redaction

- ordinary MCP frames remain unchanged;
- LUCID resources, prompts, initialize, list, ping, and health probes receive no authority material;
- only exact tools/call receives the admitted identity/binding path;
- two concurrent Hermes sessions retain immutable separate bindings;
- raw sessions, capability JSON, signatures, grants, keys, environment, cwd, and private role identifiers are
  structurally absent from logs, telemetry, errors, transcripts, and Desktop DTOs.

---

## 7 · Proposed owner split

| Concern | Costas / Hermes | Butler | QUINE |
|---|---|---|---|
| Hub/install/catalog | owner | packaged capability | no |
| Desktop presentation | owner | supplies bounded status/receipt | acceptance semantics |
| MCP process lifecycle | owner | child server | no |
| executable admission input | owner | self/parent enrollment verification | attestation acceptance |
| originating Hermes session | owner | validates/binds | no authority from identity alone |
| host-session ↔ role-session binding | supplies attested input if admitted | **requested R1 owner or consumer** | canonical role/lease truth |
| capability custody | forbidden | **sole owner** | policy truth |
| grant/scope verification | no | owner | canonical grammar/policy |
| confirmation | collects explicit decision | verifies exact binding | policy owner |
| effect | no generic bypass | registered host adapter | acceptance/settlement |
| receipt | paints bounded DTO | creates Envelope | validates semantics |

---

## 8 · Current HOLDs

The following remain unavailable or unauthorized:

- treating MCP host context as authority;
- loading Butler token files from Hermes;
- automatic `localCapability` injection;
- hidden grant/scope/signature injection;
- inferring AE role from a Hermes chat/session ID;
- role/lease mutation from Desktop presentation state;
- mutation retries without idempotency/outcome reconciliation;
- raw Envelope forwarding to React;
- first-party branding as executable/process enrollment;
- HTTP LUCID host-context authority;
- generic MCP server authority upgrade;
- QUINE acceptance or settlement by Costas.

Current green state is identity-bound and authority-held. That is a product improvement and a security boundary,
not an incomplete claim of execution.

---

## 9 · Requested disposition

AE EM / Butler / QUINE owners: return exactly one disposition bound to the Costas identity checkpoint
`415b82b34b7c6516decedd6f05d655025d11a0c2`, TTD hardening checkpoint
`9bb6e4f67697e6435056ed2b2b0fe56bc194a165`, success-projection checkpoint
`8e48fab077116554add17832a0aaf714e816373f`, lifecycle hardening checkpoint
`7b5c0f22b4abcd007b9f29e7f74acd43adf10e5d`, receipt UI checkpoint
`3cad879636f536d8cb28f6e361b04c1ddb170c28`, clean packaged UI checkpoint
`f7835a87d6ad3072d9a56305e88854132a4d9938`, safety-state UI checkpoint
`e943c61bece7e6c8baa0e0fd4441f469b46bd59c`, CLI probe checkpoint
`a5cb4a304b1e70c5ab6cb6b705cdb775a7dd8bdb`, chat navigation checkpoint
`83eba5585b53b748ff1bae7f930deb3302597fdc`, RUN-UGUI consumer checkpoint
`55fc59948c7cc5f94797d3214d1e33e8bd7d7958`, structural UGUI admission checkpoint
`c8a628d441d65fb311e780cb1dfbf8419bfd6217`, and this document hash:

```text
ATTEST BUTLER-R1-INPUT
REVISE BUTLER-R1-<named invariant>
HOLD BUTLER-R1
```

`ATTEST BUTLER-R1-INPUT` means only:

- Costas' identity-only input is admitted as the starting contract;
- Butler remains the capability owner;
- authority remains held until the separately implemented and tested R1 binding/capability path is green.

It grants no role, lease, grant, scope, confirmation, mutation, retry, settlement, or product acceptance.

## 10 · Rollback

Costas checkpoints:

```text
identity bridge    415b82b34b7c6516decedd6f05d655025d11a0c2
TTD hardening      9bb6e4f67697e6435056ed2b2b0fe56bc194a165
success projection 8e48fab077116554add17832a0aaf714e816373f
lifecycle hardening 7b5c0f22b4abcd007b9f29e7f74acd43adf10e5d
receipt UI          3cad879636f536d8cb28f6e361b04c1ddb170c28
clean packaged UI   f7835a87d6ad3072d9a56305e88854132a4d9938
safety-state UI     e943c61bece7e6c8baa0e0fd4441f469b46bd59c
CLI probe hardening a5cb4a304b1e70c5ab6cb6b705cdb775a7dd8bdb
chat navigation     83eba5585b53b748ff1bae7f930deb3302597fdc
RUN-UGUI consumer   55fc59948c7cc5f94797d3214d1e33e8bd7d7958
UGUI admission      c8a628d441d65fb311e780cb1dfbf8419bfd6217
```

Rollback structural UGUI admission by reverting `c8a628d44`; rollback RUN-UGUI consumer alignment separately by
reverting `55fc59948`; rollback chat navigation separately by reverting
`83eba5585`; rollback CLI probe hardening separately by reverting
`a5cb4a304`; rollback safety-state UI separately by reverting `e943c61be`; rollback packaged evidence separately by reverting
`f7835a87d`; rollback receipt UI separately by reverting `3cad87963`;
rollback lifecycle hardening separately by reverting
`7b5c0f22b`; rollback success projection separately by reverting
`8e48fab07`; rollback TTD hardening separately by reverting
`9bb6e4f67`; rollback identity enrichment separately by reverting
`415b82b34`. The prior first-class Hub/catalog install remains separately checkpointed at `6a5d26774`.

No AE file is modified by this handoff. AE may copy this document into its docs shelf or return disposition in a
new AE-owned feedforward.

<!-- Cross-refs: optional-mcps/lucid-quine/manifest.yaml; tools/lucid_mcp_bridge.py;
     tools/mcp_tool.py; hermes_cli/web_server.py; apps/desktop/src/app/skills/hub.tsx;
     apps/desktop/src/app/skills/mcp-tab.tsx; apps/desktop/src/app/skills/lucid-bridge-status.tsx;
     docs/catalyst-host-track-c1.md; sibling ../AgentExperiments/envelope/MCP.json;
     sibling ../AgentExperiments/envelope/LUCID.json; sibling ../AgentExperiments/docs/LUCID-MCP.md;
     sibling ../AgentExperiments/butler/src/server/host_context.rs;
     sibling ../AgentExperiments/butler/src/capability_broker.rs;
     sibling ../AgentExperiments/butler/src/server/tools.rs. -->

---
maintainer: admiral-only
edit_policy: |
  DO NOT MODIFY VIA CARRIER DISPATCH.
  This document is the Admiral persona's self-model — its operational reference
  for how the system prompt and live Fleet state flow through fleet-cli,
  fleet-carriers, and core-infra. Updates must originate from the Admiral
  directly, in response to verified code changes in prompt assembly or runtime
  lifecycle machinery.
---

# Admiral Prompt & Runtime Architecture

> This document is owned by the Admiral persona only. Updates must come only
> from the Admiral, in response to verified changes in prompt assembly, runtime
> lifecycle machinery, or Admiral protocol and carrier prompt policy.

---

## 1. Purpose

This document is the operational reference for the Admiral's prompt assembly and
runtime lifecycle model. The current architecture has no per-turn runtime-context
tag prefix. The Admiral system prompt is assembled inside `fleet-cli`, and
live protocol/carrier/job state is consumed through public leaf package APIs and
package-local policy modules.

This document is for the Admiral. It is not a public spec, not a contributor
guide, and not a Carrier-managed asset. Post-verification documentation and
Fleet Wiki mutation are performed directly by the Admiral through the
`wiki-operations` skill; they are not delegated to Carriers.

---

## 2. System Prompt Shape

`createSystemPromptBuilder(...).build(...)` in
`packages/fleet-admiral/src/prompts/index.ts` assembles the Admiral prompt. The
builder accepts the legacy `build(enableMetaphor)` overload (classic doctrine) or
`build({ enableMetaphor, doctrine })`, then delegates the whole body to exactly
one doctrine module: `prompts/classic.ts` or `prompts/gateway.ts`. The two
modules share no prompt text — each owns its sections outright, and the
duplication is deliberate.

**Classic doctrine** static prompt:

- `<fleet section="preamble">` — always injected first
- `<fleet section="persona">` — injected before role only when metaphor is enabled
- `<fleet section="role">` — always injected
- `<fleet section="tone">` — injected after role only when metaphor is enabled
- `<fleet section="roster">` when carriers are registered, rendered at the
  routing tier only (selection metadata — summary, `Use for`, `NOT for`), with a
  preamble pointing at the on-demand `carrier-operations` skill
- `<fleet section="protocol-gate">` containing the always-on intent gate, mode gate, standard fallback, and downward guard for irreversible, structural, multi-module, or doctrine/prompt-policy work
- `<fleet section="standing-orders" type="<id>">` as six separate always-on Standing Order blocks, with Command Integrity injected first as the order-reception contract upstream of Mission Anchor

**Gateway doctrine** static prompt drops carrier operations, protocol modes, and
the metaphor overlays entirely:

- `<fleet section="preamble">` then `<fleet section="role">`
- `<fleet section="standing-orders" type="<id>">` — six blocks, ids
  `command-integrity`, `mission-anchor`, `context-confidence`,
  `orchestration-policy`, `deep-dive`, `result-integrity`
- **No** `protocol-gate`, `roster`, `persona`, or `tone` block. `enableMetaphor`
  has no effect on this path — both settings produce a byte-identical prompt.

### 2.1 Classic vs Gateway Dual Doctrine

Metaphor and doctrine are orthogonal axes:

| Axis | Values | Controls |
|---|---|---|
| Metaphor | `enableMetaphor` boolean | Persona + Tone overlays, classic doctrine only |
| Doctrine | `classic` \| `gateway` | The entire prompt body, and which skill assets the Fleet plugin renders |

Doctrine resolution is owned by `resolveDoctrineFromCliId`:
`claude-gateway` → `gateway`; every other Agent CLI id → `classic`.
`injectAgentCliProfile` passes `{ enableMetaphor, doctrine }` into
`buildSystemPrompt` and forwards the same doctrine into plugin rendering.

**Classic doctrine** retains the carrier_dispatch path:

- Roster preamble points at the on-demand `carrier-operations` skill and
  instructs loading it before the first `carrier_dispatch`.
- Protocol gate Intent Gate names carrier dispatch as workspace action; Mode
  Gate / Downward Guard / Mode Mapping speak in Carrier / multi-carrier terms.
- Standing Order bodies for Carrier Operations Policy, Deep Dive, and Result
  Integrity keep `carrier_dispatch` / `carrier_jobs` wording.
- Plugin skill render includes classic `protocol-*` skills plus
  `carrier-operations`, and omits the `gateway/` authoring tree.

**Gateway doctrine** carries neither protocol modes nor carrier operations:

- No protocol-gate block is rendered and no `protocol-*` skill is installed, so
  the gateway prompt names no protocol mode at all. Standing Orders are the
  whole binding doctrine, and the role block says so directly.
- No roster block is rendered; carrier selection metadata, `carrier_dispatch`,
  `carrier_jobs`, `carrier_id`, and the `carrier-operations` skill are absent
  from the prompt. Doctrine names which execution surface a staged run requires;
  that surface's arguments and script syntax come from live tool metadata only.
- No Persona or Tone overlay is rendered, so the gateway path carries no naval
  ranks or forms of address regardless of `enableMetaphor`.
- Standing Order bodies live solely in
  `src/protocols/standing-orders/gateway.ts`, the doctrine peer of
  `standing-orders/classic.ts`; each file holds all six order bodies outright.
  `carrier-operations-policy` is replaced by `orchestration-policy`, which names
  no executor persona: one execution that returns its result is a `run`, `stage`
  is reserved for the workflow surface, and both carrier and subagent vocabulary
  are absent. Because every exposed model is already registered as a named Agent
  in the session, the doctrine describes a run as a call that returns; the
  asynchronous job vocabulary of the carrier path — queue, file a job, poll for
  completion — is absent, and so is the `<system-reminder>` preamble paragraph
  that explained carrier job completion signals. Result Integrity instead states
  that a failed run usually arrives as an empty or missing return rather than an
  error. Mission Anchor and Context Confidence speak in decision boundaries
  instead of protocol checkpoints.
- Plugin skill render installs `assumption-audit` and `wiki-operations` plus the
  gateway-only run skills — `workflow`, `workflow-architecting`,
  `workflow-research`, `workflow-implementing`, and `workflow-review`. Each run skill
  owns the shape of one stage skeleton; `workflow` owns executing any of them,
  including model and reasoning-effort assignment per stage. The `gateway/`
  authoring prefix is never exposed as a live skill path.
- The `carrier_dispatch` and `carrier_jobs` MCP tools are withheld from the
  session itself, not merely from the prompt: `injectAgentCliProfile` passes an
  `includeTool` predicate (`isHostSessionToolAllowed`) into
  `issueSessionToken`, so the gateway host session token never carries them.

Under classic doctrine, `enableMetaphor` controls role-playing as one coherent
option: enabling it adds both the naval Persona and Tone overlays; disabling it
adds neither. Gateway doctrine ignores the flag and never renders either overlay. The
always-on role, protocol gate, Standing Orders, protocol skills, and any carrier
routing metadata use neutral actor terms so the disabled path does not retain
naval ranks or forms of address. `Fleet`, `Carrier`, and registered carrier names
remain functional product identifiers in both modes. Metaphor never changes doctrine selection.

When enabled, the Persona carries an explicit semantic role map: `user` →
Admiral of the Navy, `host agent`/`you` → Admiral, and `Carrier` → Captain. The
Persona exists only under classic doctrine. The map controls interpretation and
conversational wording only; it never rewrites functional identifiers such as tool names, `carrier_id`
values, skill IDs, XML tags, commands, code symbols, or file paths.

The preamble describes only the rendered `<fleet section="...">` blocks and
optional `type` narrowing. It does not describe per-tool block narrowing. Output
skeletons and report templates follow the session's working language, while
functional identifiers such as skill IDs and report-token keys remain fixed.

The full protocol workflows are not inlined into the static Admiral prompt.
Under classic doctrine, operational requests load exactly one built-in protocol
skill on demand: `protocol-baseline`, `protocol-midline`, `protocol-redline`, or
`protocol-frontline`, and the per-carrier request-block contracts and dispatch
composition rules remain on-demand via the `carrier-operations` skill. Under
gateway doctrine neither the protocol skills nor `carrier-operations` are
rendered at all, and live tool metadata owns orchestration mechanics. Skill
loading is idempotent per session: content already in context is applied
without reloading. `packages/fleet-admiral` owns those packaged skill assets and Fleet plugin/persona/marketplace rendering; `fleet-cli` and `fleet-console` consume them through the public root package API. `fleet-admiral` owns the prompt gate and Standing Order policy. There is still no protocol
registry, persisted mode setting, runtime switching API, or Fleet CLI protocol
selector UI.

Under classic doctrine, each protocol skill owns its checkpoint declaration.
Gateway doctrine has no protocol skills, so its Mission Anchor and Context
Confidence bodies key off decision boundaries instead. Baseline mode declares no
checkpoints and therefore uses Mission Anchor Compact Mode; midline declares
Reconnaissance, Plan, Execution, and Verification; redline adds Risk review;
frontline declares Decomposition, Dispatch, Integration, and Verification.
The skill cadence is two informative reports: `brief: <...>` after readiness
checks and `status: executing` when execution begins. Report-token keys use the
fixed `key: value` grammar.

The prompt does not inline per-tool guide blocks. Live MCP tool descriptions
and schemas remain the tool-specific authority for usage and arguments outside
the static Admiral prompt, including carrier request format, brevity, polling,
and result lookup mechanics. The prompt also does not teach request-time tags
for active protocol or taskforce availability. The removed tags are not
generated by the Admiral prompt path.

Context Confidence thresholds are differentiated by protocol boundary. Baseline
mode has no planning micro-check, midline requires sufficient confidence, and
redline plus frontline require complete confidence. Result Integrity owns
the verification-loop routing table: received results run the three integrity
checks, mutating finalized jobs or delegated stages run the Artifact Inspection
Gate, speculation routes to Deep Dive, and contradictions with verified facts
route back to Context Confidence.

Command Integrity completes the integrity pipeline upstream: order reception
(Command Integrity) → evidence sufficiency (Context Confidence) → outcome
verification (Result Integrity). It owns professional pushback on technically
flawed orders, scope discipline against implicit permissions, priority
arbitration on conflicting directives, and the pre-engagement clarification
trigger that routes decision-shaped requirements ambiguity to
`assumption-audit` before work starts. `assumption-audit` therefore has three
callers: the active protocol (classic only), Standing Order re-entry, and the
Command Integrity pre-engagement trigger.

---

## 3. Live State Access

Runtime state is read through direct owners:

- Protocol gate and Standing Order policy: `packages/fleet-admiral/src/protocols/**`. Standing Order bodies are split by doctrine into `standing-orders/classic.ts` and `standing-orders/gateway.ts`; prompt assembly is split the same way into `src/prompts/classic.ts` and `src/prompts/gateway.ts`.
- Built-in protocol skill assets: classic source at `packages/fleet-admiral/assets/skills/{protocol-baseline,protocol-midline,protocol-redline,protocol-frontline,assumption-audit,carrier-operations}/SKILL.md`, plus gateway overlays under `packages/fleet-admiral/assets/skills/gateway/<name>/SKILL.md`, generated into the embedded ESM manifest `EMBEDDED_AGENT_CLI_SKILL_ASSETS` in `packages/fleet-admiral/src/agent-cli/assets.generated.ts` via `scripts/generate-fleet-admiral-assets.mjs`. The `carrier-operations` contracts section mirrors the registry's contracts-tier roster render and is locked by a sync test in `packages/fleet-admiral/tests/carrier-operations-skill.test.ts`. Gateway doctrine plugin render omits `carrier-operations` and every `protocol-*` skill, and remaps each `gateway/<name>` overlay onto the live `skills/<name>` path.
- Carrier registry and display state: `@dotobokuri/fleet-carriers`
- Carrier store, job stream state, and per-job workspace change manifest policy: `@dotobokuri/fleet-carriers`
- Workspace git-status scanner implementation: `runtime/fleet-cli`
- Executor/session/model state: `@dotobokuri/core-agent`
- MCP registry/server state: `@dotobokuri/core-agent`

These values are operational inputs for services, overlays, tools, and status
rendering. MCP registry/server state stays live for tool exposure, but no longer
serializes per-tool doctrine into the Admiral system prompt. These values are
not serialized into a per-turn prompt wrapper.

Detached carrier job summaries may include a best-effort workspace change
manifest with `window-approximate` attribution. `carrier_jobs(action:"result")`
surfaces the manifest through the summary, and `[carrier:result]` reminders show
only compact `changes=<statLine>` metadata so the Admiral can start artifact
inspection without embedding file lists in reminder text.

---

## 4. Lifecycle Boot

`runtime/fleet-cli/src/runtime/runtime.ts` is the lifecycle boot entry point.
`createFleetRuntimeLifecycle()` returns the lifecycle handle; its `start()`
performs boot side effects directly:

- creates infrastructure services
- creates the carrier runtime
- registers the executor port
- initializes agent sessions and carrier store
- registers default carriers
- initializes settings
- registers default Admiral tools
- registers Fleet Wiki executor tools
- starts the MCP server

The lifecycle's `shutdown()` first closes Carrier admission, then awaits
`CarrierRuntime.cleanup()` — which cancels every in-flight one-shot dispatch and
waits for its provider client to disconnect/finalize and its dispatch-context
registry to be disposed — before cleaning dedicated MCP sessions, stopping the
MCP server, and resetting settings. No global client pool is used.

---

## 5. Executor Path

Carrier execution is routed through `@dotobokuri/core-agent` `executeOneShot()`,
which builds a fresh provider client and child process per dispatch. Its
two-phase handle resolves `readiness` after connect/resume, MCP setup, and real
session/protocol discovery — the launch response waits for readiness while prompt
completion runs detached in the background. Each successful fresh launch returns
a generated `context_id`; passing it back as `resume_context_id` resumes the same
real provider session in a new process via the bounded, `CarrierRuntime`-owned,
process-local dispatch-context registry. Omitting it starts a fresh context.
Carrier requests receive the request body composed by
the caller plus the carrier system prompt assembled by
`buildCarrierSystemPrompt()`.

Executor sessions receive their allowed MCP tools at connect time. They do not
receive hidden runtime-context prompt tags.

---

## 6. Carrier Completion Channel

`[carrier:result]` notifications are a separate `<system-reminder
source="carrier-completion">` channel. They are produced from carrier job stream
events and forwarded by the host so the Admiral can retrieve the archived result
when needed.

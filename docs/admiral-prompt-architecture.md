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

`createSystemPromptBuilder(...).build(enableMetaphor)` in
`packages/fleet-admiral/src/prompts.ts` assembles the Admiral prompt. The static
prompt includes:

- `<fleet section="preamble">` — always injected first
- `<fleet section="persona">` — injected before role only when metaphor is enabled
- `<fleet section="role">` — always injected
- `<fleet section="tone">` — injected after role only when metaphor is enabled
- `<fleet section="roster">` when carriers are registered, rendered at the
  routing tier only (selection metadata — summary, `Use for`, `NOT for`); each
  carrier's request-block contract, the shared `<prior_jobs>` hint, and the
  dispatch composition rules (parallel sequencing, failure handling) live in
  the on-demand `carrier-operations` skill, and the roster preamble points to it
- `<fleet section="protocol-gate">` containing the always-on intent gate, mode gate, standard fallback, and downward guard for irreversible, structural, multi-module, or doctrine/prompt-policy work
- `<fleet section="standing-orders" type="<id>">` as six separate always-on Standing Order blocks, with Command Integrity injected first as the order-reception contract upstream of Mission Anchor

`enableMetaphor` controls role-playing as one coherent option: enabling it adds
both the naval Persona and Tone overlays; disabling it adds neither. The
always-on role, protocol gate, Standing Orders, protocol skills, and carrier
routing metadata use neutral actor terms so the disabled path does not retain
naval ranks or forms of address. `Fleet`, `Carrier`, and registered carrier names
remain functional product identifiers in both modes.

When enabled, the Persona carries an explicit semantic role map: `user` →
Admiral of the Navy, `host agent`/`you` → Admiral, and `Carrier` → Captain. The
map controls interpretation and conversational wording only; it never rewrites
functional identifiers such as tool names, `carrier_id` values, skill IDs, XML
tags, commands, code symbols, or file paths.

The preamble describes only the rendered `<fleet section="...">` blocks and
optional `type` narrowing. It does not describe per-tool block narrowing. Output
skeletons and report templates follow the session's working language, while
functional identifiers such as skill IDs and report-token keys remain fixed.

The full protocol workflows are not inlined into the static Admiral prompt.
Operational requests load exactly one built-in protocol skill on demand:
`protocol-baseline`, `protocol-midline`,
`protocol-redline`, or `protocol-frontline`. The per-carrier request-block
contracts and dispatch composition rules are likewise on-demand via the
`carrier-operations` skill. Skill
loading is idempotent per session: content already in context is applied
without reloading. `packages/fleet-admiral` owns those packaged skill assets and Fleet plugin/persona/marketplace rendering; `fleet-cli` and `fleet-console` consume them through the public root package API. `fleet-admiral` owns the prompt gate and Standing Order policy. There is still no protocol
registry, persisted mode setting, runtime switching API, or Fleet CLI protocol
selector UI.

Each protocol skill owns its checkpoint declaration. Baseline mode declares no
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
checks, mutating finalized jobs run the Artifact Inspection Gate, speculation
routes to Deep Dive, and contradictions with verified facts route back to
Context Confidence.

Command Integrity completes the integrity pipeline upstream: order reception
(Command Integrity) → evidence sufficiency (Context Confidence) → outcome
verification (Result Integrity). It owns professional pushback on technically
flawed orders, scope discipline against implicit permissions, priority
arbitration on conflicting directives, and the pre-engagement clarification
trigger that routes decision-shaped requirements ambiguity to
`assumption-audit` before a protocol mode loads. `assumption-audit` therefore
has three callers: the active protocol, Standing Order re-entry, and the
Command Integrity pre-engagement trigger.

---

## 3. Live State Access

Runtime state is read through direct owners:

- Protocol gate and Standing Order policy: `packages/fleet-admiral/src/protocols/**`
- Built-in protocol skill assets: committed source at `packages/fleet-admiral/assets/skills/{protocol-baseline,protocol-midline,protocol-redline,protocol-frontline,assumption-audit,carrier-operations}/SKILL.md`, generated into the embedded ESM manifest `EMBEDDED_AGENT_CLI_SKILL_ASSETS` in `packages/fleet-admiral/src/agent-cli/assets.generated.ts` via `scripts/generate-fleet-admiral-assets.mjs`. The `carrier-operations` contracts section mirrors the registry's contracts-tier roster render and is locked by a sync test in `packages/fleet-admiral/tests/carrier-operations-skill.test.ts`
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

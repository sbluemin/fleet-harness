---
maintainer: admiral-only
edit_policy: |
  DO NOT MODIFY THROUGH A DELEGATED RUN.
  This document is the Admiral persona's self-model — its operational reference
  for how delegation policy and live Fleet state flow through Fleet Console's
  terminal launcher, fleet-admiral, and core-infra. Updates must originate from the Admiral
  directly, in response to verified code changes in that policy or in runtime
  lifecycle machinery.
---

# Admiral Policy & Runtime Architecture

> This document is owned by the Admiral persona only. Updates must come only
> from the Admiral, in response to verified changes in delegation policy, runtime
> lifecycle machinery, or the hook that enforces that policy.

---

## 1. Purpose

This document is the operational reference for the Admiral's delegation-policy
surface and runtime lifecycle model. **Fleet no longer assembles a system prompt.**
There is no per-turn runtime-context tag prefix, no `<fleet>` block, and no Fleet
skill asset; a gateway session runs on Claude Code's own prompt plus the project's
own instruction files. What Fleet still owns is the delegation policy, and it is
enforced as code — see §2. Live state is consumed through public leaf package APIs
and package-local policy modules.

This document is for the Admiral. It is not a public spec and not a contributor
guide. Post-verification documentation and Fleet Wiki mutation are performed
directly by the Admiral through the `wiki-operations` skill; they are not
delegated.

---

## 2. Delegation Policy Surface

Fleet writes no system prompt of its own. `--append-system-prompt-file` is absent from
every launch path, and the terminal prompt mode setting that once chose between Fleet
prompt compositions is gone from the settings store, the routes, and the UI.

One switch remains in its place, and it governs Claude Code's own prompt rather than
Fleet's: `claudeCodeSystemPrompt` (`on` | `off`) in the global options store, absent
meaning `on`. `off` passes `--system-prompt ""`, so the child's system block is
empty instead of Claude Code's — measured on 2.1.235 as 26,036 to 19,546 total input
tokens per turn. Nothing is written to disk: the file form that once carried the Fleet
prompt existed because that prompt was long, and an empty prompt has no body to move. The same option reaches Chat Mode as the SDK's
`{ mode: "preset" }` when `on`, and as an omitted `systemPrompt` when `off`; measured on
SDK 0.3.212 as 24,632 against 18,272. Both launch surfaces — the Console terminal plugin
and the standalone `fleet` launcher — read that one option, and it binds new sessions only.

The policy that used to live in the Standing Orders now lives in one embedded hook,
`packages/fleet-admiral/assets/hooks/fleet-gateway-model-guard.mjs`, rendered into the
Fleet plugin at `hooks/fleet-gateway-model-guard.mjs`. It keeps no state of its own: a
file the hook wrote itself would carry freshness, cleanup, and contention, and a gate that
opens when its own bookkeeping goes missing is not a gate. What it needs to remember about
the session it reads from the transcript the harness already writes, addressed by the
`transcript_path` the payload carries. One script serves three roles, selected by its
first argument:

| Subcommand | Event | Matcher | Effect |
|---|---|---|---|
| `remind` | UserPromptSubmit | — | Injects the pin contract every turn. This is the only path by which the contract reaches the model. |
| `gate-delegation` | PreToolUse | `Agent|Workflow` | Blocks a fan-out from a session that has not read the roster, an unpinned `Agent` delegation, and a `Workflow` stage whose model value is misspelled. |
| `workflow-receipt` | PostToolUse | `Workflow` | States that the dispatch returned a receipt, not a result. |

Before either judgment, `gate-delegation` asks whether this session ever received a
roster, by scanning the session transcript for a `tool_use` block naming `gateway_models`
and then for the `tool_result` answering that call id. The spelling of a pin is visible in
the payload; whether the name it spells still resolves is only in the roster. The answer
is what counts, not the call: a lookup the gateway never answered and one issued in the
same turn as the delegation both leave the session without a roster, and the harness
records even parallel calls on separate lines, so a `tool_use` still awaiting its result
is an ordinary intermediate state rather than an exotic one. A result carrying
`is_error` is a failure; success is written as that field being absent, and one answered
call is enough. A gate that reads spelling alone passes a name carried in
from memory or from another session, and what remains is the appearance of compliance.
The scan ignores a lookup made inside a subagent — the host is what decides the
delegation — and it ignores the string `gateway_models` wherever it appears outside a
call, which is every turn: the contract injected by `remind` contains it, and so does the
tool listing. A fan-out onto a built-in agent type needs no lookup, because nothing on
that path is drawn from the roster. When the transcript cannot be read at all the gate
stays open: a harness path that stops carrying `transcript_path` would otherwise block
every delegation, which is a worse failure than missing one lookup.

`gate-delegation` blocks an `Agent` call whose `subagent_type` is `general-purpose` or
`claude`, or absent. Built-in specialist types and `fork` pass — `fork` inherits parent
context by design, so moving it to another model removes the point of that surface.

Past that lookup, for `Workflow` the gate judges spelling only. A stage that names no model is allowed and
runs on the session model; whether a fan-out is worth spreading across providers is a
reading of the work, not a property the hook can see, and a gate that demanded a pin per
stage only taught the host to fill every stage with one value — the spread it was meant to
produce, spelled as compliance. What survives is the failure a host cannot recover from:
a `model` value that is neither a lineage alias nor a `claude-gateway--` modelId kills
every branch at dispatch, so it is refused before the run rather than after. `agentType`
is a stage's other legitimate pin and is refused only when it carries that same modelId —
the two spellings swapped the other way, which no registry resolves. A built-in type such
as `general-purpose` passes, so the check names the modelId rather than demanding a
`fleet:` prefix.

Two properties of the harness make this shape necessary, both measured on
Claude Code 2.1.235:

- The `Agent` tool's `model` parameter is a closed zod enum (`sonnet|opus|haiku|fable`),
  enforced client-side. A gateway model id is rejected before the tool runs, and a
  `PreToolUse` hook cannot smuggle one in either — `updatedInput` is re-validated against
  the same enum. Only an agent definition's `model` frontmatter reaches a gateway model
  on this surface, which is why the roster of identities still exists.
- The agent registry is fixed at session start. A definition added mid-session is not
  found, and an edit to an existing definition's `model` does not take effect. A hook
  therefore cannot repoint one shared identity at different models; it can only choose
  among identities already registered.

Identity descriptions are one label line (`xai/grok-4.6 @low`). Everything a choice needs
— capability class, benchmark figures, effort ladder, provider allowance, the
`agentTypes` name map — is reported by `gateway_models` at call time, so repeating it
once per identity would put the same table in the session window twenty times over.

## 3. Live State Access

Runtime state is read through direct owners:

- Delegation policy: `packages/fleet-admiral/assets/hooks/fleet-gateway-model-guard.mjs`, generated into the embedded ESM manifest `EMBEDDED_AGENT_CLI_HOOK_ASSETS` in `packages/fleet-admiral/src/agent-cli/assets.generated.ts` via `scripts/generate-fleet-admiral-assets.mjs`, and wired by `src/agent-cli/plugin/fleet.ts`.
- Skill assets: none. The plugin renders no `skills/` directory, and `MARKETPLACE_PRUNE_ENTRIES` removes the one an earlier install left behind.
- Tool-facing facts: `gateway_models` in `src/ai-gateway/gateway-models-tool.ts`. Only its `description` reaches the model — `core-agent`'s `specToMcpTool` serves that field alone, so `whenToUse`/`usageGuidelines` are kept empty rather than filled with rules nothing reads.
- Executor/session/model state: `@dotobokuri/core-agent`
- MCP registry/server state: `@dotobokuri/core-agent`

These values are operational inputs for services, overlays, tools, and status
rendering. MCP registry/server state stays live for tool exposure, but no longer
serializes per-tool doctrine into the Admiral system prompt. These values are
not serialized into a per-turn prompt wrapper.

---

## 4. Lifecycle Boot

Each launch path boots its own Admiral runtime.

The Console-owned `fleet` launcher
(`runtime/fleet-console/cli/runtime/runtime.ts`, `createFleetCliRuntime()`)
composes the thin gateway process directly:

- creates infrastructure services
- opens the AI Gateway settings store and the in-process quota service
- registers Fleet Wiki agent tools and the `gateway_models` tool
- starts the in-process Fleet MCP runtime
  (`createFleetGatewayAgentRuntimeLifecycle`, fleet-admiral)
- applies the stored gateway wire-log switch

Its `cleanup()` releases the dedicated MCP session, stops the MCP server, and
resets the wire-log target. Fleet Console's terminal plugin boots the same
`createFleetGatewayAgentRuntimeLifecycle`, so both launch paths share one runtime
shape inside the Fleet Console host package.

---

## 5. Executor Path

Executor sessions receive their allowed MCP tools at connect time. They do not
receive hidden runtime-context prompt tags.

---

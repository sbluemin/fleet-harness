---
maintainer: admiral-only
edit_policy: |
  DO NOT MODIFY THROUGH A DELEGATED RUN.
  This document is the Admiral persona's self-model — its operational reference
  for how delegation policy and live Fleet state flow through Fleet Console's
  terminal launcher and agent runtime. Updates must originate from the Admiral
  directly, in response to verified code changes in that policy or in runtime
  lifecycle machinery.
---

# Admiral Policy & Runtime Architecture

> This document is owned by the Admiral persona only. Updates must come only
> from the Admiral, in response to verified changes in delegation policy, runtime
> lifecycle machinery, or the mod that carries it.

---

## 1. Purpose

This document is the operational reference for how a delegated run reaches a
model and how the runtime lifecycle boots. Fleet appends no text to host system
prompts, distributes no delegation skills, serves no routing MCP resources, and
injects no per-turn runtime-context tags. Seat assignment is code: the routing
mod of section 2.1 asks Console per dispatch and Console answers. Live state is
consumed through public leaf package APIs and package-local policy modules.

This document is for the Admiral. It is not a public spec and not a contributor
guide. Post-verification documentation and Fleet Wiki mutation remain host-owned
operations; they are not delegated.

---

## 2. Delegation Policy Surface

Fleet contributes no host-routing prompt. The `<fleet_gateway_routing>` system-prompt
append, the `fleet://ai-gateway/*` resources (routing guides and the models roster
alike), the `fleet-ai-gateway` MCP server, the `assets/ai-gateway/` prose, and the
`gateway_models` tool are all retired. Their purpose was to persuade a host to choose
gateway models; assignment is now decided in code per dispatch (section 2.1), so a
served copy of that doctrine would only publish stale claims at runtime.

`claudeCodeSystemPrompt` (`on` | `append` | `off`, default `on`) controls the harness's
own prompt, and `claudeCodeCustomSystemPrompt` carries the user's own instructions:
`append` puts them after the harness prompt, `off` makes them the whole system prompt,
and an empty body leaves `off` running without one. Fleet still writes no text of its
own under any setting — carrying a body the user authored is a different thing from
authoring one, and nothing on this path may add to, summarize, or reword it.

The two surfaces express the same setting inversely, so they are mapped in one place
(`agent-cli/session.ts` and `agent-cli/builders/claude.ts`) rather than by each host.
The CLI omits every flag when the harness prompt is used, while the SDK must say
`{ mode: "preset" }` there — omitting `systemPrompt` on that surface yields a minimal
prompt, not the harness one. The SDK also rejects an empty `replace`/`append` body, so
the "no system prompt" state that the CLI writes as `--system-prompt ""` is an omission
on the SDK side. A user body never travels through argv: it is written to a file and
passed as `--append-system-prompt-file` / `--system-prompt-file`, which keeps it clear
of the Windows command-line budget and of `cmd`'s reinterpretation.

The one prompt Fleet still ships is the execution contract in
`runtime/fleet-console/foundation/agent-runtime/src/fleet/agent-cli/execution-contract.ts`.
It is Fleet execution policy rather than a product feature, which is why it lives in
foundation; plugin render substitutes it into the mod source, and the mod's single
registered identity carries it. Assigned children must not redelegate without explicit
authorization — that instruction lives in the contract, not in a host prompt. Tool
contracts, permissions, workflow opt-in, and host integration ownership are unchanged.

The SessionStart version stamp carries no script. `hooks/hooks.json` holds the response
itself: an exec-form command hook that writes the rendered
`{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Fleet plugin version: <version>"}}`
straight to stdout, with the payload passed as an argument rather than embedded in the
evaluated code. The PostToolUse `Workflow` receipt hook and the model-guard asset that
served it were retired together.

## 2.1 Routing Mod

`runtime/fleet-console/foundation/agent-runtime/assets/hooks/fleet-routing-mod.tsx` is a
Claude Code function-hooks module (a "mod"), rendered into the Fleet plugin at
`hooks/fleet-routing-mod.tsx` and named by `hooks/hooks.json`'s `modules`. It is a different
surface from the command hooks beside it: it runs inside the session, hooks events, and draws.
`prepareAiGatewayLaunchProfile` sets `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` for gateway launches,
preserving an operator's own value; a restricted session or a locked `hooks` surface still
refuses it. Gateway routing exists only where the mod loads, so that gate is an availability
boundary for delegation itself.

**Identity.** At `session.start` the mod registers exactly one identity, `fleet:execute`,
whose prompt is the execution contract the render substituted in. There is no roster: the
plugin ships no `agents/*.md` and registers nothing per model or effort rung. Baking the
contract into the snapshot is safe because it is constant per Fleet version — exposure,
quota, and settings change mid-session, and a snapshot published by content hash would force
a new tree, and a hook reload in every open session, on every such change. Naming the identity
is never required, and naming it never disables assignment.

**Assignment.** Console decides which model and effort a delegated run gets.
`POST {FLEET_MOD_BASE_URL}/v1/fleet/routing/assign`, authorized by the `x-fleet-mod-token`
header against `modHookToken` — a credential distinct from the compact hook's, so revoking
one does not cut the other — is the only assignment path; the launch passes the pair as
`FLEET_MOD_BASE_URL` / `FLEET_MOD_TOKEN`. The mod sends facts and applies the answer; it
holds no policy, because it lives in a content-hashed shared tree that tests cannot reach and
that republishes to every open session when edited. Tier reading, skip rules, candidate
choice, provider spread, and the human-readable label belong to
`runtime/fleet-console/features/ai-gateway/runtime/src/fleet/routing-assignment.ts` with
`routing-table.ts` and `routing-allowance.ts`. A missing credential or a failed call rewrites
nothing and leaves the session observing only.

`agent.spawn` rewrites the spawn record's `model` directly, so the `Agent` tool's closed
`model` enum (`sonnet|opus|haiku|fable`, re-validated against `updatedInput`) no longer
constrains the destination and the host never has to name a seat. Effort has no spawn field;
`turn.step` applies it. Registering one identity per model, the earlier design, also fixed the
roster at session start, so enabling a model did not take effect until relaunch.

**Engine facts the mod is built around.** Each was measured against the running
harness, and each one dictates a shape that reads as arbitrary without it. A `turn.step`
hook must be an async generator; registered as a plain function the whole module fails to
load. A model carried by `agent.spawn` lasts the run, but one applied in `turn.step` does
not — the engine re-resolves every step to the session model (four steps all showed the
parent in `saw=`, with only `usage.model` rewritten), which is why the mod pins its
decision per `agentId` and re-applies it each step rather than deciding again. An identity
hidden with `agent.offer` drops out of the dispatchable set and its spawn is refused
(observed immediately after `subagentType rewritten by a hook`), so the one identity is
registered visibly. And the pane the ledger draws is placed by the engine at its own
thresholds — an unrequested open needs 144 columns, one the user asked for needs 110, and
the judgement is remade on every open, so the mod re-opens against `isPlaced` instead of a
module flag. The status row is prefixed by the engine with the plugin's own name, so the
text the mod hands it carries none.

**The ledger.** The mod records what was dispatched and what carried it, because otherwise the
only way to ask whether a run inherited the session model is to ask the model. `agent.spawn`
records each Agent-tool dispatch and `$.ui.notice` puts that under the dispatch's own row. A
dynamic Workflow's stages do not raise `agent.spawn`: they run as the built-in
`workflow-subagent` type, and a measured two-stage run shows zero `agent.spawn` events. A
streaming `turn.step` hook (an async generator; the event takes no other form) sees every loop
carrying an `agentId`, stages included, and records the ones the Agent tool never announced,
closed by `turn.complete` whose `usage.model` settles which model answered. The `Fleet Routing`
pane (`/fleet-routing`) carries the ledger, counting routed, inherited, and
not-from-the-Agent-tool runs separately — inherited rather than "avoided the session model",
because a session already on a gateway model can be assigned that same model. Diagnosis goes to `$.ui.log(..., { to: "debug" })`,
never the transcript.

There is no PreToolUse dispatch gate, and none is needed: a dispatch no longer depends on the
host spelling a pin correctly. The retired `gate-delegation` hook could judge only a pin's
spelling, and its pseudo-parser repeatedly blocked valid scripts. Retired subcommands
(`remind`, `gate-delegation`) still exit zero without judging, because a live session keeps the
plugin copy it fetched at start (`--plugin-url`), so its `hooks.json` may still name them while the
hook commands reach an upgraded Console entry.

## 3. Live State Access

Runtime state is read through direct owners:

- Rendered hook assets: `runtime/fleet-console/foundation/agent-runtime/assets/hooks/`, generated into the embedded ESM manifest `EMBEDDED_AGENT_CLI_HOOK_ASSETS` in `runtime/fleet-console/foundation/agent-runtime/src/fleet/agent-cli/assets.generated.ts` via `scripts/generate-fleet-admiral-assets.mjs`, and wired by `src/agent-cli/plugin/fleet.ts`. The version stamp needs no asset — `src/agent-cli/plugin/fleet.ts` writes its response into `hooks/hooks.json`.
- Routing inputs: the assignment route reads exposure, effort exposure, provider priority, and the quota allowance at call time (`runtime/fleet-console/features/ai-gateway/host/start.ts`), never from a session-start snapshot, so enabling or disabling a model takes effect from the next dispatch.
- Executor/session/model state: `@fleet-console/agent-runtime`
- MCP registry/server state: `@fleet-console/agent-runtime`

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
- renders the shared Agent CLI plugin tree
- starts the in-process Fleet MCP runtime (`createFleetGatewayAgentRuntimeLifecycle`)
- applies the stored gateway wire-log switch

Its `cleanup()` stops the runtime, disposes the MCP HTTP transport, and resets
the wire-log target. Fleet Console's terminal plugin boots the same
`createFleetGatewayAgentRuntimeLifecycle`, so both launch paths share one runtime
shape inside the Fleet Console host package.

---

## 5. Executor Path

Executor sessions receive their allowed MCP tools at connect time. They do not
receive hidden runtime-context prompt tags.

---

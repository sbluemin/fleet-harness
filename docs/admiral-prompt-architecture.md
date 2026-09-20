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
surface and runtime lifecycle model. Fleet appends one concise
`<fleet_gateway_routing>` entrypoint to host sessions; detailed policy and live
model state remain on-demand MCP resources. Fleet does not distribute delegation
skills or inject per-turn runtime-context tags. That entrypoint is behavioral
guidance. Seat assignment itself is code: the routing mod described in section
2.1 decides it per dispatch, and the entrypoint remains the only routing surface
wherever that mod cannot load. Live state is consumed through public leaf
package APIs and package-local policy modules.

This document is for the Admiral. It is not a public spec and not a contributor
guide. Post-verification documentation and Fleet Wiki mutation remain host-owned
operations; they are not delegated.

---

## 2. Delegation Policy Surface

Fleet contributes a single English host-routing entrypoint from
`runtime/fleet-console/foundation/agent-runtime/src/fleet/ai-gateway/host-prompt.ts`. POSIX CLI launches pass
`--append-system-prompt`; Windows launches use `--append-system-prompt-file`
with a private temporary file, shim-safe path validation, and launch-owned cleanup.

`claudeCodeSystemPrompt` (`on` | `off`, default `on`) controls the harness prompt,
not the Fleet entrypoint. CLI `off` supplies `--system-prompt ""` while retaining
the append. SDK `on` uses `{ mode: "append", text }`; SDK `off` uses
`{ mode: "replace", text }`. Both preserve the same Fleet text. Historical token
measurements made without this entrypoint are not measurements of this composition.

The entrypoint directs coordinating hosts to read `fleet://ai-gateway/routing`
and relevant guides before finalizing Agent or dynamic Workflow assignments,
and to obtain a fresh `fleet://ai-gateway/models` snapshot per dispatch batch.
Static guidance may be reused while present in context. Assigned children must
not redelegate without explicit authorization. Tool contracts, permissions,
workflow opt-in, and host integration ownership remain unchanged.

`fleet-ai-gateway` server instructions describe resource discovery and credential
handling rather than duplicating the host behavioral policy. English policy
resources under `assets/ai-gateway/` own loadout interpretation, role and effort
selection, execution surfaces, and task-specific guides. The models resource
owns live roster spellings, constraints, and execution availability. There is
no `gateway_models` tool or `fleet:delegation` skill.

The SessionStart version stamp carries no script. `hooks/hooks.json` holds the response
itself: an exec-form command hook that writes the rendered
`{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Fleet plugin version: <version>"}}`
straight to stdout, with the payload passed as an argument rather than embedded in the
evaluated code. The PostToolUse `Workflow` receipt hook was retired along with the
`fleet-gateway-model-guard.mjs` asset that served both.

## 2.1 Routing Mod

`runtime/fleet-console/foundation/agent-runtime/assets/hooks/fleet-routing-mod.tsx` is a
Claude Code function-hooks module (a "mod"), rendered into the Fleet plugin at
`hooks/fleet-routing-mod.tsx` and named by `hooks/hooks.json`'s `modules`. It is a different
surface from the command hooks beside it: it runs inside the session, hooks events, and draws.
`prepareAiGatewayLaunchProfile` sets `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` for gateway launches,
preserving an operator's own value; the surface is otherwise off by default and rollout-gated,
and a restricted session or a locked `hooks` surface still refuses it. Gateway identities exist
only where it loads, so that gate is now an availability boundary for delegation itself.

**Identities.** At `session.start` the mod asks the host which gateway models are exposed and
registers one identity per model and effort rung through `$.agent.register`, which carries both
`model` and `effort`. The plugin no longer ships `agents/*.md`. The snapshot is a shared tree
published by content hash, so a roster baked into it would force a new tree on every model the
user enables; keeping the snapshot static and asking at session start breaks that coupling, and
the shared execution prompt travels once instead of once per identity. `GET /v1/fleet/agents`
on the gateway route serves the specs from `resolveAiGatewaySelection` read at call time, gated
on `modHookToken` — a credential distinct from the compact hook's, so revoking one does not cut
the other — and reaches the session as `FLEET_MOD_BASE_URL` / `FLEET_MOD_TOKEN`. A missing
credential or a failed read registers nothing and leaves the session on Claude Code's built-in
models. `gatewayAgents` still carries the registered names, which the loadout's `execution`
block answers reachability with.

**The ledger.** The mod does not choose models. Which model runs a delegated task is the host's
decision, made from the roster under the appended prompt's guidance; the mod records what that
decision was, because otherwise the only way to ask whether a run inherited the session model is
to ask the model. `agent.spawn` records each Agent-tool dispatch — what was named, what carried
it — and `$.ui.notice` puts that under the dispatch's own row. A dynamic Workflow's stages do
not raise `agent.spawn`: they run as the built-in `workflow-subagent` type, and a measured run
shows zero `agent.spawn` events beside four `turn.complete` ones. A streaming `turn.step` hook
(an async generator; the event takes no other form) sees every loop carrying an `agentId`,
stages included, and records the ones the Agent tool never announced, closed by `turn.complete`
whose `usage.model` settles which model answered. Recording is not gated on the
`claude-gateway--` prefix: that spelling decides how a label is drawn, and gating on it would
drop a run whenever an id is spelled otherwise. The `Fleet Routing` pane (`/fleet-routing`)
carries the ledger, counting named, inherited, and not-from-the-Agent-tool runs separately.
Diagnosis goes to `$.ui.log(..., { to: "debug" })`, never the transcript.

There is no PreToolUse dispatch gate. The retired `gate-delegation` hook could judge only
a pin's spelling — whether a name resolves was always the dispatcher's judgment — and its
pseudo-parser repeatedly blocked valid scripts: a `response_model:` configuration key read
as a stage pin, a human-readable `meta.phases` label blamed for a healthy stage, a
whitespace-before-colon spelling skipping validation. What retired it was the live
Workflow contract itself: `agent()` accepts an `agentType` pin resolved from the same
registry as the Agent tool, and documents omitting `model` — inheriting the session model
— as the normal default, so "every stage must pin a model" had become a doctrine the
runtime's own grammar contradicts. Per-dispatch identity choice is now the routing
resource's semantic policy: an unnamed dispatch inherits the session model, deliberately or
not, and making that choice conscious is the host entrypoint and routing policy's job, not a spelling gate's.
Retired subcommands (`remind`, `gate-delegation`) still exit zero without judging, because
the shared plugin tree is replaced in place and a live session executes the new script
from its next event while its loaded `hooks.json` may still name them.

No hook is attached before or after the delegation skill, and none may be. Claude Code
evaluates a hook's `if` as a permission rule and matches its rule content through the
tool's `preparePermissionMatcher`, which the Skill tool does not implement, so an
`if: "Skill(<name>)"` condition is always false and the hook is skipped with only a
verbose log. An earlier design injected the roster from a `PostToolUse` MCP hook gated
that way and recorded a prompt-scoped receipt the dispatch gate validated against; it
never fired once, no receipt was ever written, and the gate refused every gateway pin
while the pin contract itself never reached the host. The roster now reaches the host
through the host routing entrypoint and explicit MCP resource reads.

Two properties of the harness keep the identity roster necessary, both measured on
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
`agentTypes` name map — is reported by `fleet://ai-gateway/models` at read time, so repeating it
once per identity would put the same table in the session window twenty times over.

## 3. Live State Access

Runtime state is read through direct owners:

- Rendered hook assets: `runtime/fleet-console/foundation/agent-runtime/assets/hooks/`, generated into the embedded ESM manifest `EMBEDDED_AGENT_CLI_HOOK_ASSETS` in `runtime/fleet-console/foundation/agent-runtime/src/fleet/agent-cli/assets.generated.ts` via `scripts/generate-fleet-admiral-assets.mjs`, and wired by `src/agent-cli/plugin/fleet.ts`. The version stamp needs no asset — `src/agent-cli/plugin/fleet.ts` writes its response into `hooks/hooks.json`.
- On-demand policy assets: `runtime/fleet-console/features/ai-gateway/runtime/assets/ai-gateway/`, generated into `EMBEDDED_AI_GATEWAY_ASSETS` and served through `buildGatewayPolicyResources`. These resources own detailed routing doctrine; no Fleet skills are rendered.
- Model facts: `runtime/fleet-console/core/host/mcp/gateway-models.ts`, served as `fleet://ai-gateway/models` by `fleet-ai-gateway`. The host reads the live roster directly, with no hook receipt.
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
- connects the host-owned Admiral MCP tools and the resource-only `fleet-ai-gateway` server
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

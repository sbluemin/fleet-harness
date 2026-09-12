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
skills or inject per-turn runtime-context tags. This is behavioral guidance, not
a code-enforced delegation gate. Live state is consumed through public leaf
package APIs and package-local policy modules.

This document is for the Admiral. It is not a public spec and not a contributor
guide. Post-verification documentation and Fleet Wiki mutation remain host-owned
operations; they are not delegated.

---

## 2. Delegation Policy Surface

Fleet contributes a single English host-routing entrypoint from
`packages/fleet-admiral/src/ai-gateway/host-prompt.ts`. POSIX CLI launches pass
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

The command hook at
`packages/fleet-admiral/assets/hooks/fleet-gateway-model-guard.mjs`, rendered into the
Fleet plugin at `hooks/fleet-gateway-model-guard.mjs`, handles Workflow receipts and the
SessionStart version stamp, selected by its first argument:

| Subcommand | Event | Matcher | Effect |
|---|---|---|---|
| `plugin-version` | SessionStart | — | Records the rendered Fleet plugin version in session context. |
| `workflow-receipt` | PostToolUse | `Workflow` | States that the dispatch returned a receipt, not a result. |

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

- Workflow receipt and version stamp: `packages/fleet-admiral/assets/hooks/fleet-gateway-model-guard.mjs`, generated into the embedded ESM manifest `EMBEDDED_AGENT_CLI_HOOK_ASSETS` in `packages/fleet-admiral/src/agent-cli/assets.generated.ts` via `scripts/generate-fleet-admiral-assets.mjs`, and wired by `src/agent-cli/plugin/fleet.ts`.
- On-demand policy assets: `packages/fleet-admiral/assets/ai-gateway/`, generated into `EMBEDDED_AI_GATEWAY_ASSETS` and served through `buildGatewayPolicyResources`. These resources own detailed routing doctrine; no Fleet skills are rendered.
- Model facts: `runtime/fleet-console/core/host/mcp/gateway-models.ts`, served as `fleet://ai-gateway/models` by `fleet-ai-gateway`. The host reads the live roster directly, with no hook receipt.
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

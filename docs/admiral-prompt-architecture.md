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
There is no per-turn runtime-context tag prefix and no `<fleet>` block; a gateway
session runs on Claude Code's own prompt plus the project's own instruction files.
Fleet contributes only compact on-demand plugin skills, never an always-on prompt
layer. What Fleet still owns is the delegation policy, and it is enforced as code —
see §2. Live state is consumed through public leaf package APIs and package-local
policy modules.

This document is for the Admiral. It is not a public spec and not a contributor
guide. Post-verification documentation and Fleet Wiki mutation remain host-owned
operations; they are not delegated.

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

The delegation contract that used to live in the Standing Orders is now split between
one on-demand skill, the live Workflow tool, the `gateway_models` tool, and one embedded
hook. `fleet:delegation` owns semantic execution-graph decisions and per-dispatch
identity choice, and opens with a preflight that requires a `gateway_models` call; the
Workflow tool owns graph mechanics and its own dispatch options; `gateway_models` owns
the identity roster and reports its own spellings and constraints. The host reads that
roster itself.

Routing into the skill is owned by the skill's own `description`: it names the concrete
triggers — calling an agent, using the dynamic Workflow tool, orchestrating parallel or
multi-agent work, delegating work to another model — and instructs loading the skill
before the first `Agent` or `Workflow` call. A per-turn UserPromptSubmit reminder
(`remind`) used to carry that routing, but the sessions that failed to load the skill
were failing on an abstract description, not on a missing injection, so the reminder was
retired instead of kept as standing per-turn context.

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
runtime's own grammar contradicts. Per-dispatch identity choice is now the delegation
skill's semantic policy: an unnamed dispatch inherits the session model, deliberately or
not, and making that choice conscious is the skill's job, not a spelling gate's.
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
through its own attention — the skill description's triggers and the skill preflight.

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
`agentTypes` name map — is reported by `gateway_models` at call time, so repeating it
once per identity would put the same table in the session window twenty times over.

## 3. Live State Access

Runtime state is read through direct owners:

- Workflow receipt and version stamp: `packages/fleet-admiral/assets/hooks/fleet-gateway-model-guard.mjs`, generated into the embedded ESM manifest `EMBEDDED_AGENT_CLI_HOOK_ASSETS` in `packages/fleet-admiral/src/agent-cli/assets.generated.ts` via `scripts/generate-fleet-admiral-assets.mjs`, and wired by `src/agent-cli/plugin/fleet.ts`.
- On-demand skill assets: `packages/fleet-admiral/assets/skills/`, generated into `EMBEDDED_AGENT_CLI_SKILL_ASSETS` by `scripts/generate-fleet-admiral-assets.mjs` and rendered under the gateway plugin's `skills/` directory. `delegation` owns semantic execution-graph decisions and per-dispatch identity choice; the live Workflow tool owns graph mechanics. The skills do not recreate a Fleet system prompt or duplicate hook/runtime policy.
- Tool-facing facts: `gateway_models` in `src/ai-gateway/gateway-models-tool.ts`. It reports the live roster and nothing else; the host calls it directly from the delegation preflight, so there is no hook mode and no receipt. Only `description` is served as tool doctrine, so `whenToUse`/`usageGuidelines` stay empty rather than carrying rules nothing reads.
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

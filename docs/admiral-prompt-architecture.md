---
maintainer: admiral-only
edit_policy: |
  DO NOT MODIFY THROUGH A DELEGATED RUN.
  This document is the Admiral persona's self-model — its operational reference
  for how the system prompt and live Fleet state flow through fleet-cli,
  fleet-admiral, and core-infra. Updates must originate from the Admiral
  directly, in response to verified code changes in prompt assembly or runtime
  lifecycle machinery.
---

# Admiral Prompt & Runtime Architecture

> This document is owned by the Admiral persona only. Updates must come only
> from the Admiral, in response to verified changes in prompt assembly, runtime
> lifecycle machinery, or Admiral prompt policy.

---

## 1. Purpose

This document is the operational reference for the Admiral's prompt assembly and
runtime lifecycle model. The current architecture has no per-turn runtime-context
tag prefix. The Admiral system prompt is assembled inside each host — Fleet
Console's terminal plugin for native/gateway launches, and `fleet-cli`'s
thin launcher for its gateway-doctrine launch — and live state is consumed
through public leaf package APIs and package-local policy modules.

This document is for the Admiral. It is not a public spec and not a contributor
guide. Post-verification documentation and Fleet Wiki mutation are performed
directly by the Admiral through the `wiki-operations` skill; they are not
delegated.

---

## 2. System Prompt Shape

`createSystemPromptBuilder().build()` in
`packages/fleet-admiral/src/prompts/index.ts` assembles the Admiral prompt and
delegates the whole body to `prompts/gateway.ts`. Native doctrine renders no
Admiral system prompt at all, so it never calls the builder.

**Gateway doctrine** static prompt:

- `<fleet section="preamble">` then `<fleet section="role">`
- `<fleet section="standing-orders" type="<id>">` — six blocks, ids
  `command-integrity`, `mission-anchor`, `context-confidence`,
  `orchestration-policy`, `deep-dive`, `result-integrity`
- **No** `protocol-gate`, `roster`, `persona`, or `tone` block. There is no
  metaphor axis on this path.

---

## 3. Live State Access

Runtime state is read through direct owners:

- Standing Order policy: `packages/fleet-admiral/src/protocols/**`. Bodies live in `standing-orders/gateway.ts`; prompt assembly lives in `src/prompts/gateway.ts`.
- Built-in skill assets: base source at `packages/fleet-admiral/assets/skills/wiki-operations/SKILL.md`, plus gateway assets under `packages/fleet-admiral/assets/skills/gateway/<name>/SKILL.md`, generated into the embedded ESM manifest `EMBEDDED_AGENT_CLI_SKILL_ASSETS` in `packages/fleet-admiral/src/agent-cli/assets.generated.ts` via `scripts/generate-fleet-admiral-assets.mjs`. Gateway doctrine render remaps each `gateway/<name>` asset onto the live `skills/<name>` path; native doctrine renders `wiki-operations` only.
- Executor/session/model state: `@dotobokuri/core-agent`
- MCP registry/server state: `@dotobokuri/core-agent`

These values are operational inputs for services, overlays, tools, and status
rendering. MCP registry/server state stays live for tool exposure, but no longer
serializes per-tool doctrine into the Admiral system prompt. These values are
not serialized into a per-turn prompt wrapper.

---

## 4. Lifecycle Boot

Each host boots its own Admiral runtime.

`fleet-cli` (`runtime/fleet-cli/src/runtime/runtime.ts`, `createFleetCliRuntime()`)
composes the thin gateway host directly:

- creates infrastructure services
- opens the AI Gateway settings store and the in-process quota service
- registers Fleet Wiki agent tools and the `gateway_models` tool
- starts the in-process Fleet MCP runtime
  (`createFleetGatewayAgentRuntimeLifecycle`, fleet-admiral)
- applies the stored gateway wire-log switch

Its `cleanup()` releases the dedicated MCP session, stops the MCP server, and
resets the wire-log target. Fleet Console's terminal plugin boots the same
`createFleetGatewayAgentRuntimeLifecycle`, so both hosts share one runtime shape.

---

## 5. Executor Path

Executor sessions receive their allowed MCP tools at connect time. They do not
receive hidden runtime-context prompt tags.

---

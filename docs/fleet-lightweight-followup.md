# Fleet Lightweight Follow-up

## Background
Fleet has completed the logical product split that separates the product core from the Pi host adapter.

- `packages/fleet-core` owns Fleet domain logic, prompts, runtime contracts, MCP/tool/job internals, SSOT streaming event contracts, and public APIs.
- `packages/pi-fleet-extension` owns Pi lifecycle wiring, command/keybind/tool registration, TUI rendering, provider registration/stream glue, non-provider session features, config bridges, adapters, and compatibility seams.
- `packages/unified-agent` remains an independent backend client package used by the Fleet runtime.

This split is the foundation for turning Fleet into a product that can keep running inside Pi while also becoming easier to expose through future hosts such as a standalone CLI.

## Purpose
The lightweight follow-up exists to reduce the amount of product behavior that still has to be understood through the Pi extension package. The goal is not another broad relocation wave. The goal is to make the already-split architecture easier to maintain by hardening the `fleet-core` public surface and making the Pi package thinner, more mechanical, and more replaceable.

## Current State
- **Logical ownership:** Final. `fleet-core` owns Fleet domain logic; `pi-fleet-extension` owns Pi capabilities.
- **Physical layout:** Intermediate. `packages/pi-fleet-extension/src/` still exists, and active capability buckets live under `packages/pi-fleet-extension/src/<bucket>/`.
- **Legacy Pi-side domain folders:** Removed. Do not recreate `src/fleet/`, `src/grand-fleet/`, `src/metaphor/`, `src/core/`, or `src/boot/`. Fleet Wiki Pi code now lives in active bucket-local homes such as `src/tui/fleet-wiki/`, `src/commands/fleet-wiki/`, `src/tools/fleet-wiki/`, and `src/session/fleet-wiki/`.
- **Dependency direction:** `pi-fleet-extension` consumes `fleet-core` through public APIs. `fleet-core` must not import Pi packages.

## Goals
- **Thin Pi adapter:** Keep `pi-fleet-extension` focused on Pi registration, rendering, lifecycle, and bridge code.
- **Thick product core:** Move reusable Fleet behavior, product policy, domain decisions, state machines, prompt assembly, and pure execution contracts toward `fleet-core`.
- **Public API hardening:** Make `packages/fleet-core/api/PUBLIC_API.md` and exported subpaths sufficient for Pi integration without deep imports.
- **Loose coupling:** Replace implicit knowledge of `fleet-core` internals with explicit services and public contracts.
- **Future host readiness:** Leave the architecture in a state where a future `fleet-cli` or other host can reuse the same core without depending on Pi runtime objects.

## Non-Goals
- **Active Pi source layout:** Treat `packages/pi-fleet-extension/src/` as the active Pi capability-bucket home.
- **New end-user features:** This is a structural refinement phase, not a feature expansion phase.
- **Carrier behavior rewrites:** Preserve existing carrier behavior, dispatch semantics, detached-job behavior, and MCP/provider FIFO behavior unless a change is explicitly scoped.
- **Deep import shortcuts:** Do not solve adapter friction by importing `@sbluemin/fleet-core/src/**` or `@sbluemin/fleet-core/internal/**`.

## Target Direction
The target model is **thick core, thin adapter**.

```text
fleet-core
  owns product behavior, domain policy, prompt assets, job logic, public APIs

pi-fleet-extension
  adapts Fleet to Pi through commands, keybinds, tools, TUI, provider glue, session features
```

The Pi extension should increasingly read like host wiring. If a module requires product reasoning to understand why Fleet behaves a certain way, that reasoning probably belongs in `fleet-core`.

## Guardrails
- Keep `fleet-core` Pi-agnostic. No `ExtensionContext`, `ExtensionAPI`, Pi TUI, `pi.register*`, or `pi.sendMessage` imports.
- Keep Pi imports in `pi-fleet-extension`, with `@mariozechner/pi-ai` confined to the compatibility bridge (`src/bindings/compat/pi-ai-bridge.ts`).
- Keep `pi-fleet-extension` imports on public `fleet-core` exports only.
- Preserve slash command names, global compatibility keys, detached-job acceptance/completion-push semantics, and provider FIFO behavior.
- Treat deleted legacy domain folders as deleted. Do not recreate them as shims.
- Keep documentation honest about the current physical state: `packages/pi-fleet-extension/src/` still exists.

## Suggested Work Streams
1. **Adapter thinning audit:** In progress. Agent execution is now orchestrated through the internal `@sbluemin/fleet-core/admiral/agent-runtime` layer; the old public `AgentRequestService`/`agentRequest` surface is legacy and should not be reintroduced.
2. **Public API closure:** Compare every `pi-fleet-extension` integration need against `packages/fleet-core/api/PUBLIC_API.md`; add public contracts before adding adapter workarounds.
3. **Runtime service cleanup:** Keep future non-Pi host behavior on public services and SSOT stream events instead of host port plumbing.
4. **Boundary tests:** Add focused tests that fail on `fleet-core` Pi imports, `pi-fleet-extension` deep imports, and legacy directory reintroduction.
5. **Documentation hygiene:** Keep `docs/pi-development-reference.md`, `docs/admiral-workflow-reference.md`, and package `AGENTS.md` aligned with the current state.

## Worked Example

- Fleet tool specs for carrier sortie, squadron, taskforce, and carrier job lookup now live behind the `fleet-core` public registry surface.
- `pi-fleet-extension/src/tools.ts` acts as a Pi adapter loop: it iterates the core registry and calls `pi.registerTool(...)`.
- Pi-only surfaces such as custom message rendering and modal/request UI remain in the Pi extension.
- `createFleetCoreRuntime` (in `fleet-core`) centralizes the initialization of agent runtime, domain stores, settings singletons, and optional service status; the Pi extension (via `src/boot.ts`) acts as the host that triggers this composition and manages its shutdown lifecycle.
- Foreground carrier requests now flow through internal execution logic in `fleet-core`. Pi consumes SSOT stream events and maps lifecycle events back to panel APIs.
- Carrier completion pushes are assembled in `fleet-core` as `job:finalized.systemReminder`; Pi forwards that payload through `pi.sendMessage`.

> **Instruction maintenance rule — risk-weighted minimalism**
>
> - Except for Fleet Wiki-governed instructions, treat each `AGENTS.md` and linked `CLAUDE.md` as always-loaded routing context, not a handbook. Keep a rule when its pre-work value outweighs recurring context and maintenance cost: normal exploration is unlikely to reveal it in time, violation is costly, and the fact is stable.
> - Prefer directory-level ownership routes and non-obvious ownership, security, or operational invariants. Allow a rare file pointer only for a stable source of truth or authoring/generated boundary that materially prevents misrouting; never add exhaustive inventories or implementation walkthroughs.
> - State each fact once at the nearest scope and retire stale or low-value guidance. Before removing still-required procedures, catalogs, or conventions, move them to reliable automation or on-demand documentation. Validate both the assembled instruction context and representative task outcomes under comparable prompt, tool, and retrieval conditions, and prune before adding.

# Fleet

Fleet is a multi-LLM orchestration kit. An Admiral host coordinates specialized Carrier personas through supported Agent CLI backends.

## Domain map

- **Admiral** — the host agent that plans, delegates, and integrates work.
- **Carrier** — a specialized delegated persona backed by an Agent CLI executor.
- **Theater** — a Fleet Console project root and the boundary for its local context.
- **Operation** — a Console-managed unit inside a Theater.

## Directory index

| Directory | Responsibility |
|---|---|
| `docs/` | Human-facing architecture, development, and operating references |
| `packages/` | Reusable core and Fleet domain packages |
| `runtime/fleet-cli/` | Terminal host and CLI composition root |
| `runtime/fleet-console/` | Standalone Console service and web product |
| `runtime/fleet-desktop/` | Optional thin native shell for Fleet Console |
| `runtime/fleet-plugins/` | Built-in Console plugin implementations |
| `scripts/` | Repository generation, packaging, and boundary gates |
| `.agents/skills/` | On-demand task workflows and verification procedures |
| `.changelog.d/` | Unreleased bilingual changelog fragments |
| `examples/` | Reference plugin integrations |
| `.fleet/knowledge/` | Workspace-local Fleet Wiki data and governance |

## Architecture constraints

- Runtime hosts own composition, process lifecycle, UI, and host adapters. Reusable packages must not reach back into a host.
- `core-*` packages are Fleet-domain-agnostic. Fleet semantics belong in `fleet-*` packages or runtime hosts; dependencies flow from runtime to Fleet domains to core capabilities.
- Fleet CLI and Fleet Console are peer hosts. Console owns its service, browser, and plugin-host lifecycle; built-in plugin implementations live under `runtime/fleet-plugins/`, and Desktop remains a shell over the Console public protocol.
- Cross-package construction uses explicit dependency objects. Do not add DI containers, service locators, or hidden cross-layer lookups.
- Consume declared package exports only. Source deep imports create shadow APIs and are forbidden across package boundaries.

## Repository-wide operational invariants

- Commits use English Conventional Commits.
- Unreleased notes live in `.changelog.d/`; `CHANGELOG.md` and `CHANGELOG.ko.md` are compiler-owned outputs and must not be edited directly.
- Bilingual changelog summaries describe user-visible behavior and preserve literal or protocol tokens across locales; exact fragment organization, syntax, and tags belong to the `.changelog.d/` instructions and changelog compiler.

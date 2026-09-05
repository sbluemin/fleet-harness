# Fleet

Fleet is a multi-LLM orchestration kit spanning Agent CLI backends and gateway models. The **Admiral** is the host agent that plans, delegates, and integrates; a **Theater** is a registered project root and its local context boundary; an **Operation** is a Console-managed unit inside a Theater.

## Select task context

This file defines repository-wide boundaries. Apply child `CLAUDE.md` files along the paths you work in; read other instructions, documents, and skills only when relevant to the task. Do not preload every instruction file or a documentation bundle.

| Owner | Path |
|---|---|
| Reusable core capabilities and Fleet domains | `packages/` |
| `fleet` terminal launcher, Console server and web product | `runtime/fleet-console/` |
| Built-in Console plugins | `runtime/fleet-plugins/` |
| Electron native shell | `runtime/fleet-desktop/` |
| Mobile shell | `runtime/fleet-mobile/` |
| Generation, packaging, and boundary checks | `scripts/` |
| Development references / plugin integration examples | `docs/` / `examples/` |
| Task-specific execution and verification procedures | `.claude/skills/` |
| Unreleased change records | `.changelog.d/` |

- Modify the repository in a dedicated `canary`-based worktree created through the `git-worktree` skill, unless the user explicitly directs otherwise. Read-only work needs no worktree.
- Route Console browser verification to `console-e2e`, Electron shell verification to `desktop-e2e`, and a Console for the user to try to `console-handoff`. Load a skill's body only for its task.
- For local execution, consult **Isolated Development Data** in `docs/fleet-development-reference.md`. Development and verification must not touch real user data or another session's processes.

## Architecture boundaries

- Dependencies flow from runtime hosts to Fleet domains to core capabilities. `core-*` packages remain Fleet-domain-agnostic; reusable packages must not reach back into a runtime host.
- Runtime hosts own composition, process lifecycle, UI, and host adapters. Console is the sole published host for the `fleet` launcher and Console web product. Built-ins live in `runtime/fleet-plugins/`; Desktop remains a shell over the Console public protocol.
- Cross-package construction uses explicit dependency objects. Do not add DI containers, service locators, or hidden cross-layer lookups.
- Consume other packages through declared exports only. Source deep imports must not create shadow APIs.

## Execution scope and completion

- Within the authorized task, continue local edits, relevant checks, repairs of regressions introduced by the change, and re-verification without intermediate approval requests. Do not expand an investigation into implementation or implementation into deployment.
- Destructive actions, external publication or deployment, and billable external actions require authorization for that action. Local verification authority does not extend to production data, other sessions, or external services; never bypass tool permission gates.
- Define completion by the requested outcome and affected boundaries. Start with relevant checks and broaden coverage for shared contracts, dependencies, or packaging changes. Do not require the entire test suite after every edit, and do not skip mandatory skill, CI, or release gates.
- Verify executable-code or bundle changes with affected builds, and UI behavior or visual changes in the real app. For documentation-only changes, check references, instruction conflicts, and preservation of required constraints. Run commands in the active worktree and verify that they exercise the changed version.
- An initial implementation or one green check is not completion. Resolve relevant failures or identify the concrete blocker; report changes, checks run, failures, and unverified areas separately. Do not expand scope to repair unrelated pre-existing failures.

## Change records

- Commits use English Conventional Commits.
- `CHANGELOG.md` and `CHANGELOG.ko.md` are compiler-owned outputs; never edit them directly.
- Author a `.changelog.d/` fragment autonomously only for a product change users perceive as a feature-level delta. Omit otherwise, without a mandatory `no-changelog` declaration. That directory's instructions and the compiler own inclusion details, identity, and bilingual syntax.

## Instruction maintenance

- Keep all `CLAUDE.md` files in English. Retain stable ownership, security, and operational boundaries that must be known before work begins; do not accumulate implementation walkthroughs, one-off lessons, or inventories discoverable through normal exploration.
- State each fact once at the nearest scope. Put procedures in task-specific skills, detailed rationale in on-demand references, and mechanically decidable constraints in checks. Never delete a still-required constraint without a reliable replacement.
- When revising instructions or skills, consult `docs/instruction-maintenance.md`. Do not relax safety boundaries based on presumed model capability. Fleet Wiki-governed instructions retain their own approval and generation contracts.

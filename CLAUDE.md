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

## Test admission policy

The permanent suite is a **minimal product-acceptance suite**, not a catalog of modules, implementation details, or every past regression. Default to **no new test** unless it passes the admission criteria below. A code change or bug fix alone does not justify another permanent case.

- **Admit only essential contracts:** representative product execution; process, session, and stream lifecycle; authorization, containment, and sensitive-data boundaries; storage integrity and destructive-action safeguards; or explicitly required architecture, packaging, and release gates. A valid assertion, a unique regression, or a useful pure function is not sufficient by itself.
- **Require a concrete gap before adding:** identify the supported path, the consequential failure it must catch, and why the existing suite does not already catch it. Extend or replace the existing representative test first. Do not create one test file per source file, helper, adapter, or store.
- **Test each contract at one effective boundary:** prefer a representative public-API or integration path over duplicate tests at every layer. A focused unit test is appropriate when it is the smallest reliable way to exercise an essential independent defense. Do not claim an upper-layer test covers a lower layer unless it actually exercises that behavior.
- **Keep representative cases, not permutation matrices:** retain the main success path and failures caused by distinct consequential mechanisms. Add an input variant only when it exercises a different essential defense or failure mechanism; superficial format, platform, provider, or parameter differences do not earn separate cases. Parameterization, snapshots, and file consolidation must not disguise redundant coverage.
- **Do not add permanent tests for incidental behavior:** copy, translations, icons, fonts, CSS values, layout geometry, preference variants, UI micro-interactions, internal names, or call-order wiring. Do not pin production source with string/regex assertions, duplicate production algorithms in tests, or test mocks and library behavior instead of Fleet behavior. Explicitly required static gates are the exception, not a precedent for new source snapshots; essential UI safeguards must be tested through behavior.
- **Prefer removal or replacement to accumulation:** when changing a contract, retire superseded or redundant cases in that scope. Do not restore removed detail coverage merely because a reviewer requests more tests. Judge feedback against this admission policy; never remove, skip, or weaken a necessary failing test just to obtain green checks.
- **Minimize maintenance, not a numeric score:** neither test counts nor coverage percentages are targets. This policy does not authorize unrelated mass deletion or relaxation of security and data-integrity requirements. Preserve explicitly mandated gates and the execution/real-app verification obligations above; temporary verification evidence does not automatically belong in the permanent suite.

## Change records

- Commits use English Conventional Commits.
- `CHANGELOG.md` and `CHANGELOG.ko.md` are compiler-owned outputs; never edit them directly.
- Author a `.changelog.d/` fragment autonomously only for a product change users perceive as a feature-level delta. Omit otherwise, without a mandatory `no-changelog` declaration. That directory's instructions and the compiler own inclusion details, identity, and bilingual syntax.

## Instruction maintenance

- Keep all `CLAUDE.md` files in English. Retain stable ownership, security, and operational boundaries that must be known before work begins; do not accumulate implementation walkthroughs, one-off lessons, or inventories discoverable through normal exploration.
- State each fact once at the nearest scope. Put procedures in task-specific skills, detailed rationale in on-demand references, and mechanically decidable constraints in checks. Never delete a still-required constraint without a reliable replacement.
- When revising instructions or skills, consult `docs/instruction-maintenance.md`. Do not relax safety boundaries based on presumed model capability. Fleet Wiki-governed instructions retain their own approval and generation contracts.

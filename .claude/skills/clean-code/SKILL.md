---
name: clean-code
description: Diagnose excessive file splitting, proxies, and duplicate logic in a named package, then perform approved structural consolidation and deduplication. Not for general bug fixes, feature development, or cosmetic formatting.
---

# Clean Code

Simplify structure around domain boundaries while preserving behavior and public APIs. File/line reductions are supporting evidence, not the objective.

## Inputs and approval scope

`<target_path>` is required; resolve it from the request. Confirm optional `<public_surface>` through declared package exports/barrels and actual external consumers. A diagnosis-only request ends at the report.

Present structural consolidation and functional deduplication diagnoses separately; implement only the approved scope. Do not ask again for an already-approved exact transformation. Return new API or behavioral trade-offs to the user.

## 1. Structural diagnosis and consolidation

Inventory target files/sizes and trace real dependencies and external consumers. Read merge candidates and affected consumers rather than requiring a ceremonial read of unrelated packages.

These are **candidate signals**, not automatic deletion rules:

- Multiple tiny single-function/type files in one domain, duplicated types, simple re-export chains.
- Factory-to-singleton-to-forwarding-proxy layers unused by runtime callers.
- Module-level mutable state bypassing test isolation or explicit dependencies.

Present a domain-based before/after map, preserved exports, affected consumers, and checks. Files under roughly 50 lines or merges over 800 lines are investigation clues; do not remove barrels/boundaries solely by file count. Preserve `create*(deps)` test isolation and public export boundaries.

After approval, work from dependencies outward: `relocate → update imports → remove absorbed files → verify`. Up to two independent merge groups can form one batch; larger or intertwined changes use meaningful waves. Verify the current wave before continuing.

## 2. Functional deduplication

Check the consolidated result against actual consumer paths:

- Does repeated logic have identical semantics, literal-only differences, or necessary caller-specific exceptions?
- Does a reshape/forward wrapper own an API, permission, or lifecycle contract?
- Can parallel types/builders share a discriminant without erasing domain meaning?
- Is an apparently dead export public API or dynamically referenced?

Present the diagnosis, estimated savings, and preserved contracts; deduplicate only within approval. Place shared helpers at an allowed common dependency owner, never reaching back into hosts. Do not merge semantically different functions just to reduce lines.

## Verification and completion

Run each package script explicitly per wave:

```bash
cd <absolute-worktree> && pnpm --filter <pkg> typecheck && pnpm --filter <pkg> test && pnpm --filter <pkg> build
```

Check affected consumer builds, residual imports/dead references to removed paths, public exports, and module-state ownership. Disclose missing scripts or blocked checks. Repair task-induced regressions and repeat verification.

Finish when approved consolidation/deduplication and relevant checks are complete. Do not expand into general refactoring. Report before/after, API preservation, changed files, checks/results, and unverified scope. Commits/PRs require a separately requested or authorized lifecycle.

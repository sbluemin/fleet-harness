---
name: clean-code
description: Diagnose over-abstraction in a package, then consolidate files by domain and deduplicate functional logic.
---

# Clean Code

Two-pass refactoring: **Pass 1** consolidates files by domain boundary, **Pass 2** deduplicates functional logic across the result. Present each pass's diagnosis to the user for approval before executing.

## Inputs

- `<target_path>` — Directory or package to analyze (required).
- `<public_surface>` — Optional. Package root barrel that must preserve exports (e.g., `src/index.ts`).

## Pass 1 — Structural Consolidation

### Reconnaissance

1. `find <target_path> -type f -name "*.ts" -exec wc -l {} + | sort -n` — record file count, lines, avg.
2. Read every file. Classify each as: types-only, barrel, single-function util, stateful service, DI factory, tool spec.
3. `rg` external consumers to distinguish public vs internal exports.

### Diagnosis — flag these anti-patterns

- **Micro-file**: < 50 lines, single function/type. Flag if ≥ 3 in one directory.
- **Type split**: 2+ type-only files in same directory, or identical type literal in multiple files.
- **Barrel bloat**: `index.ts` with only re-export chains.
- **Factory+Proxy**: `create*()` → default singleton → forwarding functions where runtime never uses the factory directly.
- **DI singleton**: module-level mutable state outside a `create*(deps)` factory.

### Consolidation map

Group files by **domain concern** (not file type). Rules:
- Merged file ≤ ~800 lines; split on sub-domain boundary if exceeded.
- One `types.ts` per directory unless clearly distinct domains exist.
- ≤ 7 files after merge → delete the directory barrel.
- Module-level singletons → migrate to nearest DI service or `create*()` factory.

Present a before/after table (files, barrels, lines) and await user approval.

### Execution

- **≤ 2 merge groups**: Genesis direct.
- **≥ 3 merge groups or cross-directory deps**: host-authored execution plan → Genesis execution with artifact inspection and QA after each wave.
- Wave order: consolidate imported-from directories first. Per wave: relocate → update imports → delete absorbed files → typecheck/test/build → residual grep.

## Pass 2 — Functional Deduplication

After Pass 1, scan the consolidated files for:

### Diagnosis — flag these patterns

- **Copy-paste functions**: identical or near-identical logic in 2+ files (e.g., status mappers, effort resolvers, log wrappers). Diff the bodies — if they differ only by a string literal, parameterize.
- **Trivial wrappers**: functions that only reshape or forward to another function with no added logic. Inline at call site.
- **Parallel type hierarchies**: separate types/builders that follow the same structure. Unify with a discriminant parameter.
- **Dead exports**: exported but zero consumers (verify with `rg`).
- **Alias bloat**: namespace objects with backward-compat keys pointing to the same module, or methods duplicated under long+short names.

### Execution

Present the list with estimated line savings. After approval, dispatch Genesis. Extract shared helpers to the most downstream common file. Preserve public export symbols via re-export aliases where needed.

## Verification (both passes)

After each wave or batch:
1. `pnpm --filter <pkg> typecheck && test && build`
2. Consumer builds (dependent packages).
3. `rg` for deleted file imports and dead references.
4. Module-level mutable state grep — must be inside factory or class, not module scope.

## Safety

- Preserve all public export symbols. Use re-export aliases if the definition moves.
- No semantic changes — mechanical relocation and parameterization only.
- Re-read files before editing (concurrency safety).
- Keep `create*(deps)` factories needed for test isolation; remove only proxy wrappers.
- Do not skip verification between waves.

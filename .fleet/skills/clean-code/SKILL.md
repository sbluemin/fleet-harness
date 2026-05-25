---
name: clean-code
description: Aggressive file/code consolidation refactoring — diagnose over-abstraction, plan domain-based merges, execute wave-by-wave with DI alignment and full QA gates.
---

# Clean Code — Aggressive Consolidation Refactoring

Use this skill when a directory or package has too many micro-files, over-abstracted patterns, duplicated types, excessive barrel re-exports, or module-level singletons that violate DI discipline. The goal is to reduce cognitive load by merging files along domain boundaries while preserving public surface contracts and DI compliance.

## Inputs

Replace each `<placeholder>` before running. Optional inputs may be left blank — defaults will be inferred.

- `<target_path>` — Directory or package to consolidate (required, e.g., `packages/fleet-carriers/src/jobs/`).
- `<scope_hint>` — Optional. Specific subdirectories or file groups to focus on (e.g., "dispatch/ and jobs/ only"). If omitted, analyze the entire `<target_path>`.
- `<philosophy>` — Optional. Guiding principle (e.g., "Simple is best", "domain cohesion over file-per-function"). Default: "Simple is best — minimize file count per domain concern."
- `<public_surface>` — Optional. Package root or barrel that must preserve export compatibility (e.g., `src/index.ts`). If omitted, infer from `package.json` exports.
- `<verification_commands>` — Optional. Commands to validate after each wave (e.g., `pnpm --filter <pkg> typecheck && test && build`). If omitted, infer from package scripts.

## Goal

Diagnose structural anti-patterns, produce a quantified consolidation map, execute the merge wave-by-wave, and verify that public surface contracts, DI discipline, and test coverage remain intact.

## Required Workflow

### Phase 1 — Structural Reconnaissance

1. Read the applicable `AGENTS.md` files for the target path and its parents.
2. Enumerate all source files in `<target_path>`:
   - `find <target_path> -type f -name "*.ts" -exec wc -l {} + | sort -n`
   - Record: file count, total lines, average lines/file.
3. Read every file to understand:
   - **Content role**: types-only, barrel/re-export, single-function utility, stateful service, tool spec, DI factory.
   - **Cross-file dependencies**: which files import from which.
   - **Duplication**: same type/constant defined in multiple files, identical factory+proxy patterns.
4. Map external consumers:
   - `rg -n "from.*<target_path>" <project_root> --glob '!dist/**' --glob '!node_modules/**'`
   - Identify which exports are part of the public surface vs internal-only.

### Phase 2 — Anti-Pattern Diagnosis

Classify every file into one of these categories and flag anti-patterns:

| Anti-Pattern | Symptom | Threshold |
|--------------|---------|-----------|
| **Micro-file** | File < 50 lines with single function/type | Flag if ≥ 3 such files exist in one directory |
| **Type duplication** | Same directory has 2+ type-only files, or same type literal defined in multiple files | Always flag |
| **Barrel bloat** | `index.ts` with only `import * as` / `export *` chains exceeding 10 re-exports | Always flag |
| **Factory+Proxy** | `create*()` → `const default = create*()` → `export function x() { return default.x() }` where proxy adds no value | Flag if runtime only uses proxy, not factory directly |
| **DI singleton violation** | Module-level mutable state (`const state = new Map()`) outside a `create*(deps)` factory | Always flag — per doctrine this is forbidden |
| **Re-export indirection** | File A re-exports File B's types with no transformation | Flag if same directory |

Output a diagnosis table: one row per file, columns: file, lines, role, anti-pattern(s), merge candidate.

### Phase 3 — Consolidation Map

Design the target file layout by grouping files along **domain concern boundaries**, not file-type boundaries:

1. **Domain grouping rule**: files that share a single conceptual responsibility merge into one file. Examples:
   - "archive domain" = archive store + block converter + serializer
   - "lifecycle domain" = job lifecycle + concurrency + cancellation + abort signals
   - "tool surface" = tool spec + prompts + validation helpers
2. **Size constraint**: no merged file should exceed ~800 lines. If a merge would exceed this, split along sub-domain lines.
3. **Type consolidation**: all types for one directory merge into a single `types.ts` unless the directory has 2+ clearly distinct domains each needing their own types.
4. **Barrel elimination**: if the target directory has ≤ 7 files after merge, delete the `index.ts` barrel. Consumers import directly.
5. **DI alignment**: for each stateful module being merged:
   - If the state is currently a module-level singleton → migrate to an instance field on the nearest DI-managed service (e.g., a Registry class) or `create*(deps)` factory.
   - If a `create*()` factory exists and is used for test isolation → keep the factory, remove only the proxy wrapper functions.
   - Match existing DI patterns in the codebase (e.g., `fnName(registry, ...)` signature pattern).

Output a consolidation map table:

| Target File | Absorbs | Est. Lines | Domain | DI Notes |
|-------------|---------|-----------|--------|----------|
| ... | ... | ... | ... | ... |

Also output a quantified before/after comparison:

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| File count | | | |
| Barrel files | | | |
| Type files | | | |
| Estimated import statements | | | |

Present the consolidation map to the user for approval before proceeding.

### Phase 4 — Execution Planning

Choose planning depth based on scope:

**Admiral-direct** (≤ 2 merge groups, ≤ 10 files affected):
- Dispatch Genesis directly with the consolidation map as the objective.

**Kirov structured plan** (≥ 3 merge groups or cross-directory dependencies):
- Dispatch Kirov to produce a `.fleet/plans/<name>.md` plan file with:
  - Ordered waves (merge group A before B if B imports from A).
  - File ownership per wave.
  - QA gates per wave.
  - Acceptance criteria (exact file list post-merge).
  - Escalation triggers.
- Then dispatch Ohio to execute the plan wave-by-wave.

**Wave ordering rule**: if directory B imports from directory A, consolidate A first. Within a directory, merge types first, then stateful services, then tool surfaces.

### Phase 5 — Execution

Per wave:
1. Re-read every target file immediately before editing (concurrency safety).
2. Create consolidated files with content from absorbed files — mechanical relocation, no semantic changes.
3. Update all internal imports to point to canonical files.
4. Update the public surface barrel (`<public_surface>`) to re-export from canonical files.
5. Delete absorbed files and directory barrels.
6. Run `<verification_commands>` — typecheck, test, build must all pass.
7. Run residual grep to confirm no imports reference deleted files:
   - `rg -n "<deleted_file_patterns>" <project_root> --glob '!dist/**'`

### Phase 6 — DI Compliance Verification

After all waves complete:
1. Grep for module-level mutable state in merged files:
   - `rg -n "^(const|let) \w+ = new (Map|Set|Array)\b" <target_path>`
   - Any hit must be inside a `create*()` factory or a class instance — not at module scope.
2. Verify factory/reset test hooks still work:
   - Run package tests with `--verbose` if available.
3. Verify public surface compatibility:
   - Build dependent packages (`fleet-cli`, `fleet-admiral`, etc.).
   - Compare root export symbol list before/after if feasible.

### Phase 7 — Final Report

Output a structured report:

- **Diagnosis summary**: anti-patterns found, with counts.
- **Consolidation result**: before/after file counts, line counts, barrel count, import reduction estimate.
- **Wave results**: per-wave file list and pass/fail.
- **DI changes**: any singleton → registry migrations, factory preservations, proxy removals.
- **Verification**: all commands run and their results.
- **Residual risks**: any deferred items, unresolved concerns.

## Carrier Delegation Guidance

- **Vanguard** — codebase reconnaissance when the target is unfamiliar or spans many directories.
- **Nimitz** — strategic judgment when consolidation involves architectural trade-offs (e.g., where to place shared state, which DI pattern to use).
- **Kirov** — structured execution plan for multi-wave consolidation (≥ 3 merge groups).
- **Genesis** — direct implementation for small-to-medium consolidation (≤ 2 merge groups).
- **Ohio** — wave-by-wave execution of a Kirov plan.
- **Sentinel** — post-consolidation review if the refactor touches security-sensitive code.
- **Chronicle** — AGENTS.md or documentation updates if the internal topology description is now stale.
- Skip delegation for trivial merges (2 files → 1, single type file absorption).

## Safety Rules

- Do not change public API surface — all previously exported symbols must remain importable from the package root.
- Do not introduce semantic changes during consolidation — this is mechanical relocation only.
- Do not refactor code logic, rename public functions, or change signatures (except adding DI parameters like `registry` to previously-singleton functions).
- Do not modify files outside `<target_path>` except for import path updates and public surface barrel maintenance.
- Do not delete a file without first confirming all its exports are preserved in the target canonical file.
- Do not merge files across different domain boundaries just to minimize file count — domain cohesion is the primary grouping criterion, not file count minimization.
- Do not introduce module-level mutable singletons — if consolidation touches stateful code, migrate to DI-compliant patterns.
- Do not skip verification between waves — each wave must pass typecheck/test/build before the next begins.
- Re-read every file immediately before editing — other agents may be modifying the same codebase.
- Preserve `create*(deps)` factories that provide test isolation — remove only unnecessary proxy/wrapper layers.

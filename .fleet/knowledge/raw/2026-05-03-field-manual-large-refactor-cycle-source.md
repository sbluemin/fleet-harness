---
id: "field-manual-large-refactor-cycle-source"
created: "2026-05-03T02:37:21.856Z"
sourceType: "inline"
title: "conversation excerpt — admiral.agent migration + agent-runtime removal session workflow"
tags: ["doctrine", "workflow", "carriers", "field-manual", "delegation", "process"]
---
Five-stage carrier delegation cycle observed across two large refactors:

1. admiral.agent migration:
   - Vanguard 5-fan-out scout
   - Nimitz 3 rounds (Q1-Q9 architecture validation)
   - Kirov plan_file admiral-agent-migration.md
   - Ohio Wave A/B/C
   - Sentinel 3 rounds (FAIL → D-Fix → WARNING → D-Fix-2 → PASS)
   - Outcome: 5000+ lines refactored, 8 regression fixes caught during integration

2. legacy agent-runtime.ts removal:
   - Vanguard 1-fan-out (type duplication audit, 11 types classified)
   - Nimitz 1 round (executor.ts placement decision)
   - Kirov plan_file agent-runtime-removal.md (44 cumulative constraints)
   - Ohio Wave A/B/C
   - Sentinel 1 round (PASS WITH WARNING — 2 medium deviations + 3 low docs drift)
   - Outcome: 1500-line legacy module deleted, 911 ins / 2085 del

Stage anti-patterns observed:
- Skipping recon → plan drifts mid-execution
- Letting Kirov pick architecture → optimizes for executability not soundness
- Combining plan + code in same carrier → plan degrades into commentary
- Parallel waves → dependency interleaving causes hard-to-debug failures
- Self-verification by Ohio → tunnel-vision PASS that misses deviations Sentinel catches

Heuristic: full cycle pays off above ~6 files or when public APIs/legacy code/types change. Skip for single-file edits or known-scope bug fixes.

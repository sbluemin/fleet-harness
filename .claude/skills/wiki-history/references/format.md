# Decision history format

## Hard Rules

### DO — must be present

- The cognitive debt / friction / risk that existed in the **previous state**
- The **structural cause** of that cognitive debt (root cause, not just the symptom)
- The **decision context** (debates, agreements, constraints, trade-offs) under which the change was approved
- The **effect users/teams now feel** (lower learning cost, eliminated collision risk, restored consistency, etc.)
- `related` links (`[[wiki:<id>]]`) to existing entries in the same feature area

### DO NOT — must be absent

- Source file paths, function names, line numbers, class names, variable names
- Code snippets or pseudo-code
- Planning phrases such as "next step", "TODO", "Roadmap", "Phase 2", "future work"
- Implementation actions such as "changed X to Y", "added to module Z", "refactored A into B"
- "Here is how to implement it" style implementation guidance
- Build/test commands, directory trees, package dependency graphs
- Duplicated frontmatter inside the body (e.g., `id:`, `title:`, `tags:`, `created:`, `updated:`, `version:`, `feature_area:`, `lifecycle:` YAML blocks that repeat metadata already carried in the patch envelope)
- Sections not listed in the Output Format below (e.g., "Open Questions", "Future Considerations")

## Output Format

Follow the same section structure used by existing Fleet Wiki PRD entries (`prd-*`):

1. **Overview** — 1–2 paragraphs stating what was decided. No source locations.
2. **Problem** — Cognitive debt / friction / risk in the previous state. Include the structural cause, not just the symptom.
3. **Goals** — Targets this decision resolves, framed from the user's perspective.
4. **Non-Goals** — Areas intentionally left unchanged. Prevents scope misreading.
5. **User Stories** — "As a … when … then …" form, describing felt experience.
6. **Functional Requirements** — Only the **call surface / UX / contract** the user actually faces. Internal implementation changes are forbidden here.
7. **Acceptance Criteria** — A checklist verifiable by the user directly. UX checks, not unit-test assertions.
8. **Related** — Links to adjacent entries in the same/neighboring feature area.

Every section must be written from "**why**" and "**what the user feels at the surface**". If a single line slips into "how it was implemented", rewrite it.

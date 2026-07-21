---
name: carrier-operations
description: Per-carrier request-block contracts and dispatch composition rules for carrier_dispatch requests. Load before the first dispatch of the session; skip reloading if already in context.
---

# Carrier Operations

This skill owns dispatch composition: request-block contracts, parallel and sequential rules, and dispatch failure handling. Carrier selection and routing stay in `<fleet section="roster">`; invocation mechanics (label, brevity, polling, result lookup) stay in the live `carrier_dispatch` tool description. Missing required blocks cause hard-error rejection that echoes the violated carrier's contract.

All carriers accept an optional `<prior_jobs>` block: Prior finalized carrier job IDs for context lookup. Fetch with carrier_jobs(action:"result", format:"full", job_id:...); use format:"summary" if archive content has expired.

## Decisions Travel as Literals

Before dispatch, close every judgment gap by asking both:
1. Must the Carrier choose a concrete value?
2. Does the Carrier lack the doctrine, charter, or established-convention context needed to justify that choice?

If both answers are yes, the host chooses the value before dispatch and passes it verbatim, not as an abstraction. Examples — not an exhaustive domain list — include design tokens (color, mix ratio, easing), API paths, setting keys, protocol tokens, names, error-message text, thresholds, and constants. Never leave these choices behind phrases such as "match the theme", "pick a coherent color", "적절히", "일관되게", or "convention을 따라".

During Artifact Inspection, pass only when every dispatched literal matches verbatim; treat an equivalent-looking substitution as a defect.

When a relevant domain needs detailed pre-dispatch checks, load [the decision-literal checklists](references/decision-literals.md) on demand.

## Parallel Default

When the same phase or step calls multiple Carriers, invoke them in parallel — one tool call per carrier, same response. Sequence only when:
- a later Carrier's work depends on an earlier Carrier's output,
- carriers share a mutable resource (same files, generated artifacts, lock files, singleton test environment), or
- a recon Carrier must complete before a specialist Carrier can be selected.

Never split a parallel launch into sequential calls.

## Dispatch Failure Handling

If the intended Carrier is unavailable or carrier_dispatch rejects the requested Carrier: report to the user, await instructions. Never silently substitute. A missing-required-block rejection is self-correcting — recompose the request per the echoed contract and re-dispatch instead of escalating.

## Gotchas

- **Symptom:** Carrier output diverges from codebase conventions in style, naming, or value selection, such as losing theme cohesion or using undefined tokens.
  **Action:** Before dispatch, the host finalizes a decision-value table and supplies a verbatim copy, verifies each value exists in its target context (for example, a token is defined in all three themes), and includes prohibited substitutions plus validation greps.
  **Why:** The Carrier lacks the decision-basis context; a verbatim handoff has been empirically shown to pass review in one cycle without rework.

## Contracts by carrier
- **nimitz** (Nimitz · Strategic Command & Judgment) — wrap request content in these blocks (? = optional):
  - <context> required: Background situation, current state, and relevant history.
  - <problem> required: The specific question, decision point, or challenge to analyze.
  - <constraints?> optional: Hard constraints, deadlines, compatibility requirements.
  - <artifacts?> optional: Relevant code snippets, file paths, error logs to examine.
- **kirov** (Kirov · Operational Planning) — wrap request content in these blocks (? = optional):
  - <goal> required: What the user wants to build, fix, or achieve — specific feature, PRD, behavior, and any stated constraints.
  - <plan_id> required: Required stable lowercase Plan identity. Kirov passes this logical id to plan_write and returns the resulting PlanRef; never accept or invent a filesystem path.
  - <context?> optional: Relevant codebase context — files, modules, patterns, prior host-agent direction, or implementation realities the planner should respect.
  - <constraints?> optional: Business rules, tech stack requirements, scope boundaries, fixed decisions, or explicit exclusions the plan must respect.
  - <intent_type?> optional: If known: Refactoring | Build from Scratch | Mid-sized | Collaborative | Architecture Follow-through | Research-to-Plan.
- **genesis** (Genesis · Chief Engineer) — wrap request content in these blocks (? = optional):
  - <objective> required: What needs to be built or achieved. Be specific about the desired end state.
  - <scope> required: Which modules, directories, or subsystems are in play.
  - <constraints?> optional: Hard technical constraints, compatibility requirements, or non-negotiables.
  - <references?> optional: Prior Nimitz recommendations, Kirov plans, existing patterns to follow, or design decisions already made.
- **ohio** (Ohio · Multi-Wave Execution) — wrap request content in these blocks (? = optional):
  - <task_refs> required: Required newline- or comma-delimited fully qualified TaskRefs from exactly one Plan and one Lane. Ohio calls plan_read once at dispatch start with the complete set and executes only the returned selected_tasks.
  - <objective?> optional: Optional brief restatement of the overarching goal for context anchoring.
  - <scope?> optional: Optional explicit boundaries that further narrow, but never expand, the assigned TaskRefs.
  - <constraints?> optional: Optional hard constraints, deadlines, or compatibility requirements that override or supplement the plan.
- **sentinel** (Sentinel · QA & Security Lead) — wrap request content in these blocks (? = optional):
  - <target> required: Which files, modules, PRs, endpoints, or recent changes to inspect.
  - <concern?> optional: Specific suspicion, symptom, or area of worry to focus on.
  - <context?> optional: Background on what the code does and expected behavior.
  - <attack_surface?> optional: Known entry points, user-controlled inputs, or external interfaces (security mode).
  - <threat_model?> optional: Assumed attacker capability — unauth user, compromised dep, insider (security mode).
  - <fix_mode?> optional: 'report' (default) for findings only, or 'fix' to apply corrections.
- **vanguard** (Vanguard · Reconnaissance Specialist) — wrap request content in these blocks (? = optional):
  - <objective> required: What intelligence is needed — question to answer or target to locate.
  - <search_space?> optional: Directories, files, URLs, or domains to focus the search on.
  - <hints?> optional: Known symbols, keywords, file patterns, or prior findings to narrow the scan.
  - <depth?> optional: 'quick' for surface scan, 'thorough' for exhaustive. Default: 'medium'.
- **tempest** (Tempest · External Intelligence) — wrap request content in these blocks (? = optional):
  - <target_repo> required: Repository to investigate (owner/repo format or full URL).
  - <objective> required: What intelligence is needed — feature, pattern, API usage, or implementation detail.
  - <focus_areas?> optional: Specific directories, files, symbols, or code patterns to prioritize.
  - <constraints?> optional: Time constraints, specific branches/tags, or areas to exclude.
- **chronicle** (Chronicle · Chief Knowledge Officer) — wrap request content in these blocks (? = optional):
  - <target> required: [Codebase Doc] which code, module, PR, feature, or release artifact to document. [Fleet Wiki] which feature area or wiki entry slug.
  - <doc_type> required: [Codebase Doc] README, API spec, PR summary, release notes, changelog, AGENTS.md, '.md-audit', change-impact summary, breaking-change report, migration guide. [Fleet Wiki] 'wiki-create' (new entry) or 'wiki-update' (existing entry revision).
  - <audience> required: developers, end-users, API consumers, operators, or contributors.
  - <scope?> optional: [Codebase Doc] include/exclude; for changelogs/change-impact/audits: commit range, PR, diff, feature slice, deployment scope. [Fleet Wiki] feature_area, target wiki id (for update), tags.

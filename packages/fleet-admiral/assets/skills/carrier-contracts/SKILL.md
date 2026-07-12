---
name: carrier-contracts
description: Per-carrier request-block contracts for composing carrier_dispatch requests. Load before the first dispatch of the session; skip reloading if already in context.
---

# Carrier Request-Block Contracts

This skill owns only the request composition contract. Carrier selection and routing stay in `<fleet section="roster">`; dispatch mechanics (label, brevity, polling, result lookup) stay in the live `carrier_dispatch` tool description. Missing required blocks cause hard-error rejection that echoes the violated carrier's contract.

All carriers accept an optional `<prior_jobs>` block: Prior finalized carrier job IDs for context lookup. Fetch with carrier_jobs(action:"result", format:"full", job_id:...); use format:"summary" if archive content has expired.

## Contracts by carrier
- **nimitz** (Nimitz · Strategic Command & Judgment) — wrap request content in these blocks (? = optional):
  - <context> required: Background situation, current state, and relevant history.
  - <problem> required: The specific question, decision point, or challenge to analyze.
  - <constraints?> optional: Hard constraints, deadlines, compatibility requirements.
  - <artifacts?> optional: Relevant code snippets, file paths, error logs to examine.
- **kirov** (Kirov · Operational Planning) — wrap request content in these blocks (? = optional):
  - <goal> required: What the user wants to build, fix, or achieve — specific feature, PRD, behavior, and any stated constraints.
  - <plan_file> required: Required exact repo-relative .fleet/plans/{name}.md path Kirov must create or update. Do not choose a different filename.
  - <context?> optional: Relevant codebase context — files, modules, patterns, prior host-agent direction, or implementation realities the planner should respect.
  - <constraints?> optional: Business rules, tech stack requirements, scope boundaries, fixed decisions, or explicit exclusions the plan must respect.
  - <intent_type?> optional: If known: Refactoring | Build from Scratch | Mid-sized | Collaborative | Architecture Follow-through | Research-to-Plan.
- **genesis** (Genesis · Chief Engineer) — wrap request content in these blocks (? = optional):
  - <objective> required: What needs to be built or achieved. Be specific about the desired end state.
  - <scope> required: Which modules, directories, or subsystems are in play.
  - <constraints?> optional: Hard technical constraints, compatibility requirements, or non-negotiables.
  - <references?> optional: Prior Nimitz recommendations, Kirov plans, existing patterns to follow, or design decisions already made.
- **ohio** (Ohio · Multi-Wave Execution) — wrap request content in these blocks (? = optional):
  - <plan_file> required: Required repo-relative path to a Markdown plan file under .fleet/plans/*.md only. Ohio reads this file and follows it as the authoritative execution plan.
  - <execution_scope?> optional: Optional: for legacy plans without Execution Topology or plans marked Execution mode: Sequential, omitted or `all` executes the full plan sequentially. For Execution mode: Parallel, provide one exact Wave/Lane ID declared by the Dispatch Manifest; omitted or `all` is rejected. Never combine a full-plan invocation with scoped-lane Ohio invocation(s).
  - <objective?> optional: Optional brief restatement of the overarching goal for context anchoring.
  - <scope?> optional: Optional explicit scope boundaries if narrower than the plan_file's full coverage.
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

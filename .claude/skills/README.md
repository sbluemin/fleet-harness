# Repository Task Skills

This directory owns repository-work skills. It is separate from published Admiral skills in `packages/fleet-admiral/assets/skills/`; do not vendor installed external skills here.

## Authoring

- Preserve directory names and `name`; keep `SKILL.md` as the entrypoint. Use a short, single-line description stating **when to select it** and neighboring exclusions. Avoid YAML `>`/`|` unsupported by the Console parser and descriptions longer than 500 characters.
- Keep inputs, execution decisions, authority boundaries, and completion/stop conditions in the entrypoint. Leave judgment-dependent ordering flexible; retain order required by dependencies or side effects.
- Put long commands and platform/mode-specific procedures once in `references/`. Link them with **when and why to read**, not a requirement to preload everything.
- Do not duplicate procedures owned by another skill or `CLAUDE.md`. Add a skill only for a distinct recurring task.
- Continue reversible local checks within authorized scope. Automatic selection does not authorize commits, external publication, deployment, or permanent Wiki approval. Model-performance claims do not relax product-direction, deletion-ownership, credential, or required-check boundaries.

## Validation

From the repository root with its Node environment:

```bash
node .claude/skills/validate-skills.mjs
pnpm --filter @fleet-plugins/skills test
```

The validator checks the real Console description parser, names, file links, and reference reachability. Relative Markdown links must target real files within the skill tree. It does not enforce arbitrary body lengths or section wording. It is not evidence of LLM routing accuracy or successful lifecycle execution.

Review semantic changes by assembling an entrypoint with **only references selected by the case** below. For comparisons with an earlier revision, hold prompt, model/effort, tools, and retrieval conditions constant; record initial route, loaded references, stopping point, and authority violations. Label a document dry-run as such rather than claiming live execution.

| Representative request/condition | Expected route and contract |
|---|---|
| Escape from a Console modal reaches a background shortcut | console-e2e; setup/verification, actual focus and shortcut checks |
| Give me a URL to try this branch myself | console-handoff; verify seed/PID, leave server running, do not open the browser for the user |
| Reopen a closed Windows Desktop window from the tray | desktop-e2e native lane; Windows headed evidence, not macOS/CDP substitution |
| Reduce Gateway loop requests with the same prompt | ai-gateway-loop-optimization; standalone when caller/host is irrelevant, frozen before/after workload |
| Consolidate package micro-files and proxies | clean-code; public consumers and approved batches, no file-count-only deletion |
| Plugin colors look disjoint across Console | design-sweep; quick=candidates, full=three-theme measurements |
| Choose a new Console recovery UX | product-proposal; live evidence and interactive options, stop before implementation |
| Create a work checkout / target path already exists | git-worktree create; canary base and internal install, no overwrite on collision |
| Remove current checkout / it is main or a protected branch | git-worktree remove; stop before actual removal |
| Rebase a topic with sync_local_base=no | rebase-on-canary; preview/rebase/verification all use origin/canary, no push |
| Resume Codex review on an open PR | pr-workflow; recover pushed head/frozen context, ignore stale +1, bounded passes and final audit |
| Synchronize only / range is docs-only | release-version-update; no main deployment push, no fake product change to trigger CI |
| Record why an approved decision was made | wiki-history; eight sections and evidence-backed preview, no permanent registration before approval |
| Capture recurring learning from this task | learning-harvest; recurrence/cost/generality, no encoding before candidate approval |
| Implement an approved single CSS fix or edit docs only | Do not expand into unrelated proposal/sweep/PR/release workflows |

## Revision basis and limits

The 2026-09-05 revision applies narrow activation conditions, progressive disclosure, removal of unnecessary standing procedures, and explicit finish lines from the user-supplied [ExplainX guide](https://www.explainx.ai/blog/gpt-6-astra-skills-agents-md-prompting-guide-2026). It is a secondary source; this repository has not verified its model-performance, release, or behavior claims. An asserted model improvement is not grounds to remove tests, ownership checks, or publication approval.

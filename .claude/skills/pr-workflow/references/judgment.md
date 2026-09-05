# Review judgment and product context

## Judgment Policy

Treat GitHub Codex review as code-local, context-incomplete evidence, never authority. Codex sees the code tree and diff but may not know the product background, cognitive-debt decisions, original user intent, or intended trade-offs. Codex approval is not proof of product correctness.

Treat every finding as an adversarial hypothesis. Severity is not disposition. First classify it as either **code-local correctness / security / data-loss** or **product policy / behavior / trade-off / hypothetical hardening**; then decide **FIX / DECLINE / DEFER** from evidence.

- **FIX** only after verifying all four gates: the defect occurs on a supported execution path; the change aligns with the original scope; no supported functionality regresses or narrows; and change cost is proportional to user/operator value. Code correctness is necessary, not sufficient.
  - **Reproduce before you edit, and record how.** An unreproduced finding is a hypothesis, and a hypothesis is a DECLINE — never a cheap defensive fix "while we are here". If the reviewer claims a defect you cannot make happen, say so and decline it; do not harden against it to close the comment.
  - **A supported execution path is one a real workflow reaches.** For a security finding, an attacker-constructed state counts. For everything else, a state that exists only because you hand-built an exotic fixture to satisfy the reviewer does not. "The predicate should be consistent", "it is only a few lines", and "the tests are green anyway" are not user value.
- **DECLINE** with cited Product Context Record or repository evidence when the finding is context-blind, hypothetical or overfit, outside scope, conflicts with an intended trade-off, narrows supported behavior, or lacks user/operator value. Record and courteously post every decline; never silently skip it.
- **DEFER** a real architectural or product-policy issue that is outside the PR scope. State why it is real and why this PR must not absorb it.
- **STOP and ask the user** when product intent is genuinely ambiguous and the Product Context Record plus cited evidence cannot resolve it. Never let the reviewer decide product policy.

Do not treat re-review comments as new scope. After every review pass, audit the cumulative review-fix diff from `REVIEW_BASE_HEAD` against the frozen Product Context Record. Roll back drifted review-fix hunks to the base behavior; do not stack compensating fixes on top of scope drift.

**A fix that breeds the next finding was over-scoped.** When a pass reports problems that exist only because the previous pass's fix created them, that is evidence against the previous fix, not a request for another one. Prefer rolling it back over widening it again.

This policy governs Phase 4 (classification / verification) and Phase 5 (self-verification audit).

## Product Context Record

Before the first review-fix, freeze one Product Context Record for the entire PR. Do not rewrite it to justify later feedback. Only an explicit later user or release-owner directive may append a cited context amendment; preserve the original record, and never treat reviewer feedback as authority to amend it. Record:

- Original request and acceptance criteria.
- Explicit exclusions.
- Intended trade-offs.
- Supported behavior that must not regress or narrow.
- Cited issue, PRD, Fleet Wiki, and decision evidence when available.
- `REVIEW_BASE_HEAD`: the pushed PR head SHA before any review-fix.

If resuming after review fixes and this record or a trustworthy pre-fix `REVIEW_BASE_HEAD` cannot be reconstructed from the PR history and cited evidence, stop and ask the user before applying more feedback or merging.

### Phase 4 — Judge & apply feedback

1. Require the frozen Product Context Record and trustworthy `REVIEW_BASE_HEAD`; stop if either is missing.
2. Before considering new feedback, audit existing cumulative review-driven changes with `git diff REVIEW_BASE_HEAD` plus staged/untracked-file inventory. Compare every hunk to the frozen record and cited user-directed amendments. Roll back only drifted review-driven intent to `REVIEW_BASE_HEAD` behavior; preserve later user-directed and concurrent changes.
3. Collect and group review items by author/severity (Codex P1/P2/P3, human asks, nits). Filter to `<scope_hint>`. Severity never determines disposition and no comment grants new scope.
4. For each item, verify the claim against current code/docs and classify it as code-local correctness/security/data-loss or product policy/behavior/trade-off/hypothetical hardening.
5. Decide **FIX / DECLINE / DEFER** under the Judgment Policy. For FIX, record evidence for all four gates before editing. Record cited evidence for every disposition; never silently skip.
6. Apply FIX items in this session with the frozen Product Context Record in view. For multi-file or non-trivial fixes, keep the objective, scope, and constraints explicit before editing; keep trivial single-file edits equally narrow.
7. Apply FIX items narrowly — restrict edits to the verified defect and preserve all supported behavior named in the record. No opportunistic refactors, renames, formatting churn, or speculative hardening. Prefer `Edit` over full-file rewrite; re-read each file immediately before editing. New code comments in Korean.
8. Repeat the cumulative audit after applying the pass. Roll back drifted review-driven hunks before continuing while preserving cited user-directed amendments; never add a compensating fix for review-created drift.

### Phase 5 — Re-validate, commit, push, request re-review

1. Self-verification (before external checks): walk `git diff REVIEW_BASE_HEAD` hunk by hunk — every review-driven hunk maps to a FIX item and passes all four gates (else roll it back); every fix-item is reflected; decline/defer rationale is cited; supported behavior is preserved; no boundary/scope breach; no unverified runtime assumption; new comments Korean; files re-read before edit; no single-call-site abstraction; replay each original comment ("does this concern still hold?").
2. External checks: `git status --short` + `git diff --stat` (only intended files); run available checks for touched workspaces — `pnpm --filter <pkg> typecheck`, `build` (tsc — vitest alone does NOT typecheck), `test`. State explicitly if a script is absent.
3. Commit the fixes (Conventional Commits, HEREDOC, no amend/bypass) staging only the fix files.
4. Confirm the current branch is `<headRefName>` (the recorded PR head); if it is not, stop and ask — do not push fixes from a non-head branch. Push the current commit explicitly with an `HEAD:<headRefName>` refspec so the actual fix commit lands on the PR branch (a bare `git push origin <headRefName>` pushes the like-named local ref, not necessarily current HEAD): `git push origin HEAD:<headRefName>`; then verify the local branch is up-to-date with the remote.
5. Post the `@codex` re-review comment via HEREDOC only after the push is visible on the remote:
   ```bash
   gh pr comment <pr_number> --repo <repo> --body "$(cat <<'EOF'
   @codex The review feedback has been addressed. Please re-review.

   ## Addressed
   - <item — file:line — one-line fix summary>
   ## Validation
   - <command — result>
   ## Notes
   - <declined items with rationale, deferred items with follow-up>
   EOF
   )"
   ```
6. Return to Phase 3 to await the next review pass.

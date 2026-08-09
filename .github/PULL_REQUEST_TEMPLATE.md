> **PR Target:** 이 PR의 base는 반드시 `canary`여야 하며, 다른 브랜치를 target하면 자동으로 close됩니다.

## PR Title

<!-- Use Conventional Commits format: type(scope): summary, e.g. feat(fleet): add push mode settings. -->

## Summary

<!-- What this PR does, and why. 1-3 sentences. -->

## Type of Change

- [ ] feat — new feature or carrier capability
- [ ] fix — bug fix
- [ ] docs — documentation only
- [ ] refactor — no behavior change
- [ ] chore — build, tooling, deps
- [ ] BREAKING CHANGE

## Scope

<!-- Which areas does this touch? -->
- [ ] `extensions/core`
- [ ] `extensions/fleet` (Admiral / Bridge / Carriers)
- [ ] `extensions/boot`
- [ ] `extensions/diagnostics`
- [ ] `extensions/metaphor`
- [ ] `packages/unified-agent`
- [ ] `bin/` or root tooling
- [ ] Documentation (README / SETUP / AGENTS.md)

## Test Plan

<!-- How to verify. Include repro steps, commands, or screenshots. -->
- [ ] 

## Changelog

- [ ] Added the branch-named fragment, amended a pending fragment with `changelog-amend` plus `Changelog-Amend: <file>.md`, or declared `Changelog-Impact: none` below.
- [ ] Entries sit under the runtime the user notices them in — `### fleet-cli`, `### fleet-console`, or `### fleet-desktop` — not the package that implements them.
- [ ] Section headings are `Added`, `Changed`, `Fixed`, `Removed`, or `Breaking Changes`; bullets are English ASCII with no package tag, each followed by its `  ko:` line.

<!-- Internal-only change? Delete the checklist above, apply the `no-changelog` label, and type these two
lines into the body yourself (they are deliberately not pre-filled, because a declaration nobody wrote
is not a declaration):

    Changelog-Impact followed by a colon and the word none
    No-Changelog-Reason followed by a colon and one of:
      internal-refactor | boundary-gate | doctrine-prompt | test-repair | release-tooling

Then add one sentence saying why no user notices this change. -->

## Related Issues / PRs

<!-- Closes #N, References #M -->

## Notes for Reviewers

<!-- Optional: callouts, trade-offs, follow-ups. Delete if unused. -->

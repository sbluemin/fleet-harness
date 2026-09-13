# Changelog Fragments

Release notes are for people using Fleet, not for reviewers reconstructing an implementation. The root instructions own inclusion and compiler-owned output boundaries. `scripts/compile-changelog-fragments.mjs` owns syntax, validation, and generation.

## Editorial standard

- Lead with the capability or observable improvement: what users can now do, what became easier, or what no longer fails. Name the product feature in familiar language.
- Prefer one short sentence per coherent change. Add a second only for an essential prerequisite, compatibility change, migration, or user action. Do not turn one feature into a checklist of its controls.
- Remove implementation names, file paths, transport details, internal state machines, dependency versions, test results, performance measurements, design tokens, pixel dimensions, and exhaustive edge cases unless users need them to act.
- A bug note states the symptom that stopped happening, not the debugging story. A redesign states the workflow improvement, not every moved control, visual treatment, or rejected alternative.
- Keep meaningful limitations and breaking changes. Brevity must not hide a required setup step, removed capability, platform restriction, or change to user data or permissions. Link to documentation when instructions are too long for the note.
- Describe only verified behavior in that release. Do not invent user benefits for internal maintenance; omit maintenance that has no feature-level user impact. Do not describe a future feature as shipped.
- Combine overlapping notes within the same release and runtime when they describe one capability. Distinct capabilities remain separate. Do not duplicate the same policy or explanation across several bullets.
- English and Korean communicate the same scope and benefit in natural language, not word-for-word implementation prose. Keep public names and necessary commands consistent.

Before finishing, ask: can a user tell what changed without knowing the codebase, and can any remaining detail be removed without changing what they can do or need to know?

## Inclusion and release baseline

Include coherent user-facing additions, removals, behavior changes, and noticeable fixes. Omit refactors, tests, internal safeguards, release machinery, and instruction edits without a product-level delta. No fragment is required merely because code changed; omission needs no `no-changelog` declaration.

Classify against publicly released behavior, not the sequence of internal PRs. Corrections to an unreleased feature belong in its existing pending note, or need no note. Before a runtime's first public release, describe its completed capability under `Added`, not a series of fixes to an unreleased product.

## Runtime ownership

Group by where users experience the change, not where its source lives:

- `fleet-cli`: the `fleet` terminal launcher.
- `fleet-console`: Console and its built-in plugins.
- `fleet-desktop`: the native Desktop shell.
- `fleet-mobile`: the mobile shell.

A change experienced in multiple runtimes may have a complete note for each distinct user experience. Do not repeat implementation explanations or refer readers to another runtime's bullet.

## Fragment identity and format

- One new fragment per branch. Obtain its name with `node scripts/compile-changelog-fragments.mjs --name-for-branch`; declare that branch in `branch:` frontmatter. A branch rename changes both together.
- Authorized direct `canary` work appends to `canary.md`, without frontmatter. Never overwrite another change.
- Preserve base fragments by default. Amend pending notes when folding in an unreleased correction or when the user explicitly requests editorial cleanup. Preserve their filenames and branch identity. Each amended base fragment requires the `changelog-amend` PR label and a `Changelog-Amend: <file-name>.md` PR-body line. Do not delete or rename a base fragment.
- Use runtime headings and `Added`, `Changed`, `Fixed`, `Removed`, or `Breaking Changes` sections. New bullets have no package tag.
- Each English ASCII bullet is immediately followed by `  ko: ` and its Korean translation containing Hangul. Preserve necessary technical tokens between languages. The compiler and `scripts/changelog-korean-seed.test.mjs` validate the bilingual contract.

```md
---
branch: example-feature
---

### fleet-console
#### Added
- Let agents use Mac apps while you follow their work in a live preview.
  ko: 에이전트가 Mac 앱을 사용하는 동안 실시간 미리보기로 작업을 확인할 수 있습니다.
```

## Published history and generated outputs

`CHANGELOG.md` and `CHANGELOG.ko.md` remain compiler-owned. Never hand-edit them or manufacture a release to refresh their wording. Routine releases preserve existing history.

Explicitly requested historical copy cleanup may use `node scripts/compile-changelog-fragments.mjs --rewrite-history <edits.json>`. Each edit provides a 1-based `line`, exact `beforeEn` and `beforeKo` summaries, and replacement `en` and `ko` summaries, without the `- ` prefix. The compiler refuses stale source text and writes both languages without consuming pending fragments. Preserve release versions, dates, runtime and section headings, links, historical package tags, and English/Korean correspondence. Revise wording without moving a feature to another release or changing its historical meaning. Old `fleet-plugin` and `fleet-core` headings remain historical facts, not migration targets.

Validate fragments and bilingual history after changes. For a compiler change, also run its tests. Editorial revisions alone do not require a new product changelog entry.

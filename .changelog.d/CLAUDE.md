# Changelog Fragments

Follow the root inclusion criteria and compiler-owned output boundary. Apply the authoring contract below only when creating or changing a fragment. English bullets use ASCII and are immediately followed by a `  ko: ` line containing Hangul. `scripts/compile-changelog-fragments.mjs` owns fragment syntax and validation. Preserve protected technical tokens between locales; `scripts/changelog-korean-seed.test.mjs` checks release topology and token parity in compiled history.

## When to write

Author a fragment only when, from a product perspective, a user would perceive a coherent feature-level change in a shipped runtime. Decide that inclusion autonomously — the PR template does not require a changelog checklist, and CI does not require a `no-changelog` declaration when you omit a fragment.

Include for new capabilities, removed capabilities, user-facing behavior changes, and user-noticeable fixes that read as product deltas. Omit for refactors, boundary gates, doctrine and prompt edits, test repairs, release tooling, and any other work a user would not experience as a feature-unit change. Absence of a fragment is the record of that decision; do not invent ceremony to justify it.

## Runtime Mapping

Release notes are grouped by the runtime a user experiences a change in, never by the package it was implemented in. Ask where the user notices it:

- Noticed in the `fleet` terminal launcher maps to `fleet-cli`.
- Noticed in Fleet Console maps to `fleet-console`.
- Noticed in the Fleet Desktop shell maps to `fleet-desktop`.
- Noticed in the Fleet Mobile shell maps to `fleet-mobile`.

Where the code lives does not decide this. A change implemented under `packages/**` or `runtime/fleet-plugins/**` is recorded under the runtime that surfaces it. A change noticed in more than one runtime gets one complete bullet per runtime, each written for that surface and choosing its own section against that runtime's shipped baseline; never cross-reference another runtime from a bullet.

## Fragment Identity

- One fragment per branch, named after that branch. Read the name from `node scripts/compile-changelog-fragments.mjs --name-for-branch`; never derive it by hand.
- The fragment declares its own branch in `branch:` frontmatter, and the compiler rejects a filename that disagrees with it. Renaming a branch means renaming the file and correcting the frontmatter in the same commit.
- The branch exists before the work does, so when a fragment is warranted it belongs in the same commit as the change it describes.
- Explicitly authorized direct `canary` work writes `canary.md`, which carries no frontmatter. Append to an existing `canary.md`; do not overwrite another direct change.
- A fragment already on the base branch belongs to another change and stays byte-identical by default. Folding a correction into someone's pending fragment — which Release Baseline below requires — is the one exception, and it must be declared twice: apply the `changelog-amend` label and add one `Changelog-Amend: <file-name>.md` line to the PR body per fragment you rewrite. An amendment only rewrites; deleting or renaming a base fragment stays refused.

## Fragment Body

Frontmatter declares the branch; the body carries runtime and section identity. One fragment may contain several runtime and section groups:

```md
---
branch: feat/some-topic
---

### fleet-console
#### Changed
- Group release notes by the runtime a change is noticed in.
  ko: <Korean summary containing Hangul>
```

Replace the placeholder with the actual Korean translation before validation.

Runtime headings use the Runtime Mapping values above. Section headings are `Added`, `Changed`, `Fixed`, `Removed`, or `Breaking Changes`. Bullets carry no package tag — the runtime heading already states where the change is noticed, and the compiler rejects a bullet that starts with one. Every English bullet and Korean `ko:` line remain adjacent. Groups may be authored in any order because the compiler emits the canonical runtime and section order: `fleet-cli`, `fleet-console`, `fleet-desktop`, `fleet-mobile`, each with its sections nested beneath.

Existing compiled release history remains unchanged. Releases through v1.51.0 use `fleet-plugin` and `fleet-core` headings and per-bullet package tags; do not rewrite them to adopt this layout. The Console reader still understands those releases, but the compiler no longer writes them.

## Release Baseline

Classify entries against the runtime's public release baseline, not the order of internal PRs. Before a runtime's first public release, fold its implementation corrections, redesigns, packaging repairs, and release-pipeline adjustments into `Added` as part of the initially shipped product. Use `Changed` or `Fixed` only for behavior that differs from a version users could previously consume. Describe first-release hardening as a shipped capability or quality, not as a fix to an unreleased product. This holds per change, not only at a runtime's first release: a correction to a change whose own fragment is still unreleased in `.changelog.d/` describes behavior no shipped version exposed, so fold it into that pending fragment or omit a note — never emit a standalone `Changed` or `Fixed` entry for behavior users could not yet consume.

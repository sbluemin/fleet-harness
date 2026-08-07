# Changelog Fragments

Follow the root `AGENTS.md` changelog rules in full: compiler-owned changelogs remain untouched; every English bullet and Korean `ko:` line are adjacent; ASCII English, Hangul Korean, and protected tokens follow the root contract.

## Runtime Mapping

Release notes are grouped by the runtime a user experiences a change in, never by the package it was implemented in. Ask where the user notices it:

- Noticed in the `fleet` terminal launcher maps to `fleet-cli`.
- Noticed in Fleet Console maps to `fleet-console`.
- Noticed in the Fleet Desktop shell maps to `fleet-desktop`.

Where the code lives does not decide this. A change implemented under `packages/**` or `runtime/fleet-plugins/**` is recorded under the runtime that surfaces it. A change noticed in more than one runtime gets one complete bullet per runtime, each written for that surface and choosing its own section against that runtime's shipped baseline; never cross-reference another runtime from a bullet.

Work no user perceives — refactors, boundary gates, doctrine and prompt edits, test repairs, release tooling — is `no-changelog`: it creates no fragment and no entry. Release notes carry no collapsed group for internal work.

## Fragment Identity

- One fragment per branch, named after that branch. Read the name from `node scripts/compile-changelog-fragments.mjs --name-for-branch`; never derive it by hand.
- The fragment declares its own branch in `branch:` frontmatter, and the compiler rejects a filename that disagrees with it. Renaming a branch means renaming the file and correcting the frontmatter in the same commit.
- The branch exists before the work does, so the fragment belongs in the same commit as the change it describes.
- Explicitly authorized direct `canary` work writes `canary.md`, which carries no frontmatter. Append to an existing `canary.md`; do not overwrite another direct change.

## Fragment Body

Frontmatter declares the branch; the body carries runtime and section identity. One fragment may contain several runtime and section groups:

```md
---
branch: feat/some-topic
---

### fleet-console
#### Changed
- Group release notes by the runtime a change is noticed in.
  ko: 릴리스 노트를 변경이 드러나는 런타임 기준으로 묶습니다.
```

Runtime headings use the Runtime Mapping values above. Section headings are `Added`, `Changed`, `Fixed`, `Removed`, or `Breaking Changes`. Bullets carry no package tag — the runtime heading already states where the change is noticed, and the compiler rejects a bullet that starts with one. Every English bullet and Korean `ko:` line remain adjacent. Groups may be authored in any order because the compiler emits the canonical runtime and section order: `fleet-cli`, `fleet-console`, `fleet-desktop`, each with its sections nested beneath.

Existing compiled release history remains unchanged. Releases through v1.51.0 use `fleet-plugin` and `fleet-core` headings and per-bullet package tags; do not rewrite them to adopt this layout.

A `pr-<number>.md` fragment authored before this layout landed still carries those headings and tags. It belongs to someone else's unreleased change, so the compiler keeps accepting it as written and emits it after the runtime groups. Never author a new one, and never rewrite one in place — the next release drains them, and the compiler's `pr-<number>` path retires with them.

## Release Baseline

Classify entries against the runtime's public release baseline, not the order of internal PRs. Before a runtime's first public release, fold its implementation corrections, redesigns, packaging repairs, and release-pipeline adjustments into `Added` as part of the initially shipped product. Use `Changed` or `Fixed` only for behavior that differs from a version users could previously consume. Describe first-release hardening as a shipped capability or quality, not as a fix to an unreleased product. This holds per change, not only at a runtime's first release: a correction to a change whose own fragment is still unreleased in `.changelog.d/` describes behavior no shipped version exposed, so fold it into that pending fragment or classify the PR `no-changelog` — never emit a standalone `Changed` or `Fixed` entry for behavior users could not yet consume.

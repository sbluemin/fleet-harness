# Changelog Fragments

Follow the root `AGENTS.md` changelog rules in full: compiler-owned changelogs remain untouched; fragments use exactly one allowed section; every English bullet and Korean `ko:` line are adjacent; package tags, ASCII English, Hangul Korean, and protected tokens follow the root contract.

## Product Mapping

- `runtime/fleet-cli/**` maps to `fleet-cli`.
- `runtime/fleet-console/**` maps to `fleet-console`.
- `runtime/fleet-desktop/**` maps to `fleet-desktop`.
- `runtime/fleet-plugins/**` maps to `fleet-plugin`.
- All other `packages/**` paths map to `fleet-core`.

## Fragment Identity and Workflow

- For a pull request, create exactly one `pr-<positive-number>.md` after GitHub assigns the PR number. Implement and push the product change first, open the PR, then add the fragment in a second commit and push it before requesting review.
- For an explicitly authorized direct `canary` change, create or update `canary.md` in the same commit. Append to an existing `canary.md`; do not overwrite another direct change.
- Do not create new `<product>-<section>.md` fragments. The compiler accepts that legacy shape only until already-open fragments are released.
- A change explicitly classified as `no-changelog` creates neither file. Policy, instruction, and release-tooling changes may use this exception only when the user or release owner states that they are not release-facing.

## Grouped Fragment Body

Put product and section identity in the fragment body. A single PR or canary fragment may contain multiple product and section groups:

```md
### fleet-console
#### Changed
- [fleet-console] Organize release notes by product.
  ko: 릴리스 노트를 제품별로 구성합니다.
```

Product headings use the Product Mapping values above. Section headings are `Added`, `Changed`, `Fixed`, `Removed`, or `Breaking Changes`. Every English bullet and Korean `ko:` line remain adjacent; package tags retain the root-contract vocabulary. Product and section groups may be authored in any order because the compiler emits the canonical product and section order.

The fragment compiler renders new releases with product headings first, in the order `fleet-cli`, `fleet-console`, `fleet-desktop`, `fleet-plugin`, `fleet-core`, and nests the standard changelog sections beneath each product. Existing compiled release history remains unchanged; do not rewrite historical releases merely to adopt this layout.

## Release Baseline

Classify entries against the product's public release baseline, not the order of internal PRs. Before a product's first public release, fold its implementation corrections, redesigns, packaging repairs, and release-pipeline adjustments into `Added` as part of the initially shipped product. Use `Changed` or `Fixed` only for behavior that differs from a product version users could previously consume. Describe first-release hardening as a shipped capability or quality, not as a fix to an unreleased product.

# Changelog Fragments

Follow the root `AGENTS.md` changelog rules in full: compiler-owned changelogs remain untouched; fragments use exactly one allowed section; every English bullet and Korean `ko:` line are adjacent; package tags, ASCII English, Hangul Korean, and protected tokens follow the root contract.

## Product Mapping

- `runtime/fleet-cli/**` maps to `fleet-cli`.
- `runtime/fleet-console/**` maps to `fleet-console`.
- `runtime/fleet-desktop/**` maps to `fleet-desktop`.
- `runtime/fleet-plugins/**` maps to `fleet-plugin`.
- All other `packages/**` paths map to `fleet-core`.

## Fragment Boundaries

Name each fragment `<product>-<section>.md`, with `section` one of `added`, `changed`, `fixed`, `removed`, or `breaking-changes`. The filename identifies the product only; bullets retain the root-contract package tag vocabulary.

PR boundaries do not determine fragment boundaries; product + section do. When one change spans products, split its release-facing claims by the product surface actually changed and do not duplicate the same behavior across fragments.

The fragment compiler renders new releases with product headings first, in the order `fleet-cli`, `fleet-console`, `fleet-desktop`, `fleet-plugin`, `fleet-core`, and nests the standard changelog sections beneath each product. Existing compiled release history remains unchanged; do not rewrite historical releases merely to adopt this layout.

## Release Baseline

Classify entries against the product's public release baseline, not the order of internal PRs. Before a product's first public release, fold its implementation corrections, redesigns, packaging repairs, and release-pipeline adjustments into `Added` as part of the initially shipped product. Use `Changed` or `Fixed` only for behavior that differs from a product version users could previously consume. Describe first-release hardening as a shipped capability or quality, not as a fix to an unreleased product.

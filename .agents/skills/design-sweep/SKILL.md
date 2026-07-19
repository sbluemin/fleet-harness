---
name: design-sweep
description: Periodically audit the whole fleet-console visual surface (core client styles plus every fleet-plugins CSS) for design drift — elements that visually stick out from the skeleton — by sweeping the code with concrete detector patterns, measuring the live product across all three themes, classifying findings against the design charter (channel inversion / chroma jump / theme invariance / control-grammar drift), routing material redesigns through product-proposal and pure conformance fixes to direct approval, then implementing token-first with the design contract test co-updated and shipping via pr-workflow. Use for a recurring product-wide design health check, after a large visual feature lands, or whenever the user reports that parts of the UI feel disjoint or dated; not for building a new visual feature from scratch (product-proposal) or fixing a single known CSS bug (direct fix).
---

# Design Sweep (product-wide visual audit → conformance)

Keep the fleet-console product looking like **one instrument** instead of a collage. This skill turns the accent-identity redesign cycle (PR #307) into a repeatable procedure: sweep the code for drift, confirm it visually, judge it against the design charter, and drive the approved fixes to a merged PR. It is designed for **recurring invocation** — each run re-reads the charter's living sources, so the yardstick tracks the product instead of freezing at the time this skill was written.

The value is not in running greps — it is the **charter-based judgment**: a color is not wrong because it is bright, it is wrong because it speaks on a channel it does not own. Findings without a channel/grammar diagnosis are noise.

## The design charter (the yardstick)

Living sources — always re-read these in Phase 1; the numbers below are examples current as of PR #307, not the SSoT:

- `runtime/fleet-console/core/client/src/styles/theme.css` — token vocabulary and per-theme envelopes.
- `runtime/fleet-console/tests/instrument-design-contract.test.ts` — the machine-readable charter: what is already pinned and enforced.
- `runtime/fleet-console/AGENTS.md` + doctrine comments inside `components.css` — approved exceptions and channel rules.

**Three-channel color charter.** Every color speaks on exactly one channel:

1. **Signal = state only** — `aurora` (awaiting), `warn` (turn/progress), `coral` (danger), `positive` (complete). Never used for identity, branding, or decoration (e.g. a LOCAL/NEW badge is not a state).
2. **Location/Focus = brass only** — current location, keyboard focus, hover affordance. Brass never idles at full strength ("소등" rule: no permanently lit brass ornaments).
3. **Identity = `--id-*` only** — the 8-tone theme-tuned palette (crimson/amber/moss/teal/cerulean/indigo/plum/rose), painted exclusively through the **spine+mark grammar**: left 3px spine + small nameplate mark + ~10% titlebar wash. Borders stay state-owned — `border-color: var(--user-accent)` is a hard violation. Captain colors map 1:1 onto `--id-*`; raw hex captain colors are defects.

**Control grammar.** The dominant control pattern is mono 10px 700 uppercase · min-height 34px · `--radius-xs` · brass-mix hover. Heights snap to {24, 28, 34, 44}; radius vocabulary is {`--radius-xs`, `--radius-md`, `--radius-pill` for dots/pills only}. Raw px radii and off-snap heights are drift.

**Envelopes.** The skeleton sits at very low chroma (C≈0.012–0.02); identity tones live in a per-theme chroma envelope (instrument≈0.06 / maritime≈0.085 / carbon≈0.05). Any raw color literal outside `theme.css` breaks two rules at once: it jumps the envelope and it cannot retune per theme.

**Defect taxonomy** — classify every finding as one of:

1. **Channel inversion** — a color speaking on a channel it does not own (identity on border/state, signal tokens as decoration, brass as identity).
2. **Chroma jump** — raw literals whose chroma breaks the skeleton envelope.
3. **Theme invariance** — hardcoded values that do not respond to the three-theme switch.
4. **Grammar drift** — controls deviating from the dominant pattern (typography, height snap, radius vocabulary).

## When to use

- A **periodic product-wide design health check** ("훑어보고 개선") — quarterly, after a release train, or on user request.
- **After a large feature lands** — new surfaces are the main drift inlet.
- The user reports the UI "튄다 / 따로 논다 / 올드하다" without naming a specific element.
- **NOT for**: designing a brand-new visual feature (→ `product-proposal`); a single already-diagnosed CSS bug (→ direct fix); non-visual code quality (→ `sentinel`).

## Inputs

- `<scope>` — optional. Default: full sweep (core client styles + all `runtime/fleet-plugins/*` CSS). May be narrowed to named surfaces.
- `<depth>` — `quick` (static detector sweep + report only) | `full` (adds live three-theme measurement and, when material, a mock proposal). Default `full` for periodic runs.
- `<prior_sweep>` — optional pointer to the previous sweep's report/PR, to diff drift instead of re-litigating settled exceptions.

## Workflow

### Phase 1 — Charter refresh

Re-read the living sources above. The contract test tells you what is **already enforced** (do not re-report it); doctrine comments tell you what is **intentionally exempt**. A finding that matches a commented exception (e.g. What's New section semantic chips) is not a defect — flagging it wastes the decider's attention and erodes trust in the sweep.

### Phase 2 — Static detector sweep

Run the detectors over `<scope>` — dispatch `vanguard` per surface for `full` depth (parallel, one dispatch per surface family), or run directly for `quick`:

- **Raw color literals**: `oklch\([0-9]` and hex literals in any CSS outside `theme.css` token definitions. Near-achromatic shadow/scrim/sheen literals are doctrine-sanctioned depth effects (console AGENTS.md Design invariants) — classify them out instead of reporting them. Plugins (`runtime/fleet-plugins/*`) are the historical drift reservoir — always include them.
- **Signal misuse**: `warn|aurora|positive|coral` tokens on non-state surfaces (badges, chips, avatars, identity marks, version labels).
- **Brass misuse**: brass on permanently-lit ornaments or identity roles (its only roles: location, focus, hover).
- **Identity leaks**: `--user-accent` placements — count them and compare against the contract test's pinned count; any `border-color`/glow usage is a violation.
- **Grammar drift**: `border-radius: [0-9]` raw px values; `999px` outside `--radius-pill`; control heights off the snap; non-mono/non-uppercase text on control-class elements.

Use exact-match patterns — substring greps produce false positives that poison the report (rg zero-gate rule).

### Phase 3 — Live measurement (`full` depth)

Never claim "튄다" from code alone. Use the `console-e2e` skill (invoke it — do not inline its procedure): isolated instance via `FLEET_CONSOLE_DIR`, screenshots of the affected surfaces in **all three themes** (instrument/maritime/carbon). Note: state-seeded dormant operations restore minimized — tile visible operations via live Shell launches + the formation grid button. The visual pass both confirms which static findings actually protrude and catches drift the greps cannot see (glows, gradients, spacing).

### Phase 4 — Diagnose and classify

Map every confirmed finding to the defect taxonomy with `file:line` evidence and a one-line channel diagnosis ("LOCAL chip speaks warn — a state token — for what is environment identity"). Severity order: channel inversion > envelope breaks (chroma/theme) > grammar drift. Findings that survive Phases 2–3 with evidence go in; speculation does not.

### Phase 5 — Route by weight

- **Material redesign** (new tokens, new grammar, user-visible identity change, anything the user must *see* to judge): route through the `product-proposal` skill — interactive mock in real tokens, options, ★ recommendation. The direction call stays with the user.
- **Pure conformance** (bringing deviants onto the existing charter with no new grammar): present the classified fix list and proceed on approval — a mock adds nothing when the target state is already codified.

Do not start implementation before the user picks a direction.

### Phase 6 — Implement (after approval)

- Work in a canary-based worktree via the `git-worktree` skill. If canary introduced new packages since the last install, run `corepack pnpm install` in the worktree first (plugin bundles fail to resolve otherwise).
- **Token-first**: add/adjust tokens in `theme.css` base `:root`, retune in each theme variant block. **No CSS comments inside theme variant blocks** — the contract test's declaration matcher treats them as declarations and fails; comments belong in base `:root` only.
- **Schema stability**: for persisted keys (accents, group colors), prefer a read-side legacy mapping (`normalizeAccentKey`/`LEGACY_ACCENT_KEYS` pattern) over a durable-schema migration; keep write-side accepting legacy keys.
- **Co-update the contract test**: `instrument-design-contract.test.ts` is a living contract, not an obstacle — when the grammar legitimately changes, update the pinned counts, block assertions, and token whitelist regex *with* the change. Making the old pins pass without moving the contract is the defect, not the fix.
- **Plugin CSS**: `var()`/`color-mix` only — never introduce a new raw literal while removing an old one.

### Phase 7 — Verify and ship

- Build (tsc — vitest alone does not typecheck) + fleet-console tests + **each touched plugin's own test runner** (fleet-console green ≠ plugin green).
- **Headed visual verification gate before delivery**: compare the result against the approved mock/시안 in all three themes with screenshot evidence; if token cohesion falls short or default form styles survive, polish before handing over.
- Ship via the `pr-workflow` skill. Changelog note: the fragment tag allowlist has no `fleet-plugin` tag — plugin-visible changes go under a `### fleet-plugin` product heading with a `[fleet-console]` tag (established precedent).

## Must not

- Do not implement before the user picks a direction (Phase 5 is a hard gate).
- Do not report a doctrine-approved exception as a defect, and do not "fix" one.
- Do not repaint identity onto signal/border channels or land a new raw literal as part of a conformance fix.
- Do not weaken or bypass the design contract test to get green — move the contract with the grammar or stop.
- Do not claim visual conformance without themed screenshot evidence.

## Gotchas (paid for in the field)

- **Variant-block comments kill the contract test** — its declaration matcher (`^\s{2}[^\n:]+:`) reads a comment line as a malformed declaration. Comments in base `:root` only.
- **Pinned counts are part of the grammar** — e.g. `--user-accent` occurrences in `components.css` are counted exactly; adding a legitimate new identity surface means updating the count *and* the block assertions together.
- **Doctrine exceptions live as CSS comments** — search `components.css` for doctrine comments near a finding before flagging it.
- **Seeded ops restore minimized** in console-e2e state seeding; visual tiling needs live launches, not seeds.
- **Worktree cwd resets between Bash calls** — verify `pwd` before every build/test command; a build run in the main checkout silently validates the wrong tree.
- **Proportionality**: `quick` depth is a report, not a repaint — resist expanding a periodic check into an unapproved redesign.
- Output language follows the session working language; token names, file paths, and grammar terms stay as-is.

## Carrier delegation

- `vanguard` — Phase 2 detector sweeps (parallel per surface family) and code recon behind a measured behavior.
- `genesis` — Phase 6 multi-file conformance batches, unless the user directs direct execution.
- `sentinel` — post-implementation review of the changed CSS + contract test.
- `console-e2e`, `product-proposal`, `git-worktree`, `pr-workflow` — invoked as skills at their phases; never inline their procedures (one home per procedure).

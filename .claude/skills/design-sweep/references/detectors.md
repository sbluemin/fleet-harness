# Design drift detection and classification

## The design charter (the yardstick)

Living sources — read these for the target scope; the historical examples below are detector leads, not current acceptance thresholds. Verify every token, count, dimension, and exception against these sources before classifying a defect:

- `runtime/fleet-console/core/client/src/styles/theme.css` — token vocabulary and per-theme envelopes.
- `runtime/fleet-console/tests/instrument-design-contract.test.ts` — the machine-readable charter: what is already pinned and enforced.
- `runtime/fleet-console/CLAUDE.md` + doctrine comments inside `components.css` — approved exceptions and channel rules.

**Three-channel color charter.** Every color speaks on exactly one channel:

1. **Signal = state only** — `aurora` (awaiting), `warn` (turn/progress), `coral` (danger), `positive` (complete). Never used for identity, branding, or decoration (e.g. a LOCAL/NEW badge is not a state).
2. **Location/Focus = brass only** — current location, keyboard focus, hover affordance. Brass never idles at full strength ("lights-out" rule: no permanently lit brass ornaments).
3. **Identity = `--id-*` only** — the 8-tone theme-tuned palette (crimson/amber/moss/teal/cerulean/indigo/plum/rose), painted exclusively through the **spine+mark grammar**: left 3px spine + small nameplate mark + ~10% titlebar wash. Borders stay state-owned — `border-color: var(--user-accent)` is a hard violation. Identity tones map 1:1 onto `--id-*`; raw hex identity colors are defects.

**Control grammar.** The dominant control pattern is mono 10px 700 uppercase · min-height 34px · `--radius-xs` · brass-mix hover. Heights snap to {24, 28, 34, 44}; radius vocabulary is {`--radius-xs`, `--radius-md`, `--radius-pill` for dots/pills only}. Raw px radii and off-snap heights are drift.

**Envelopes.** The skeleton sits at very low chroma (C≈0.012–0.02); identity tones live in a per-theme chroma envelope (instrument≈0.06 / maritime≈0.085 / carbon≈0.05). Any chromatic raw literal outside `theme.css` breaks two rules at once: it jumps the envelope and it cannot retune per theme; near-achromatic shadow/scrim/sheen depth literals are the sanctioned exception (console CLAUDE.md Design invariants).

**Defect taxonomy** — classify every finding as one of:

1. **Channel inversion** — a color speaking on a channel it does not own (identity on border/state, signal tokens as decoration, brass as identity).
2. **Chroma jump** — raw literals whose chroma breaks the skeleton envelope.
3. **Theme invariance** — hardcoded values that do not respond to the three-theme switch.
4. **Grammar drift** — controls deviating from the dominant pattern (typography, height snap, radius vocabulary).

### Phase 2 — Static detector sweep

Run the detectors over `<scope>` — for `full` depth, sweep each surface family (in parallel when useful); for `quick`, run directly:

- **Raw color literals**: `oklch\([0-9]` and hex literals in any CSS outside `theme.css` token definitions. Near-achromatic shadow/scrim/sheen literals are doctrine-sanctioned depth effects (console CLAUDE.md Design invariants) — classify them out instead of reporting them. Plugins (`runtime/fleet-plugins/*`) are the historical drift reservoir — always include them.
- **Signal misuse**: `warn|aurora|positive|coral` tokens on non-state surfaces (badges, chips, avatars, identity marks, version labels).
- **Brass misuse**: brass on permanently-lit ornaments or identity roles (its only roles: location, focus, hover).
- **Identity leaks**: `--user-accent` placements — count them and compare against the contract test's pinned count; any `border-color`/glow usage is a violation.
- **Grammar drift**: `border-radius: [0-9]` raw px values; `999px` outside `--radius-pill`; control heights off the snap; non-mono/non-uppercase text on control-class elements.

Use exact-match patterns — substring greps produce false positives that poison the report (rg zero-gate rule).

### Phase 4 — Diagnose and classify

Map every confirmed finding to the defect taxonomy with `file:line` evidence and a one-line channel diagnosis ("LOCAL chip speaks warn — a state token — for what is environment identity"). Severity order: channel inversion > envelope breaks (chroma/theme) > grammar drift. Findings that survive Phases 2–3 with evidence go in; speculation does not.

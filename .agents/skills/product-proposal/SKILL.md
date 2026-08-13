---
name: product-proposal
description: From a PO/PD lens, take a fleet-console product-improvement or new-feature request, measure the current behavior live through the console-e2e skill to pin it as fact, separate the user's named solution (surface) from the real Job-to-be-done (essence), derive UX options scored on fixed trade-off axes, then build an interactive mock in the product's real design tokens via the frontend-design skill, and report a decision-ready proposal. Use whenever a fleet-console feature request, issue, or complaint is vague — or names a specific fix that needs essence-checking — and must become a decision-ready proposal grounded in measurement and a visual mock rather than guesswork. Implementation is out of scope.
---

# Product Proposal (PO/PD · measured + visual)

Turn a vague product ask into a decision-ready proposal for the **fleet-console** product. The value is NOT in calling `console-e2e` and `frontend-design` — it is the **judgment wedged between them**: measure before claiming, solve the problem rather than the named fix, and let the decider touch the options before committing a line of code.

This skill **orchestrates two existing skills** — `console-e2e` (real-browser measurement; lives in this repo's `.agents/skills`) and `frontend-design` (the interactive mock; an Anthropic plugin skill, not vendored in this repo — the same way `console-e2e` itself depends on the external `playwriter` skill) — and adds the PO/PD reasoning that connects them. Read each skill's full docs when you reach its phase, and **invoke them as skills — do not inline or duplicate their procedures** (one home per procedure; SSoT). If `frontend-design` is unavailable in the environment, that is a missing-dependency condition to report, not a reason to vendor a copy of its workflow here. This skill only adds the connective judgment on top.

## When to use

- A fleet-console **product improvement or new feature** where "how should we provide this?" is the open question.
- A request / issue / complaint that is **vague**, OR that **names a specific solution** (e.g. "add a checkbox") which should be essence-checked before it is built.
- **Before implementation** — when a direction must first become a decision-ready, visual form.
- **NOT for**: an already-decided implementation (→ implement, then `pr-workflow`); a pure runtime bug diagnosis (→ `console-e2e` alone); code review; architecture arbitration.

## The three commitments (the skill's spine)

These are the reason the skill exists. Without them it degrades into "a guide for calling two other skills."

1. **Measure, don't guess.** Pin "how it works today" with a live `console-e2e` reading — counts, screenshots, HTTP codes — cross-checked against the code. Ban "probably / likely / I think" in the present-state findings.
2. **Solve the essence, not the surface.** Separate the solution the user *named* from the problem they *feel* (Job-to-be-done). The named fix is a hypothesis, not the spec. (Field example: a request for a "close confirmation checkbox" whose real pain was "an accidental close is hard to recover" — the essence pointed at undo/guard, not literally a checkbox.)
3. **Make the options touchable.** Render the options as an interactive mock in the product's **real tokens** so the decider compares by feel, not by prose.

## Inputs

- `<requirement>` — the request / issue / complaint (issue number or free text). Record any **user-named solution verbatim**.
- `<surface>` — affected console surface(s), if known (else discover via recon).
- `<depth>` — `quick` | `full` (optional). Scale option count and measurement breadth to the ask (proportionality).

## Workflow

### Phase 1 — Capture the ask & state the surface

- Freeze the requirement in one **verbatim** line.
- **Separately record** the user-named solution (if any) and the underlying discomfort — they are not the same, and Phase 3 depends on this split being explicit.
- Provisionally name the affected surface(s); confirm in Phase 2.

### Phase 2 — Measure the present (console-e2e + recon)

- Use the `console-e2e` skill to boot an **isolated** instance and measure current behavior in a real browser.
  - **Never restart the user's console daemon.** Isolate with `FLEET_CONSOLE_DIR`; confirm the served bundle hash matches your build.
  - Seed **dormant Operations** (via a pre-written `state.json`; each restored op needs a `providerSession`) to inspect the UI without spawning real CLIs or auth.
- When the path or constraints matter, map the code and **cross-check** the measurement against the implementation (file:line evidence).
- Output: a list of **measured facts** — "today it does X" — each with evidence (count, screenshot, HTTP status, `file:line`). Speculation is not permitted in this phase.

### Phase 3 — PO/PD review

- Split **surface vs essence**: what the user named vs the root cause of the pain (Job-to-be-done).
- Derive UX options from a pattern catalogue — prevention / confirm dialog / undo toast / recover-bin / settings toggle / two-step arming / … — picking what fits, not all of them.
- Score every option on **fixed trade-off axes**: friction · discoverability · accessibility · implementation cost · product consistency · recovery guarantee.
- **Pre-check each option against product design doctrine** (`runtime/fleet-console/AGENTS.md` — token color roles, motion bans, `prefers-reduced-motion` short-circuit, "no user-accent in signal channels", etc.) so a recommended option is never doctrine-illegal.

### Phase 4 — Build the mock (frontend-design)

- Use the `frontend-design` skill to build an interactive HTML mock in the product's **real tokens** (Maritime Console `theme.css` real values), not generic AI styling.
- Per option: a working demo + strengths / trade-offs / data-risk + a ★ recommendation + a synthesis (`synth`) block with a phased rollout.
- Verify it renders in a real browser via a static server and a **new** page.
  - A stale `state.page` may have drifted to the user's own tab — print the URL, open a fresh `context.newPage()` for your port, and leave the user's tab untouched.
- **Match mock copy to the product's language environment** — the console UI is English, so labels are English (a placeholder in another language is a defect to fix, not to ship).

### Phase 5 — Report

- Report in order: **measured facts → PO/PD review → mock → recommendation**.
- Provide a **live URL** so the decider can touch the mock.
- Propose the next steps (implement → `console-e2e` QA → `pr-workflow`) but **leave the product-direction call to the user** — this skill ends at a decision-ready proposal, not a decision.

## Must not

- **Do not implement.** Stop at the proposal; implementation and `pr-workflow` come after the user picks a direction.
- **Do not make the final product-direction decision.** Produce a decision-ready form only — the direction is the user's.
- **Do not assert current behavior from guesswork.** Present-state claims must be `console-e2e` measurements with evidence.

## Gotchas (paid for in the field)

- **Isolated instance only**: never `restart` / `stop` the user's console daemon; launch a throwaway with `FLEET_CONSOLE_DIR` (its own lock + random port) and seed dormant Operations for auth-free UI checks. Only ops carrying a `providerSession` are restored.
- **playwriter tab drift**: after idle time `state.page` may point at the user's tab — print the URL, open a `context.newPage()` for your isolated port, never `bringToFront` / close the user's tabs.
- **`-e` ~10s cap**: split arm→act→probe chains that exceed it into separate calls; a single timing-dependent interaction (arm, wait, second action) must run inside one `evaluate` to avoid auto-reset between calls.
- **Mock language**: write mock copy in the product's UI language (English for the console).
- **Proportionality**: a small ask → fewer options and a lighter measurement; "audit / be thorough" → the full option pool and a deeper measurement.
- **Output language** follows the session working language; functional identifiers (skill ids, token keys) stay as-is.

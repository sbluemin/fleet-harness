---
name: learning-harvest
description: After substantive work, run a compounding-engineering learning-harvest loop — retrospect the task, extract reusable learnings under a three-condition gate (recurrence, cost, generality), route each to its single best persistent home (an AGENTS.md rule, a new or edited skill, a test, a wiki-history ADR, persistent memory, or a skill's gotchas), encode it as "symptom -> action -> why", and prune weak or stale rules. Propose candidates for the Admiral of the Navy's approval and encode only approved ones, so the next task starts from a higher baseline. Use at the end of substantive work, when friction is detected, or on a periodic pruning pass. This is a meta-skill that produces other skills and assets, not product code.
---

# Learning Harvest (compounding engineering)

Funnel the **byproducts** of a finished task — the friction, the discoveries, the judgment calls — into persistent artifacts, so the next task starts from a higher baseline. The first-order output is the code/result you shipped; the second-order output this skill harvests is the reusable learning. **Compounding is positive only when signal accumulates faster than noise** — so the gate (what to keep) matters as much as the capture.

This is a **meta-skill**: its product is other skills, rules, tests, ADRs, or memories — not application code. (This repo's `product-proposal` skill was one harvest of the issue-#108 session; `learning-harvest` generalizes that act of distilling a session into a reusable asset.)

## When to use

- **End of substantive work** — the default trigger. After a feature / fix / refactor / investigation lands, before moving on.
- **Friction detected** — something took unexpected time or tripped a trap; reverse-engineer the rule that would have made it trivial.
- **Periodic pruning** — audit a persistent-output surface to delete weak or stale rules.
- **Skill self-review** — the skills you invoked this task are first-class harvest targets: sharpen a skill you used (a missing gotcha, an inaccurate step, a stale boundary), or spawn a new skill when a recurring procedure has no home. See "Improve the skills you used" below.
- **NOT for**: trivial one-off work with nothing generalizable; capturing speculation (encode only what was proven); restating what the code or git history already records.

## Trigger discipline (skill + self-trigger)

Invoked explicitly (`/learning-harvest`) OR **self-triggered by the Admiral at the end of substantive work** — propose the harvest without being asked. It is deliberately **not** an automatic task-end hook; that hook is a possible next step, not the current contract. Keep the proposal short, and gate it on Admiral approval before encoding anything.

## The harvest loop (four stages)

### Stage 1 - Extraction (what to keep)

A candidate survives ONLY if all three hold (AND gate):

- **Recurrence** - will this situation recur? (one-off accidents are discarded)
- **Cost** - was the obstacle genuinely nontrivial or time-consuming?
- **Generality** - does it generalize beyond this single instance?

Fail any one -> discard. Few strong learnings beat many weak ones.

### Stage 2 - Residency (where it lives - one home, no duplication)

Route each kept learning to its single best home:

| Learning type | Fleet home (SSoT) | Retrieved when |
|---|---|---|
| Unchanging rule for a scope | `AGENTS.md` / `CLAUDE.md` in that scope | working in that scope |
| "How to do X" procedure | a **new skill** (`.agents/skills/<name>/SKILL.md`) or a section in an existing skill | X is invoked |
| Reusable gotcha for an existing procedure | that skill's **Gotchas** section | running that skill |
| Specific bug / regression | a **test** | every build |
| Decision rationale (the "why") | `wiki-history` skill / Fleet Wiki ADR | reversing the decision |
| User preference / working feedback | **persistent memory** (`feedback` / `project` / `user`) | relevant recall |

- **One home per fact, no duplication** - the same fact in two places rots in both.
- **Migration** - if a better home emerges later, move the fact and delete the old copy.
- Before encoding, **check existing homes for a duplicate** and prefer editing over adding.

### Stage 3 - Encoding (how to write it)

Never write the bare conclusion. Use:

> **`symptom -> action -> why (failure mode)`**

The "why" preserves context so a future reader can adapt when circumstances shift, instead of cargo-culting the rule. Keep it minimal and scannable.

### Stage 4 - Pruning (maintenance - paired with encoding)

On a pruning pass, or whenever you touch a crowded surface, flag items that are stale, false, or weak: **keep / update / delete** with a one-line reason. **Encoding without pruning is debt** — few strong rules beat many weak ones.

## Improve the skills you used (the meta-recursion)

The skills you invoked while doing the task are **first-class harvest targets** — this is the loop turned on itself. After substantive work, list the skills you ran (e.g. `console-e2e`, `pr-workflow`, `git-worktree`) and ask of each:

- **Sharpen an existing skill** — did it cost you a gotcha it should have warned about, a step that was inaccurate, or a boundary that was wrong or missing? If so, encode the fix **into that skill** — its Gotchas / Workflow / Must-not section is the SSoT home. A trap you hit once will hit the next run unless the skill itself carries the warning.
- **Spawn a new skill** — did you perform a non-trivial, repeatable procedure that has **no** skill home? If it clears the three-condition gate, propose a new skill (this repo's `product-proposal` and `learning-harvest` were both born this way).

Both paths obey the same guards: propose-then-approve, validate-before-encode, and SSoT (edit the one skill, never fork a copy). Skills are prompt-policy, so they carry the **highest overfitting risk** — a single incident is not yet a rule; weigh recurrence and generality hardest before touching one. A skill change is a code change: route it through the normal pipeline (worktree -> edit -> `pr-workflow`).

## Guards (do not skip)

1. **Propose, then approve** - surface candidates; the Admiral of the Navy approves; encode only approved items. No silent auto-encoding.
2. **Validate before encoding** - encode only what the work proved, never speculation.
3. **SSoT + migration** - one home per fact; migrate, do not duplicate.
4. **Pruning is mandatory** - encoding and deletion are a pair.
5. **Preserve the reasoning chain** - always the "why", not just the rule.
6. **Mechanism > procedure > note** - prefer the most-actionable layer: a test (auto-checked) > a script/hook (auto-run) > a skill procedure > a prose note. If a lower layer is impossible, say why.
7. **Overfitting is the main risk** - the three-condition gate plus propose-approve exist to stop a single incident from becoming a false general rule. Prompt / doctrine / `AGENTS.md` edits carry the highest overfitting risk; weigh them hardest.

## Workflow

1. **Retrospect** - recall the task's friction, discoveries, and judgment calls, AND list the skills you invoked this task — each skill is a candidate for sharpening (see "Improve the skills you used").
2. **Extract** - apply the three-condition gate; drop what fails.
3. **Route** - assign each survivor a single home (Stage 2 table); check for an existing duplicate first.
4. **Draft encodings** - write each as `symptom -> action -> why` at the most-actionable layer.
5. **Propose** - present candidates as: one-line summary - extraction judgment (the three conditions) - home + why - encoding phrasing - any duplicate found. Await Admiral of the Navy approval.
6. **Encode approved** - apply each to its home (edit a skill / `AGENTS.md`, add a test, write a memory, register a `wiki-history` ADR). A new procedure skill or a multi-file change routes through the normal pipeline (worktree -> implement -> `pr-workflow`).
7. **Prune (optional)** - if a touched surface is crowded, flag weak or stale items for removal.

## Must not

- Do not encode without Admiral of the Navy approval (propose-then-approve).
- Do not duplicate a fact across homes - migrate instead.
- Do not encode speculation or a one-off accident (three-condition gate).
- Do not re-record what code or git history already captures - capture the non-obvious "why".

## Delegation

- `vanguard` - confirm where a candidate's home already exists (avoid duplication).
- An approved encoding that is a code or skill change routes through `genesis` and `pr-workflow`; a pure memory write the Admiral does directly.

## Relationship to other assets

- **Persistent memory** is one home in the residency table, not a competitor - this skill decides *whether* a learning belongs in memory vs a skill vs a test vs `AGENTS.md`.
- **`product-proposal`** is a domain skill this meta-skill can *produce* - it was harvested from the issue-#108 session.
- **`wiki-history`** is the home for decision rationale (ADRs); **`clean-code`** / pruning passes are where Stage 4 deletions happen.

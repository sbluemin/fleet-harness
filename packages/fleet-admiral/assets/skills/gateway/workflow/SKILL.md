---
name: workflow
description: Run a staged multi-agent operation — map a stage skeleton onto the workflow execution surface, choose pipeline or barrier between stages, keep failures visible, and assign each stage its model and reasoning effort. Load before executing any skeleton from architecture-review, codebase-research, implementation-run, or quality-review, and before pinning a model or effort anywhere. Skip when the work is one stage you will perform directly.
---

# Workflow

The other gateway skills each own the *shape* of a run — which stages exist, what each returns, where the judgment stays on the host. This skill owns **turning that shape into an actual run**: the surface it executes on, how stages are wired to each other, and what each stage runs on.

A skeleton that is never executed as stages is not a cheaper version of the run. It is a single reader doing every job in one context, which is the failure mode the skeleton exists to prevent.

## Execution Surface

Staged execution requires the workflow execution surface — the one that runs a script of stages, wires them together, and lets each stage carry its own model and effort. Inspect the live tool surface before concluding anything about it; tools may be lazy-loaded.

**A surface gated behind user opt-in is unavailable until that opt-in exists.** Some workflow surfaces refuse to run unless the user explicitly asked for a multi-agent run. That refusal is not a defect and it is not a reason to quietly do the whole thing yourself in one context. Report the gate, say what the staged run would cost and what it would buy, and wait — the same way you would report any unavailable surface.

Two things stay out of this skill on purpose:

- **Call mechanics.** Argument names, script syntax, return shapes, and which values a field accepts live in the live tool description. Read them there every time. Anything restated here would be a copy that goes stale silently.
- **Whether to run at all.** That is the Orchestration Policy Standing Order's call, not this skill's.

## Reading a Stage Skeleton

Every gateway skeleton is a table of `Stage | Role | Fan | Returns`. Read it as an execution plan:

- **Role** is the one-word job — map, propose, implement, verify, synthesize, transform. It is also the input to model assignment below.
- **Fan** is how many parallel branches that stage runs. `1` is one branch. `one per <item>` is a fan-out sized by the previous stage's output, not by a number you pick. **`host only` is not a stage you dispatch** — it is a barrier where you do the work yourself, and dispatching it defeats the skeleton.
- **Returns** is the contract. When a stage returns structured data, declare the schema rather than parsing prose; a stage that must fill a shape will retry against it, while a stage asked to write prose will improvise.

## Pipeline by Default

Between two stages, the choice is pipeline or barrier, and **pipeline is the default**.

A barrier — waiting for every branch of stage N before starting stage N+1 — is correct only when stage N+1 genuinely needs the whole set at once: deduplicating across all results before expensive downstream work, deciding literals every later branch must share, early-exit when the total is zero, or a prompt that compares one result against the others.

A barrier is **not** justified by needing to flatten, map, or filter between stages — do that inside a stage — nor by the stages feeling conceptually separate, nor by the script reading more cleanly. Each unjustified barrier costs the difference between the slowest branch and the fastest, on every item, for nothing.

Each skill's skeleton already names its own barriers, and they are the load-bearing part of that shape. `implementation-run`'s Decide barrier and `quality-review`'s Adjudicate barrier are the two places the run stops being parallel because a single decision must exist before anything downstream. Do not optimize them away.

## Failures Must Be Loud

Fan-out helpers routinely turn a failed branch into an empty result rather than an error. A run that lost three of eight branches then looks like a run that found less, which is indistinguishable from a thorough run over a quiet subject.

- Have each stage **return its failure as a value** — a result that says it failed and why — instead of throwing into the helper.
- Before synthesizing, check the branch count against what you dispatched. A missing branch is a finding.
- Never report coverage you did not verify. If the run capped, sampled, or dropped anything, say so in the report; silent truncation reads as completeness.

## Model and Effort Assignment

Inheriting the session model is the default and needs no justification. Pinning carries the burden of proof — the binding rule is in the Orchestration Policy Standing Order. This is the procedure that discharges it.

Work through these in order. Steps 3 and 4 are the gate; the rest exist to make them answerable.

1. **Name the role.** Take it from the skeleton's Role column. If you cannot name it in one word, the stage boundary is wrong; fix the split before choosing a model.
2. **Name the dominant risk.** What would ruin *this* stage: too little context, unreliable tool use, correlated judgment, drift from repository convention, or incomplete coverage. One risk, not a list.
3. **Decide whether to pin.** Does some model withstand that specific risk *structurally* better than the session model? No, or unsure → inherit. **Unsure is not a reason to pin.**
4. **Write the reason.** One sentence. If you cannot write it, you have not earned the pin. Put the sentence in the run's progress record so the choice can be judged afterwards.
5. **Check the allowance.** Read the window matching the model's own pool. If it is short, take the next-best fit and record that you substituted.
6. **Diversify only where disagreement is the product.** A majority-vote or judging stage wants different lineages. A model sharing the session model's lineage adds no independence there — though it is the cleanest way to move spend off that allowance.
7. **Resolve the roster before pinning.** A model the user turned off still executes when pinned, so pinning it overrides that choice without raising an error. `400 unknown model` means re-read the roster; `502 resource_exhausted` means that pool is spent — switch pools or providers rather than retrying.
8. **Never pin the load-bearing stage.** When everything downstream rests on one stage's output — the contract survey, the final synthesis, the integrating judgment — inherit.

### What Measurement Actually Showed

Three gateway models were measured against seven stage roles on 2026-08-02. They were **indistinguishable on five of them**: structured output, repository search, adversarial judgment, mechanical transformation, and a small implementation task. Treat that as the prior. The roster declares fit on the two axes that did separate, and reports `null` everywhere else — `null` means unmeasured, never unsuitable.

### Rules That Measurement Refuted

- **A larger context window does not mean better reading.** Asked to map a 22-file subsystem, the 1M-window model opened 16 files and a 372k-window model opened all 22. What separated them was thoroughness in tool use, which no catalog field predicts. Use the window as a floor — can this model hold the input at all — not as a ranking.
- **Raising effort does not reliably improve judgment.** The same verification task at the lowest and highest rungs produced the same verdict with equal reasoning quality. Effort pays only once a task is hard enough to need it; raising it by habit buys nothing and costs throughput.
- **A local, well-precedented edit does not need the session model.** Every model tested landed the change in the right files, found the package's existing export pattern instead of inventing one, and matched the surrounding comment language. This does **not** generalize to sweeping or multi-package work, where convention drift compounds and goes unseen.

### Handing Work to a Different Model

A stage running on another model has no feel for this repository's conventions, so decisions must travel as literal values, not as descriptions. Name the exact token, path, setting key, or constant; never write "match the existing style" or "pick something consistent". On return, check the artifacts against the literals you sent — an equivalent-looking substitution is a defect, not a variation.

## Gotchas

- **Symptom:** A run that pinned several models produced uniform-looking results, or one stage's output is missing with no error.
  **Action:** Check whether that branch failed rather than ran. Confirm each pinned id is still in the roster and return branch failures as values instead of letting the helper collapse them.
  **Why:** A de-selected or mistyped id fails at the gateway, but the fan-out helper turns a failed branch into an empty slot, so a heterogeneous run silently becomes a partial one.

- **Symptom:** A stage ran at a different reasoning level than the one requested.
  **Action:** Read that model's ladder from the roster and request a level it actually advertises.
  **Why:** Ladders are not uniform — some models have no `medium`, others no effort control at all — and an off-ladder level is clamped upstream without any signal.

- **Symptom:** A provider looked like it had room, but its requests began failing as exhausted.
  **Action:** Read the window whose pool matches the model, not the provider's combined figure.
  **Why:** One subscription can bill through separate pools; the sum can read comfortable while the pool a given model draws from is nearly spent.

- **Symptom:** The run took as long as doing it yourself, with the same total cost.
  **Action:** Count the barriers. Each one that no stage actually needed becomes wall-clock spent waiting for the slowest branch.
  **Why:** Staging buys overlap; a skeleton executed as a sequence of barriers pays the coordination cost and collects none of it back.

- **Symptom:** A stage came back asking what to do, or made a choice the skeleton reserved for the host.
  **Action:** Move that decision to the preceding host-only barrier and re-dispatch with the value spelled out.
  **Why:** A stage handed an open decision always closes it, differently in each branch — which is the failure the barrier was placed there to prevent.

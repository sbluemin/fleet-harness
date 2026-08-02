---
name: model-loadout
description: Assign a model and reasoning effort to each stage of a multi-agent run. Load before authoring a workflow that pins either, or when deciding whether pinning is warranted at all. Skip when every stage will inherit the session model.
---

# Model Loadout

This skill owns how a stage's model and effort are chosen. The binding rule — inheriting is the default, pinning carries the burden of proof — is in the Delegation Policy Standing Order. Call mechanics and argument names stay in the live tool descriptions; read them there, not here.

## Reasoning Procedure

Work through these in order. Steps 3 and 4 are the gate; the rest exist to make them answerable.

1. **Name the role.** Say what the stage *does* in one word — map, propose, implement, verify, synthesize, transform. If you cannot name it, the stage boundary is wrong; fix the split before choosing a model.
2. **Name the dominant risk.** What would ruin *this* stage: too little context, unreliable tool use, correlated judgment, drift from repository convention, or incomplete coverage. One risk, not a list.
3. **Decide whether to pin.** Does some model withstand that specific risk *structurally* better than the session model? No, or unsure → inherit. **Unsure is not a reason to pin.**
4. **Write the reason.** One sentence. If you cannot write it, you have not earned the pin. Put the sentence in the run's progress record so the choice can be judged afterwards.
5. **Check the allowance.** Read the window matching the model's own pool. If it is short, take the next-best fit and record that you substituted.
6. **Diversify only where disagreement is the product.** A majority-vote stage wants different lineages. A model sharing the session model's lineage adds no independence there — though it is the cleanest way to move spend off that allowance.
7. **Make failure loud.** Fan-out helpers swallow a failed branch as an empty result, so return failures as values. `400 unknown model` means re-read the roster; `502 resource_exhausted` means that pool is spent — switch pools or providers rather than retrying.
8. **Never pin the load-bearing stage.** When everything downstream rests on one stage's output — the contract survey, the final synthesis, the integrating judgment — inherit.

## What Measurement Actually Showed

Three gateway models were measured against seven stage roles on 2026-08-02. They were **indistinguishable on five of them**: structured output, repository search, adversarial judgment, mechanical transformation, and a small implementation task. Treat that as the prior. The roster declares fit on the two axes that did separate, and reports `null` everywhere else — `null` means unmeasured, never unsuitable.

## Rules That Measurement Refuted

- **A larger context window does not mean better reading.** Asked to map a 22-file subsystem, the 1M-window model opened 16 files and a 372k-window model opened all 22. What separated them was thoroughness in tool use, which no catalog field predicts. Use the window as a floor — can this model hold the input at all — not as a ranking.
- **Raising effort does not reliably improve judgment.** The same verification task at the lowest and highest rungs produced the same verdict with equal reasoning quality. Effort pays only once a task is hard enough to need it; raising it by habit buys nothing and costs throughput.
- **A local, well-precedented edit does not need the session model.** Every model tested landed the change in the right files, found the package's existing export pattern instead of inventing one, and matched the surrounding comment language. This does **not** generalize to sweeping or multi-package work, where convention drift compounds and goes unseen.

## Handing Work to a Different Model

A subagent on another model has no feel for this repository's conventions, so decisions must travel as literal values, not as descriptions. Name the exact token, path, setting key, or constant; never write "match the existing style" or "pick something consistent". On return, check the artifacts against the literals you sent — an equivalent-looking substitution is a defect, not a variation.

## Gotchas

- **Symptom:** A fan-out that pinned several models produced uniform-looking results, or one stage's output is missing with no error.
  **Action:** Check whether that branch failed rather than ran. Confirm each pinned id is still in the roster and return branch failures as values instead of letting the helper collapse them.
  **Why:** A de-selected or mistyped id fails at the gateway, but the fan-out helper turns a failed branch into an empty slot, so a heterogeneous run silently becomes a partial one.

- **Symptom:** A model ran at a different reasoning level than the one requested.
  **Action:** Read that model's ladder from the roster and request a level it actually advertises.
  **Why:** Ladders are not uniform — some models have no `medium`, others no effort control at all — and an off-ladder level is clamped upstream without any signal.

- **Symptom:** A provider looked like it had room, but its requests began failing as exhausted.
  **Action:** Read the window whose pool matches the model, not the provider's combined figure.
  **Why:** One subscription can bill through separate pools; the sum can read comfortable while the pool a given model draws from is nearly spent.

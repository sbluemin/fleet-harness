# Dispatch surfaces and in-flight conduct

The delegation skill derives the graph; this file owns which surface executes it and how the host behaves between dispatch and result. Call mechanics — argument names, script syntax, accepted values, opt-in triggers — belong to each surface's live tool description; read them there every time, and inspect the live surface before concluding anything, since tools may be lazy-loaded.

## Choosing a surface

| Surface | What it buys | Reach for it when |
|---|---|---|
| **One agent dispatch** | one bounded result, returned whole | **the default** — the parts need no wiring between them |
| **A continued agent** | a worker addressable again with its context intact | one worker must carry several exchanges |
| **The Workflow tool** | wiring: data between stages, barriers, fan-out, deterministic control flow across branches | that wiring is the point |

- **Wiring is the only thing the staged surface buys.** A staged run for work that needed one dispatch pays the coordination cost and collects none of it back, and a skeleton never executed as stages is one reader doing every job in one context — the failure the skeleton exists to prevent.
- **A surface gated behind user opt-in is unavailable until the opt-in exists.** The trigger belongs to the harness and its live tool description, not to Fleet. A closed gate is not a defect: report what the staged run would cost and buy, and wait — do not quietly do the staged work in one context instead.

## Barrier economics

The live tool's own examples already default to pipelining stages into each other; what stays here is the judgment. A barrier — a point where every branch must finish before anything continues — is justified only when the next stage genuinely needs the whole set at once: deduplicating before expensive downstream work, deciding literals every branch shares, early-exit on zero, or comparing results against each other. Flattening, mapping, or filtering between stages happens inside a stage; "conceptually separate" and "the script reads cleaner" justify nothing. Each unjustified barrier costs the gap between the slowest and fastest branch, on every item. Two barriers are load-bearing and stay: the host-side literal fix before any writing fan, and host adjudication after verification.

## A receipt is not a result

Some surfaces hand the result back at once; a background dispatch returns a receipt — a run id that says work started and carries no finding, no verdict, no coverage. Nothing in the returned value's shape marks which of the two you are holding; only the surface does.

- **The dispatching turn ends in one line** — which surface, how many branches, what you are waiting for. No conclusion, no review, and no forecast of what the run will probably find: a reading written before the result is indistinguishable from the result to whoever reads it, and it stays on the page after the real one arrives.
- **Report once, in the turn the result lands.** The dispatching turn already spent its line; saying it there and again on arrival turns one run into two answers.
- **Asked while it runs, say it is still running.** That is the entire answer.

## Failures must be loud

A fan-out helper turns a failed branch into an empty result, so a run that lost three of eight branches reads as a thorough run over a quiet subject.

- Have each branch return its failure as a value, not throw into the helper.
- Check the returned branch count against what was dispatched before synthesizing. A missing branch is a finding.
- Never report coverage you did not verify; say so when the run capped, sampled, or dropped anything. The delegation skill's evaluation rules own acceptance — this is what makes them checkable.

## Gotchas

- **Symptom:** A review of the run landed before the run finished, and when the result arrived the same ground was covered a second time.
  **Action:** Treat the dispatch's return as a receipt; the finding waits for the turn the result lands in.
  **Why:** Both a receipt and a result come back through the same return, and reading the receipt as a result costs twice — once for the invented finding, once for the duplicate that follows it.

- **Symptom:** The staged run took as long as doing the work directly, at the same total cost.
  **Action:** Count the barriers; each one no stage actually needed became wall-clock spent waiting for the slowest branch.
  **Why:** Staging buys overlap, and a skeleton executed as a sequence of barriers pays the coordination cost and collects none of it back.

- **Symptom:** A branch came back asking what to do, or made a choice reserved for the host.
  **Action:** Move that decision to the preceding host-only barrier and re-run the branch with the value spelled out.
  **Why:** A branch handed an open decision closes it, differently in each branch — the failure the barrier was placed there to prevent.

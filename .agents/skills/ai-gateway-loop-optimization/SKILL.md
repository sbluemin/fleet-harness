---
name: ai-gateway-loop-optimization
description: Observe and optimize a core-ai-gateway provider loop against real model traffic, using a controlled repeated prompt and wire/transcript evidence to separate caller tool execution, provider retries, host auxiliary turns, cache behavior, and connection lifecycle before changing code. Use when a Cursor, Codex, Kimi, OpenCode, or future gateway path appears slow, repetitive, tool-heavy, costly, stalled, or under-instrumented, and the goal is to measure current behavior, make one evidence-backed optimization, and prove the result with the same workload.
---

# AI Gateway Loop Optimization

Optimize provider loops by measurement, not analogy:

> **observe → derive one optimization point → change → measure → observe again**

The output is not merely a patch. It is a reproducible before/after account that shows which layer changed, which layers did not, and whether the caller still received exactly the intended tool calls and results.

## Inputs

- `<provider/model>` — the exact gateway model to expose and pin.
- `<workload>` — a short prompt with a known number of logical operations. Prefer 3–5 tool operations that exercise the suspected path.
- `<trials>` — default **5 successful trials** before and after. Provider behavior is nondeterministic; one clean run is not a baseline.
- `<suspected symptom>` — optional. Treat it as a hypothesis until the logs prove its layer.

## Execution dependency

For a real Claude Code Operation, read the `console-e2e` skill and its [live agent prompt testing reference](../console-e2e/references/live-agent-prompt-testing.md) before launching anything. That reference owns worktree paths, isolated Console setup, Settings model exposure, wire capture, credentials, PTY/browser choices, and cleanup. Do not copy or improvise those mechanics here.

Skip the browser when the question is purely provider-wire behavior; call the built adapter directly as the reference describes. Use a real Operation when host-generated turns, caller tools, transcripts, process lifecycle, or what the operator sees are part of the question.

## Non-negotiable experiment contract

Freeze these before the baseline and keep them identical after the change:

- exact model id and effort;
- prompt text;
- caller tool catalog and permission mode;
- Theater/cwd and repository revision except for the candidate patch;
- logging settings;
- trial count and success criteria.

Record the literal values. If any changes, the comparison is not controlled; rerun rather than rationalize.

Use an **isolated** runtime directory and the worktree's absolute built binary. Confirm the running PID command before trusting a log. Build `core-ai-gateway` before Fleet Console whenever Console consumes the package's `dist/` output.

## Phase 1 — Observe the whole loop

Instrument before the first prompt. Collect all layers that exist for the provider:

| Layer | Evidence | Question it answers |
|---|---|---|
| Caller transcript | Claude Code JSONL | Which tools were actually handed to the caller, executed, errored, and returned? |
| Client ingress | `anthropic.request` | Which model/catalog did Claude Code send? |
| Canonical seam | `canonical.request` / `canonical.event` | What did normalization preserve or drop? |
| Provider wire | `<provider>.wire.request`, `cursor.wire.*` | What exact body/catalog/instructions reached upstream? |
| Provider diagnostics | e.g. Cursor bridge/redirect events | Did a live connection park, attach, mismatch, expire, or replay? |
| Host lifecycle | Operation state, transcript timestamps, processes | Did the agent finish, retry an auxiliary turn, or remain resident? |

Do not infer one layer from another. A provider rejection is not a caller execution. A `function_call` in replay history is not a new tool call. A session registry state is not necessarily a terminal process state.

### Classify every request before counting it

Separate workload traffic from host auxiliary traffic by input shape and prompt, not by timing alone:

- quota/health probes;
- title generation;
- Claude Code Suggestion Mode;
- no-tool bookkeeping turns;
- the initial agent request;
- tool-result continuations;
- automatic visible-output recovery after an empty assistant response;
- retries after transport/provider failure.

**Symptom:** request count is larger than `initial + logical tool results`.  
**Action:** inspect the final actionable input of every extra request and label its owner before optimizing.  
**Why:** deleting a legitimate host auxiliary turn or treating it as provider-loop amplification changes product behavior while appearing to improve a graph.

### Baseline metric contract

Report counts and denominators, not percentages alone:

- logical operations requested;
- caller tool calls, results, and errors;
- **caller-call amplification** = caller tool calls / logical operations;
- provider requests by classified request type;
- completed, failed, protocol-error, and transport-error responses;
- request body bytes per type;
- instruction bytes and tool-schema bytes where the wire exposes them;
- input, cached-input, cache-write, output, and reasoning tokens;
- **cache ratio** = cached input / input tokens;
- provider-specific lifecycle counts: selected, parked, exact attach, deferred replay, result written, mismatch, expiry;
- wall time per successful trial;
- final visible-output recovery count;
- process cleanup status.

A privacy-preserving log may omit prompts or call ids. Keep that boundary: add payload-free counters, local operation sequence numbers, adapter labels, sizes, and outcomes before adding raw content. Never persist credentials, prompts, tool output, raw call ids, conversation ids, or session ids merely to make aggregation easier.

## Phase 2 — Derive the optimization point

State each candidate as:

> **observed symptom → smallest change → expected measured delta → failure mode**

Keep only candidates whose symptom appears in the evidence and whose delta can be measured with the frozen workload.

Prefer, in order:

1. remove work that cannot affect the legal result;
2. preserve and reuse an existing connection/state contract;
3. reduce duplicated instructions or catalogs without hiding a callable capability;
4. improve exact correlation/classification;
5. add payload-free observability when the prior steps cannot be judged.

Reject an attractive optimization when the provider contract cannot preserve semantics. Examples:

- do not invent stateful continuation when an upstream requires `store:false`;
- do not redirect a ranged read when its native success shape cannot state that a range was applied;
- do not synthesize filesystem/search semantics through shell merely to raise a redirect rate;
- do not enable mutation replay without an execution receipt, idempotency key, and duplicate suppression;
- do not remove a tool from the wire unless the request shape makes tool use illegal/impossible or another exact loading/redirect contract preserves it.

**Symptom:** a large field repeats on every request.  
**Action:** first prove whether it is cached, required by a stateless wire, or used by the model on that request class.  
**Why:** body size alone does not prove waste; removing a required replay can trade bandwidth for lost context or upstream 400s.

Commit to one primary optimization per measurement round. Multiple simultaneous changes destroy attribution.

## Phase 3 — Change at the owning layer

Keep provider semantics in `packages/core-ai-gateway/src/<provider>/`. Cross-provider helpers are justified only for provider-neutral vocabulary or transport mechanics already permitted by the package boundary.

Add tests for both sides of every classifier:

- positive: the measured target shape is optimized;
- negative: a near-match or ordinary user/tool continuation is unchanged.

When adding diagnostics, test both persistence of allowed metrics and absence of secret payloads.

### Retry safety checklist

- **Mixed attempts after a transient failure:** define commit at the first event the client-facing encoder emits, buffer every pre-commit event per attempt, discard only an attempt that will be replayed, flush the terminal attempt, and integration-test that encoder; canonical setup or reasoning events may already produce visible output downstream.
- **More provider calls than any phase allows:** share one retry budget across the whole request and permanently test cross-phase failure sequences; independently bounded fetch and stream handlers compose into request amplification.
- **A closed consumer leaves `next()` or a socket pending:** give the initial read, retry delay, and retry fetch one per-call cancellation owner, then test caller abort plus iterator `return()` and `throw()` in each phase; a generator awaiting its source cannot enter cleanup merely because a retry controller was aborted.
- **A recovered retry has no failure evidence:** record payload-light evidence at the seam that discards the failed attempt, and test successful-event non-duplication plus secret absence; a downstream logger cannot recover events already removed upstream.

Do not edit compiler-owned changelogs. Amend the applicable `.changelog.d/` fragment only for user-visible behavior.

## Phase 4 — Measure with the frozen workload

Build the package, rebuild/restart the isolated Console if needed, and rerun the same number of successful trials.

Produce a before/after table for every metric the candidate claimed it would change. Also include invariants that must remain stable:

- caller tool calls and results;
- caller errors;
- provider failed/error responses;
- permission boundary;
- final task result.

A trial that never reached the provider because the Console/MCP was not ready is fixture failure, not model failure. Replace it and report it separately. A server process stopped intentionally may surface as exit 137/144; verify the owned PID is gone rather than counting the shell status as a provider failure.

## Phase 5 — Observe again, adversarially

The first after-run proves the expected path. The second observation tries to disprove the classifier and the claimed cause.

Run at least:

- the exact baseline workload;
- one near-match that must **not** trigger the optimization;
- one auxiliary/no-tool turn if the change classifies host traffic;
- one failure/error result if result conversion or correlation changed;
- concurrent or repeated trials when ordering/correlation is involved.

Inspect actual artifacts and logs, not just tests or the implementing narrative. Re-run the full package tests, typecheck, build, dependent Console build, changelog validation, and `git diff --check` before accepting the change.

Stop when either:

- the measured target improves, invariants hold, and the adversarial observation stays clean; or
- evidence shows the remaining cost is an upstream/host contract rather than removable gateway work.

Do not keep optimizing because a number is large.

## Reporting template

```markdown
### Experiment
- Model / effort:
- Workload / logical operations:
- Successful trials:
- Fixture failures excluded:

### Observation
| Metric | Before | After | Delta |
|---|---:|---:|---:|

### Attribution
- Workload requests:
- Auxiliary requests:
- Caller executions:
- Provider retries/failures:
- Cache behavior:

### Change
Observed symptom → change → why it is safe.

### Invariants
- Caller permissions:
- Calls/results/errors:
- Unsupported/lossy cases:
- Privacy/logging:

### Verification
Tests, builds, live wire evidence, cleanup, and unresolved unknowns.
```

## Gotchas

- **A clean run from the wrong checkout is no evidence.** Use absolute worktree paths and confirm the PID command.
- **The Console may consume stale package `dist/`.** Build `core-ai-gateway`, then Console, then restart.
- **A prompt can manufacture retries.** “Do not explain” plus Claude Code's visible-output requirement creates an empty response followed by an automatic recovery request; classify it before blaming the provider.
- **Suggestion Mode is a separate host request.** It can arrive after the visible transcript appears complete and must be identified by its input sentinel.
- **Parallel trials interleave logs.** Correlate with transcript time windows or run sequentially when per-trial attribution matters; never use raw identifiers in persisted product diagnostics to make the experiment easier.
- **A large tool catalog is not automatically deferrable.** Measure actual `defer_loading` distribution and prove the reload/reference contract before filtering it.
- **Caller amplification and provider amplification are different denominators.** Report both; policy rejects and provider retries do not imply the caller executed more tools.
- **Cleanup is part of the result.** Stop only the owned Console/agent processes and verify they disappeared.

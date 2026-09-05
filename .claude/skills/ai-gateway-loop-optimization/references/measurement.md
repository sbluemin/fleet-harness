# Controlled experiments and layered measurement

## Non-negotiable experiment contract

Freeze these before the baseline and keep them identical after the change:

- exact model id and effort;
- prompt text;
- caller tool catalog and permission mode;
- Theater/cwd and the model-visible repository revision;
- multi-turn dispatch policy: wait for `turn_ended` or enqueue while the prior turn runs;
- logging settings;
- trial count and success criteria.

Record the literal values. If any changes, the comparison is not controlled; rerun rather than rationalize. When the workload inspects the candidate's own source, keep the model-visible tree identical and vary only the built runtime under test. Check `git status` around every trial and discard any trial where the model mutates the frozen tree — seeing or changing the patch alters the workload as well as the runtime, so the result has no single cause.

For the standalone runner, use the absolute worktree path and verify a fresh package `dist/`. For a real Operation, use an isolated runtime directory, confirm the running PID command, and build `core-ai-gateway` before Fleet Console whenever Console consumes the package's `dist/` output.

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

Collect a layer only when it exists for the chosen execution surface. The standalone runner creates no caller transcript, host lifecycle, or auxiliary turns; do not count those as zero or infer them from runner metrics. Do not infer one layer from another. A provider rejection is not a caller execution. A `function_call` in replay history is not a new tool call. A session registry state is not necessarily a terminal process state.

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

### Classify lifecycle outcomes before counting them

**Symptom:** a probe reports provider failures on otherwise successful Cursor multi-tool trials.

**Action:** classify each lifecycle outcome against the adapter contract before aggregating it; `client_tool_suspended` is the normal segment boundary that parks a Run while it waits for client tool results.

**Why:** counting every non-success segment finish as a provider failure creates one false failure per park even though the Run attaches and completes normally.

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
- cleanup status: standalone router/server close; real Operation owned-process cleanup.

A privacy-preserving log may omit prompts or call ids. Keep that boundary: add payload-free counters, local operation sequence numbers, adapter labels, sizes, and outcomes before adding raw content. Never persist credentials, prompts, tool output, raw call ids, conversation ids, or session ids merely to make aggregation easier.

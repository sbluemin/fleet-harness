# Optimization candidates and regression verification

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

Keep provider semantics in `packages/core-ai-gateway/src/upstream/<provider>/`, and anything specific to the client CLI being served in `packages/core-ai-gateway/src/downstream/harness/<client>/`. Cross-provider helpers are justified only for direction-neutral vocabulary or transport mechanics already permitted by the package boundary.

Add tests for both sides of every classifier:

- positive: the measured target shape is optimized;
- negative: a near-match or ordinary user/tool continuation is unchanged.

When adding diagnostics, test both persistence of allowed metrics and absence of secret payloads.

### Retry safety checklist

- **Mixed attempts after a transient failure:** derive the commit boundary from the client-facing encoder's first semantically unreplayable output, buffer every replay-safe lead event per attempt, discard only an attempt that will be replayed, flush the terminal attempt, and integration-test that encoder; canonical setup/reasoning events or their encoder frames need not commit the attempt.
- **More provider calls than any phase allows:** share one retry budget across the whole request and permanently test cross-phase failure sequences; independently bounded fetch and stream handlers compose into request amplification.
- **A closed consumer leaves `next()` or a socket pending:** give the initial read, retry delay, and retry fetch one per-call cancellation owner, then test caller abort plus iterator `return()` and `throw()` in each phase; a generator awaiting its source cannot enter cleanup merely because a retry controller was aborted.
- **A recovered retry has no failure evidence:** record payload-light evidence at the seam that discards the failed attempt, and test successful-event non-duplication plus secret absence; a downstream logger cannot recover events already removed upstream.

Do not edit compiler-owned changelogs. Amend the applicable `.changelog.d/` fragment only for user-visible behavior.

## Phase 4 — Measure with the frozen workload

For a real Operation, rebuild/restart the isolated Console if needed. For the standalone runner, use the identical exact command, sequential trials, and a fresh package build; do not add Console lifecycle steps.

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

The fixed standalone runner is for repeating the exact baseline workload. If near-match, auxiliary, or failure request shapes are not supported by its options, use a direct built-adapter probe or focused test instead; do not imply that the runner provides unsupported scenarios.

Inspect actual artifacts and logs, not just tests or the implementing narrative. Re-run package tests, typecheck, build, and `git diff --check`. A dependent Console build is required only when gateway serving/host wiring or real Operation behavior changed; package-only changes use the runner for the exact workload and direct adapter probes/tests for other supported scenarios.

Stop when either:

- the measured target improves, invariants hold, and the adversarial observation stays clean; or
- evidence shows the remaining cost is an upstream/host contract rather than removable gateway work.

Do not keep optimizing because a number is large.

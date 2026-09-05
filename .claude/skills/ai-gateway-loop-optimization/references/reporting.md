# Experiment reporting and interpretation traps

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
- **Queued and sequential turns are different treatments.** Fix one dispatch policy before baseline and verify it from `queue-operation` plus turn timestamps; if before and after differ, rerun or exclude queue-sensitive lifecycle and request deltas because enqueueing changes host attachments and request shape.
- **Rotated diagnostics are partial evidence.** Check `maxBytes` and retained backups before measuring; once rotation drops an earlier segment, use the complete caller transcript and unlimited wire log as the session denominator, because retained lifecycle counts silently omit early parks, attaches, retries, and errors.
- **A large tool catalog is not automatically deferrable.** Measure actual `defer_loading` distribution and prove the reload/reference contract before filtering it.
- **Caller amplification and provider amplification are different denominators.** Report both; policy rejects and provider retries do not imply the caller executed more tools.
- **Standalone confirmation is quota consent.** The default test/CI path never invokes the live runner.
- **Package dist can be stale.** Build the package before the standalone runner; real Operations additionally rebuild/restart Console when it consumes the package.
- **Cleanup ownership follows the execution surface.** Confirm the standalone trial's router/server cleanup metrics; for a real Operation, stop only its owned Console/agent processes and verify they disappeared. Mixing the rules either misses an open handle or kills an unrelated process.

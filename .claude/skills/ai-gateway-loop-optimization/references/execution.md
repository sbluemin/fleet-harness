# Gateway experiment execution surfaces

## Execution dependency

Choose the smallest execution surface. For provider-loop, canonical, or router behavior only, use the standalone package runner below and do not start Console. If a bespoke request shape exceeds the runner, call the built adapter directly. If caller tools/transcripts, host-generated or auxiliary turns, process lifecycle, or operator view matter, use a real Operation: read `console-e2e` and its [live agent prompt testing reference](../../console-e2e/references/live-agent-prompt-testing.md) first; that reference owns isolated Console setup, credentials, PTY/browser choices, and cleanup.

### Standalone provider-loop runner

The runner starts no Console, PTY, Theater, or Operation. It uses the production core-ai-gateway router and production credential readers. From the absolute worktree path, run:

```sh
pnpm --filter @dotobokuri/core-ai-gateway build
pnpm --filter @dotobokuri/core-ai-gateway e2e:provider-loop -- --model 'claude-gateway--opencode--deepseek-v4-flash[1m]' --operations 3 --trials 5 --confirm-live-provider
```

`--effort` accepts `low|medium|high|xhigh|max|ultra`; `--timeout-ms` controls the whole logical trial. Confirmation spends real quota. `FLEET_GATEWAY_WIRE_LOG=<isolated-scratch>/wire.jsonl` is explicit opt-in for raw prompt/tool payloads; credentials are not recorded, but this remains sensitive. Verify a fresh package `dist/`; isolated runtime/PID/Console-build requirements apply only to real Operations. Default test and CI paths never invoke the live runner.

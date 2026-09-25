# Gateway experiment execution surfaces

## Execution dependency

Choose the smallest execution surface. For provider-loop, canonical, or router behavior only, use the standalone package runner below and do not start Console. If a bespoke request shape exceeds the runner, call the built adapter directly. If caller tools/transcripts, host-generated or auxiliary turns, process lifecycle, or operator view matter, use a real Operation: read `console-e2e` and its [live agent prompt testing reference](../../console-e2e/references/live-agent-prompt-testing.md) first; that reference owns isolated Console setup, credentials, PTY/browser choices, and cleanup.

Between those sits a headless Claude Code turn through each worktree's built launcher, described in the same reference's **Headless Claude Code through the built launcher** section. Use it when the behavior depends on what the real client returns — its thinking signatures, real tool results, `--resume` — which the runner cannot express: its tool results are a fixed `ok` and its prompt is synthetic. For before/after runs, point both builds at the same slot, Claude config home, and fixed run directory so the system prompt and tool catalog stay identical, and alternate the order.

When the question is only whether a backend accepts a request variant, take a real request body from the wire log and send the modified body straight to the provider with the gateway's credential and header rules. Keep only allowlisted response headers, and record reasoning blobs, signatures, and server state headers such as `x-codex-turn-state` as length, sha256, and a short prefix — never the full value.

### Standalone provider-loop runner

The runner starts no Console, PTY, Theater, or Operation. It uses the production `@fleet-console/ai-gateway` router and production credential readers. From the absolute worktree path, run:

```sh
pnpm --filter @fleet-console/ai-gateway build
pnpm --filter @fleet-console/ai-gateway e2e:provider-loop -- --model 'claude-gateway--opencode--deepseek-v4-flash[1m]' --operations 3 --trials 5 --confirm-live-provider
```

`--effort` accepts `low|medium|high|xhigh|max|ultra`; `--timeout-ms` controls the whole logical trial. Confirmation spends real quota. `FLEET_GATEWAY_WIRE_LOG=<isolated-scratch>/wire.jsonl` is explicit opt-in for raw prompt/tool payloads; credentials are not recorded, but this remains sensitive. Verify a fresh package `dist/`; isolated runtime/PID/Console-build requirements apply only to real Operations. Default test and CI paths never invoke the live runner.

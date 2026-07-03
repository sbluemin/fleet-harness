# Bench Plugin Doctrine

`runtime/fleet-plugins/bench` (`@fleet-plugins/bench`) is the built-in Eval Bench plugin for Fleet Console. It fans one initial prompt out to 2–4 Agent CLIs, groups the resulting sessions into an OperationGroup, streams a scrollback tail per contender, and persists operator rubric verdicts across restarts.

## Plugin Identity

- **Plugin id**: `bench`
- **Operation type**: `bench`
- **Client entry**: `client/index.tsx` (resolved via `virtual:fleet-plugins` at build time)
- **Server entry**: `routes.ts` → built by tsup to `dist/fleet-plugins/bench/routes.mjs`

## REST Routes

All routes are served under `/plugins/bench/`.

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `runs` | List bench runs (initialPrompt truncated to 80 chars) |
| `POST` | `runs` | Create a bench run — kicks off fan-out |
| `GET`  | `runs/:runId` | Full single run (raw prompt, participants, verdicts) |
| `DELETE` | `runs/:runId` | Delete run and all participants/group |
| `POST` | `runs/:runId/verdicts` | Submit/update rubric verdicts (last-writer-wins) |

### POST /plugins/bench/runs body

```json
{
  "theaterId": "string",
  "initialPrompt": "string (max 16 384 bytes)",
  "contenders": [{ "cliId": "string" }, …],
  "rubric": [{ "id": "string", "label": "string" }, …]
}
```

Response: `{ run: BenchRun, warnings: [{ code, term }] }`.

## Fan-out Sequence

1. `POST /api/v1/operations/groups` → create OperationGroup (name `Bench: <8-char prompt>`, colour deterministic from prompt hash).
2. For each contender (sequentially): `POST /plugins/terminal/agent/sessions { theaterId, cliId, initialInput }` → collect opId/sessionId.
3. `PATCH /api/v1/operations/:opId { groupId }` for each contender op.
4. `POST /api/v1/operations { type:"bench", pluginId:"bench", payload: { rubric, groupId, participantOpIds, participantSessionIds } }` → bench op.
5. `PATCH /api/v1/operations/:benchOpId { groupId }`.
6. Write `BenchRun` to storage.

On failure in step 2, already-spawned sessions are deleted and the group is cleaned up (rollback).

## Delete Sequence

1. `DELETE /plugins/terminal/agent/sessions/:opId` for each participant (dormant transition).
2. `DELETE /api/v1/operations/:benchOpId`.
3. `DELETE /api/v1/operations/groups/:groupId`.
4. Remove `BenchRun` from storage.

Group orphan prevention: delete participants and bench op **before** deleting the group. The store's group-delete automatically nulls remaining op `groupId` values, so ordering matters only for orphan safety.

## Storage

- Key: `bench` / `runs` → `FleetPluginStorageHost.writeJson("bench", "runs", { version: 1, runs: [...] })`
- File path (resolved by host): `<data-dir>/plugins/bench/runs.json`
  - Published stable: `~/.fleet/console/plugins/bench/runs.json`
  - Local dev (`pnpm fleet-console`): `<repo>/.fleet/console/plugins/bench/runs.json`
  - `FLEET_CONSOLE_DIR` override: `$FLEET_CONSOLE_DIR/plugins/bench/runs.json`
- Schema v1: `{ version: 1, runs: BenchRun[] }`
- `initialPrompt` and `contenders` are marked as `sensitiveFields` in `plugin.json` and masked from observer browser payloads.

## Token Boundary

Bench routes must **never** include the following in any response payload:

- `providerSession`, `ticket`, `token`
- `transcriptPath`, `canonicalCwd`, `cwd` (absolute paths)
- `initialInput` (echoed back from terminal session creation)

The scrollback tail route (`GET /plugins/terminal/agent/sessions/:id/scrollback`) returns `{ scrollback, bytes, truncated }` — stdout bytes only; no session metadata.

## CSS Token Rules

- All colours must use `var()` or `color-mix(in oklab, var(…), …)` — no hardcoded `oklch(…)` values.
- Grep check: `grep -R "oklch([0-9]" runtime/fleet-plugins/bench/client/` must return zero hits.
- `prefers-reduced-motion: reduce` must short-circuit all `animation` and `transition` rules.

## Editing-Keyword Warnings

`server/warnings.ts` exports `detectEditingKeywords(prompt)` → `{ code: "editing_keyword", term }[]`. The server includes this in the `POST /plugins/bench/runs` response. The client also runs a lightweight duplicate check before submission to show a yellow badge early. The warning is advisory only — it does not block launch.

## Contender Status Polling (Client)

- Operation existence: `GET /api/v1/operations/:opId` — 500 ms polling. 200 = running, 404 = succeeded.
- Scrollback: `ctx.api.fetch("terminal", "agent/sessions/:sessionId/scrollback?lines=40")` — 1 000 ms polling. Returns `{ scrollback: string, bytes: number, truncated: boolean }`.

## Admiral Direction Needed

- Contender upper limit: currently 4. Raising to >4 risks spawn spikes; lower if resource pressure observed.
- Polling intervals (500 ms status / 1 000 ms scrollback): adjust via Admiral direction if performance regresses.
- Storage file split: v1 uses a single `runs.json` snapshot. If the file grows beyond ~1 MB, split to `runs/<runId>.json` per-run.

---
id: "fleet-core-domain-ownership-constants-and-streaming"
title: "fleet-core domain ownership: constants and carrier-job streaming both live under admiral"
tags: ["fleet-core", "domain-ownership", "doctrine", "decision-log", "invariant"]
created: "2026-05-03T16:17:41.480Z"
updated: "2026-05-03T16:17:41.480Z"
version: 1
rawSourceRef: "raw/2026-05-03-fleet-core-domain-ownership-constants-and-streaming-source.md"
---
## Decision summary

Two domain ownership questions were resolved during the 2026-05 4-domain unification. Both rulings prevent `infra` from drifting into a domain-event holder and preserve admiral's domain cohesion.

## D-α — Constants belong to `admiral.constants`

- All Fleet constants live under `admiral.constants` slot of the admiral facade.
- Reasoning: most fleet-core constants are CLI/Carrier domain values (`CARRIER_COLORS`, `CLI_DISPLAY_NAMES`, `VALID_CLI_TYPES`, `CARRIER_DISPLAY_NAMES`, `CLI_TYPE_DISPLAY_ORDER`, `CARRIER_BG_COLORS`, `CARRIER_RGBS`). They semantically belong to admiral, not infra.
- Exception: a constant that is purely infra-neutral (e.g., a generic file-system path constant) MAY be attached to `infra` instead. When ambiguous, default to admiral.
- Consumer migration (post-2026-05): `import { CARRIER_COLORS } from "@sbluemin/fleet-core/constants"` no longer works. Use `import { admiral } from "@sbluemin/fleet-core"; admiral.constants.CARRIER_COLORS` instead.

## D-β — Carrier job stream events belong to `admiral.carrierJobs.streaming`

- `register` / `unregister` for carrier-job stream events are exposed at `admiral.carrierJobs.streaming`.
- `infra.job.streaming` does NOT exist and must not be created.
- Reasoning:
  1. `TrackStatus` SSoT lives in `admiral/_shared/carrier-job-events.ts` — source of truth is admiral domain.
  2. `admiral.carrierJobs.buildToolSpec` (dispatch surface) and `admiral.carrierJobs.streaming` (event surface) have stronger cohesion when colocated under the same admiral facade.
  3. `infra` is horizontal infrastructure (auth/settings/log/data-dir/toolRegistry); domain event flow is not infra's responsibility.
- Consumer migration (post-2026-05): `runtime.jobs.streaming.register(...)` no longer exists. Use `runtime.admiral.carrierJobs.streaming.register(...)`.

## Negative definition of `infra`

These rulings define `infra` negatively: any domain event flow or domain-scoped constant MUST NOT enter `infra`. `infra` is reserved for cross-cutting infrastructure primitives only — auth, dataDir, job (archive/sanitize/detached/lru-cache/concurrency-guard), log, settings, toolRegistry. If a candidate symbol carries Carrier/CLI/Fleet semantics, it belongs to `admiral`, not `infra`.

## When to revisit

Revisit only if a future architectural change introduces a new horizontal infrastructure concern that genuinely has no admiral semantics. Until then, treat D-α and D-β as locked decisions with the same weight as locked decisions ①~⑨ from the original mission.
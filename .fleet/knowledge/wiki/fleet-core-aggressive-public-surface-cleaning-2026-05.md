---
id: "fleet-core-aggressive-public-surface-cleaning-2026-05"
title: "fleet-core 2026-05 destructive public-surface cleansing: 20+ subpaths to 5"
tags: ["fleet-core", "public-api", "doctrine", "invariant", "destructive-cleansing", "decision-log"]
created: "2026-05-03T16:18:09.844Z"
updated: "2026-05-03T16:18:09.844Z"
version: 1
rawSourceRef: "raw/2026-05-03-fleet-core-aggressive-public-surface-cleaning-2026-05-source.md"
---
## What happened

In May 2026, fleet-core's public surface was destructively cleaned without backward-compatibility shims. This entry records the policy precedent so future contributors understand why old subpaths and flat exports must NOT be re-introduced as workarounds.

## Removed surfaces

### Removed `package.json exports` subpaths

`./constants`, `./job`, `./carrier-jobs`, `./admiral`, `./admiral/carrier`, `./admiral/carrier/types`, `./admiral/carrier/personas`, `./admiral/carrier/status-overlay-controller`, `./admiral/squadron`, `./admiral/taskforce`, `./admiral/store`, `./admiral/_shared/carrier-job-events`, `./admiral/protocols/standing-orders`, `./services/tool-registry`, `./services/settings`, `./services/log`, `./services/data-dir`, `./metaphor/operation-name`, `./metaphor/directive-refinement`, `./admiralty`.

### Removed `src/index.ts` flat exports

Examples: `executeWithPool`, `executeOneShot`, `parseModelId`, `buildLaunchCommand`, `getSessionIdFor`, `disconnect`, `disconnectAll`, `cleanIdle`, `bindHostSession`, `shutdownAllSessions`, `createAuthService`, `resolveAuthEnv`, `CLI_TO_AUTH_PROVIDER_ID`, and all six legacy service factories (`createFleetServices`, `createGrandFleetServices`, `createJobServices`, `createLogServices`, `createSettingsServices`, plus the old metaphor factory shape).

### Removed types

`FleetServices`, `GrandFleetServices`, `FleetJobServices`, `FleetLogServices`, `FleetSettingsServices` and their `runtime.{fleet,grandFleet,jobs,log,settings}` field shape.

## Allowed surface (frozen)

- Root: `import { ... } from "@sbluemin/fleet-core"` — only `createFleetCoreRuntime`, four domain facades (`admiral/admiralty/metaphor/infra`), four service factories (`createFleetAdmiralServices` / `createFleetAdmiraltyServices` / `createFleetMetaphorServices` / `createFleetInfraServices`), four service types, and `FleetCoreRuntimeContext`/`FleetCoreRuntimeOptions`.
- Four documented subpaths: `./admiral`, `./admiralty`, `./metaphor`, `./infra`.
- Consumer access flows through `runtime.<domain>.<facade>.<member>` only.

## Why this policy

Backward-compatibility shims accumulate ownership ambiguity and slow doctrine evolution. fleet-core's domain split is the architectural commitment; preserving stale public paths invites callers to bypass the four-domain SSoT and re-introduce dual ownership.

## Re-addition rule

Do NOT re-add removed subpaths or flat exports as a workaround. If a consumer needs a symbol that is no longer reachable through the four facades:

1. Add the symbol to its owning facade object first.
2. Confirm `runtime.<domain>.<facade>.<symbol>` resolves at the consumer.
3. Do not restore deep subpath exports or flat `src/index.ts` exports — those moves are regressions.

## Reference

See companion entry `fleet-core-public-services-4-domain-architecture` for the canonical four-domain shape.
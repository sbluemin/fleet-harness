---
id: "fleet-core-aggressive-public-surface-cleaning-2026-05-source"
created: "2026-05-03T16:18:09.844Z"
sourceType: "inline"
title: "2026-05 aggressive cleaning policy decision"
tags: ["fleet-core", "public-api", "doctrine", "invariant", "destructive-cleansing", "decision-log"]
---
Locked decisions 7 and 8 from the 2026-05 fleet-core public-services-4-unification mission: package.json exports compressed to 5 entries (., ./admiral, ./admiralty, ./metaphor, ./infra). Removed entries: ./constants, ./job, ./carrier-jobs, ./admiral, ./admiral/carrier, ./admiral/carrier/types, ./admiral/carrier/personas, ./admiral/carrier/status-overlay-controller, ./admiral/squadron, ./admiral/taskforce, ./admiral/store, ./admiral/_shared/carrier-job-events, ./admiral/protocols/standing-orders, ./services/tool-registry, ./services/settings, ./services/log, ./services/data-dir, ./metaphor/operation-name, ./metaphor/directive-refinement, ./admiralty. src/index.ts root barrel restricted to four facades plus four service factories plus core types only; flat function exports removed (executeWithPool, executeOneShot, parseModelId, buildLaunchCommand, getSessionIdFor, disconnect, disconnectAll, cleanIdle, bindHostSession, shutdownAllSessions, createAuthService, resolveAuthEnv, CLI_TO_AUTH_PROVIDER_ID, etc.). Policy: external compatibility was intentionally not preserved.
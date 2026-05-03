---
id: "provider-ts-region-architecture-source"
created: "2026-05-03T02:35:44.815Z"
sourceType: "inline"
title: "conversation excerpt — pi-fleet-extension provider.ts consolidation"
tags: ["architecture", "pi-fleet-extension", "provider", "host-adapter", "doctrine"]
---
provider.ts consolidation history:

Before (multi-file):
- provider-stream.ts
- provider-runtime.ts
- provider-guard.ts
- provider-guard-command.ts
- thinking-level-patch.ts
- provider-internal/ (7 files: run-stream, events, register, guard, state, session-runtime, thinking-level-patch)
- runner.ts (dead code, separately removed)

After (single file with #region sections):
- provider.ts only

#region structure:
1. pi-ai gateway (re-export)
2. streamAcp adapter — types/state
3. streamAcp adapter — public functions (initStreamEventHandler, streamAcp)
4. streamAcp adapter — case 1: fresh query (runFreshQuery)
5. streamAcp adapter — case 2: tool result delivery (runToolResultDelivery)
6. streamAcp adapter — event → Pi stream mapping (mapEventToPiStream + BlockTracker)
7. streamAcp adapter — internal helpers (extract*, getScopeKey, ...)
8. thinking-level patch (installAcpThinkingLevelPatch + reconcileAcpThinkingLevel)
9. provider-guard (Pi ModelRegistry monkeypatch)
10. provider-guard command (fleet:guard:toggle)
11. provider-runtime (registerProviderRuntime + PROVIDER_REGISTRATIONS)

Rules:
- Single Pi-AI Gateway: only file with @mariozechner/pi-ai imports
- No re-fragmentation: do not split back
- No host-side fleet-core duplication
- Boot-time stream-handler registration only

Consumer surface unified to: import from "./provider.js"

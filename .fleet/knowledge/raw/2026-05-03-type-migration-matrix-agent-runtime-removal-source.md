---
id: "type-migration-matrix-agent-runtime-removal-source"
created: "2026-05-03T02:36:35.599Z"
sourceType: "inline"
title: "conversation excerpt — Vanguard type duplication audit + Wave A/B/C migration"
tags: ["architecture", "types", "migration", "admiral", "agent", "audit", "lessons-learned"]
---
Vanguard scout report (squadron:88756f55) classifying all 11 exported types from legacy _shared/agent-runtime.ts:

11 types analyzed:
1. ToolCallInfo — Genuine new home (executor result inline)
2. ConnectionInfo — Dead concept
3. AgentStatus — SSoT consolidation → TrackStatus
4. ColBlock — Host concern (panel/types.ts)
5. ColStatus — SSoT consolidation → TrackStatus
6. CollectedStreamData — Dead concept
7. ExecuteOptions — Genuine new home → CarrierExecuteOptions
8. ExecuteResult — Genuine new home → CarrierExecResult
9. PooledClient — Dead concept (private interface only)
10. SessionMapStore — Complete duplicate
11. ResumeFailureKind — Complete duplicate

Wave A/B/C executed migration:
- Wave A: built new homes (executor.ts, executor-engine.ts, post-connect.ts), connections/lifecycle expansion
- Wave B: switched 3 carrier tool-specs, fleet-store, host fleet.ts, ColBlock to host
- Wave C: deleted legacy 3 files, package.json/tsup/PUBLIC_API.md cleanup, 8 test reorganization

Result: 40 files changed, 911 insertions, 2085 deletions (commit 83ebdd0a).

_shared/ after cleanup contains exactly:
- carrier-job-events.ts
- cli-tool-types.ts
- mcp.ts

Decisions invoked:
- Decision 28: no admiral/agent subpath; root barrel only
- Decision 34: connections/lifecycle public surface = 6 names exactly

---
id: "admiral-agent-migration-regression-fixes-source"
created: "2026-05-03T02:34:56.931Z"
sourceType: "inline"
title: "conversation excerpt — admiral.agent migration regression fixes"
tags: ["regression", "admiral", "agent", "migration", "fixes", "lessons-learned"]
---
8 regression classes discovered during admiral.agent migration (commit 8e9bb327) and legacy _shared/agent-runtime.ts removal (commit 83ebdd0a):

1. mcpToolUseStarted setter missing in 3 locations (sendMessage + 2x deliverToolResults paths) → "이전 toolUse 이후 세션이 유효하지 않습니다"
2. BlockTracker.ensureStarted() never called → start event missing → streaming buffered until done
3. registerExtraTools called AFTER ensure → toolHash mismatch on 2nd turn → fresh session
4. wireStreamEmitter re-attached in deliverToolResults → N-fold listener duplication
5. cliRuntimeContextBuilder setter null/instance-mismatch → no system-reminder context delivered. Resolution: moved prompt assembly into fleet-core session-engine, host passes { userRequest, history } only
6. initAgentSessionRuntime never called from public/runtime.ts → sessionStore null → /resume always fresh. Resolution: legacy initRuntime call replaced
7. event.reason gating on session_start → bindHostSession skipped → mapFilePath null → store.set no-op
8. ExecuteOptions/ExecuteResult migration field round-trip gaps (connectSystemPrompt etc.)

QA gate static greps added for each pattern:
- ports pattern eradication
- globalThis legacy key removal
- legacy import path removal
- AgentStatus/ColStatus/ColBlock host-only
- legacy file deletion proof

Encoded in .fleet/plans/agent-runtime-removal.md Wave D acceptance.

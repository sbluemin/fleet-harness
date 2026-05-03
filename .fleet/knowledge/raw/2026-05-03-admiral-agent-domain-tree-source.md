---
id: "admiral-agent-domain-tree-source"
created: "2026-05-03T02:33:59.277Z"
sourceType: "inline"
title: "conversation excerpt — admiral.agent domain consolidation"
tags: ["architecture", "admiral", "agent", "fleet-core", "domain-tree", "api-surface"]
---
admiral.agent domain structure as of commit 83ebdd0a (post-legacy-removal):

Public modules (9):
- session.ts (streaming)
- events.ts (module emit/register)
- tools.ts (list/invoke/extra)
- executor.ts (callback path: executeWithPool/executeOneShot)
- lifecycle.ts (bindHostSession/shutdownAllSessions)
- connections.ts (disconnect/disconnectAll/cleanIdle/getSessionIdFor)
- models.ts (parseId/buildId/listProviders/getProviderIds/getThinkingLevels)
- service-status.ts (read/refresh/events)
- bridge.ts (buildLaunchCommand)

Internal engines (7 under internal/):
- state.ts
- session-runtime.ts (sessionStore SSOT)
- session-engine.ts (firstPromptSent dispatch)
- event-normalizer.ts
- mcp-router.ts (setOnToolCallArrived sole owner)
- executor-engine.ts (module-level Maps; legacy globalThis removed)
- post-connect.ts (applyPostConnectConfig single owner)

Type contracts:
- SessionHandle = { readonly sessionId: string } (Decision 1)
- SendMessageRequest = { userRequest, history? }
- AgentStreamEvent: text|thought|toolCall|toolCallUpdate|mcpToolCall|complete|error|exit (always carries sessionId; never MCP token)
- complete event: done="stop"|"toolUse" for PI agent-loop round-trip
- CarrierExecuteOptions/CarrierExecResult for callback path
- TrackStatus = queued|conn|stream|done|err|aborted (SSoT)

Public consumer access: @sbluemin/fleet-core root barrel only (Decision 28). No admiral/agent subpath in package.json exports.

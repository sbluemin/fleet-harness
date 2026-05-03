---
id: "admiral-agent-architecture-philosophy-source"
created: "2026-05-03T02:33:22.003Z"
sourceType: "inline"
title: "conversation excerpt — admiral.agent migration + legacy agent-runtime removal session"
tags: ["architecture", "admiral", "agent", "fleet-core", "philosophy", "doctrine"]
---
Architecture Philosophy section excerpted from /AGENTS.md (root) after the admiral.agent migration + legacy agent-runtime.ts removal sessions.

Four principles formalized:
1. Domain Boundary as Law — fleet-core ↔ pi-fleet-extension split is build/grep-gated
2. Two Execution Patterns Strictly Separated — Streaming (admiral.session + events) vs Callback (admiral.executor)
3. Single Source of Truth — sessionStore / TrackStatus / MCP / CLI catalog / fleet tool registry single owner
4. Public Surface Discipline — Decision 28: root barrel only, no admiral/agent subpath

Forbidden Patterns:
- globalThis.<anything>
- Ports pattern (AgentToolPorts)
- on*-callback through fleet-core public APIs
- Host-injected builder functions

These principles emerged from:
- Wave A/B/C admiral.agent migration (commit 8e9bb327)
- Wave A/B/C legacy _shared/agent-runtime.ts removal (commit 83ebdd0a)
- 8 regression fixes discovered during admiral.agent migration:
  1. mcpToolUseStarted setter missing
  2. start event emit missing
  3. registerExtraTools call order
  4. wireStreamEmitter listener accumulation
  5. runtimeContext + buildInitialPrompt missing
  6. fleet-core sendMessage responsibility consolidation
  7. session-runtime initRuntime call missing
  8. event.reason gating preventing sessionStore.restore

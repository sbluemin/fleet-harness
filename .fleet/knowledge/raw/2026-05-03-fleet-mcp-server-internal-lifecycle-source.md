---
id: "fleet-mcp-server-internal-lifecycle-source"
created: "2026-05-03T16:18:52.398Z"
sourceType: "inline"
title: "2026-05 MCP surface re-grouping (supersedes 2026-04 fleet-services entry)"
tags: ["fleet-core", "mcp", "invariant", "lifecycle", "tool-registry"]
---
The 2026-04 wiki entry fleet-mcp-server-internal-lifecycle described MCP exposure under FleetServices.mcp. The 2026-05 fleet-core-public-services-4-unification mission relocated the consumer-facing MCP surface from FleetServices.mcp to runtime.infra.toolRegistry.mcp. The implementation file packages/fleet-core/src/admiral/_shared/mcp.ts was NOT moved; only the public facade grouping changed. startMcpServer and stopMcpServer remain internal to fleet-core; runtime.infra.toolRegistry.mcp exposes only url, resolveNextToolCall, hasPendingToolCall, clearPendingForSession. Lazy singleton URL caching is owned by getFleetMcpUrl in runtime.ts.
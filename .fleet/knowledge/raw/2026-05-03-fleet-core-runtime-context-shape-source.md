---
id: "fleet-core-runtime-context-shape-source"
created: "2026-05-03T16:18:32.451Z"
sourceType: "inline"
title: "2026-05 runtime context unification (supersedes 2026-04 entry)"
tags: ["fleet-core", "public-api", "doctrine", "invariant", "runtime-context"]
---
The 2026-04 wiki entry fleet-core-runtime-context-shape recorded a 6-service runtime context (fleet/grandFleet/metaphor/jobs/log/settings) as final. The 2026-05 fleet-core-public-services-4-unification mission replaced this shape with a 4-domain context (admiral/admiralty/metaphor/infra). The earlier shape and its FleetServices/GrandFleetServices/FleetJobServices/FleetLogServices/FleetSettingsServices types are permanently retired. Initialization side-effect order setFleetCoreBootMode then migrateLegacyFleetDataDir then initAgentSessionRuntime then initStore is preserved exactly. shutdown calls infra.toolRegistry.mcp.stopMcpServer plus settings runtime reset plus resetServiceStatus.
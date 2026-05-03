---
id: "tool-snapshot-single-store-invariant-source"
created: "2026-05-03T16:19:27.125Z"
sourceType: "inline"
title: "2026-05 services-to-infra rename path update"
tags: ["fleet-core", "pi-fleet-extension", "tool-snapshot", "mcp", "invariant", "trap"]
---
The 2026-04 wiki entry tool-snapshot-single-store-invariant referenced packages/fleet-core/src/services/tool-registry/tool-snapshot.ts. The 2026-05 fleet-core-public-services-4-unification mission renamed src/services/ to src/infra/ via git mv. The new canonical path is packages/fleet-core/src/infra/tool-registry/tool-snapshot.ts. The single-store invariant itself is unchanged; pi-fleet-extension still must not re-implement, copy, or shadow the snapshot store. MCP HTTP server in admiral/_shared/mcp.ts still reads from this single store.
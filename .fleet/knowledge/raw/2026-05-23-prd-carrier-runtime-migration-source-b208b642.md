---
id: "prd-carrier-runtime-migration-source"
created: "2026-05-23T07:22:44.922Z"
sourceType: "inline"
title: "PRD: 캐리어 런타임 도메인의 fleet-carriers 이관"
tags: ["carrier", "fleet-carriers", "fleet-core", "fleet-infra", "carrier-runtime", "package-migration", "architecture", "dependency-injection"]
contentHash: "b208b642"
---
## Source: Nimitz Task Force Cross-Validation (Claude, Codex, Cursor)

**Structural Decision:** Migrate fleet-core's carrier dispatch, carrier-jobs lookup, store persistence, and TaskForce multi-backend execution domain into fleet-carriers. fleet-carriers, previously a leaf package containing only persona metadata, is promoted to own the entire carrier runtime. The dependency graph inverts: fleet-carriers→fleet-core becomes fleet-core→fleet-carriers.

**Key Structural Rationale:**
- carrier and taskforce share identical fleet-infra/job symbols and the same detached-job lifecycle (startDetachedJob→appendBlock→finalizeDetachedJob). They are structurally one dispatch domain, not two separate modules.
- The store monolith uses a single `updateStates(mutator)`+`withStoreLock()` gate for all mutations. This I/O gate pattern makes natural decomposition possible: domain files share the gate while being independently editable.
- Inverting dependencies is the critical step in the fleet-core removal roadmap. When fleet-carriers consumes fleet-infra directly, fleet-core is downgraded to a re-export facade, and long-term direct fleet-carriers consumption by downstream packages enables complete fleet-core removal.

**DI Pattern Decisions (3-backend consensus):**
- agent-specs.ts side-effect import (auto-execution on import) → explicit `registerDefaultCarriers()` boot function. This is the only mandatory DI change; the rest maintain current patterns.
- globalThis singleton for cross-package single instance → keep pattern, add `resetFrameworkState()` for test isolation. Parameter threading a registry through 8 registration points and all consumers is over-engineering for a single-process CLI.
- store direct import of state-io.ts → maintain as single-module I/O gate, not a service locator. Test isolation via `vi.mock("./state-io.js")` is sufficient.
- fleet-carriers service boundary → namespace re-export facade, not a `CarrierRuntime` interface. The admiral object already serves as contract; a separate interface creates dual maintenance burden.
- events Set-based registry → maintain. EventEmitter adds unnecessary async error handling, listener ordering, and memory leak management complexity. `clearStreamHandlers()` already exists for test isolation.

**Planning Constraints:**
- `carrier_dispatch` remains the sole public carrier delegation entrypoint. TaskForce is an internal auto-promotion mode with no separate tool surface.
- `updateStates(mutator)` signature is immutable during store decomposition.
- fleet-core admiral facade namespace keys (carrier, carrierJobs, store) must be preserved unchanged.
- fleet-carriers must not import fleet-core; reverse dependency is fully blocked.
- `fleet-infra/src/job/` does not move; fleet-carriers consumes it directly via subpath.
- fleet-core frozen public API contract (3 entrypoints: root, /admiral, /admiralty) must show zero breaking changes.
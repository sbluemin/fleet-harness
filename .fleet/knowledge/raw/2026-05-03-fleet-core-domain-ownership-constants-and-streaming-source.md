---
id: "fleet-core-domain-ownership-constants-and-streaming-source"
created: "2026-05-03T16:17:41.480Z"
sourceType: "inline"
title: "2026-05 admiral D-alpha and D-beta rulings"
tags: ["fleet-core", "domain-ownership", "doctrine", "decision-log", "invariant"]
---
During Kirov plan_file authoring for the fleet-core public-services-4-unification mission, two domain-ownership questions were left undecided and escalated to admiral. Admiral resolved them as locked decisions D-alpha and D-beta. D-alpha: ./constants subpath was removed; the constants source files (CARRIER_COLORS, CARRIER_BG_COLORS, CARRIER_RGBS, CLI_DISPLAY_NAMES, CLI_PROVIDER_DISPLAY_NAMES, CARRIER_DISPLAY_NAMES, VALID_CLI_TYPES, CLI_TYPE_DISPLAY_ORDER) belong to admiral domain (CLI/Carrier semantics). Attached to admiral.constants slot. D-beta: carrier job stream events stay under admiral.carrierJobs.streaming. infra.job.streaming does NOT exist. Reasoning: TrackStatus SSoT lives in admiral/_shared/carrier-job-events.ts so source of truth is admiral; carrier_jobs dispatch and streaming have stronger cohesion when colocated; infra is reserved for cross-cutting infrastructure primitives only.
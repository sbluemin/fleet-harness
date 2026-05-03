---
id: "fleet-services-tools-lazy-getter-source"
created: "2026-05-03T16:19:09.790Z"
sourceType: "inline"
title: "2026-05 supersession of FleetServices.tools lazy getter"
tags: ["fleet-core", "superseded", "doctrine", "history", "tool-spec"]
---
The 2026-04 wiki entry fleet-services-tools-lazy-getter required FleetServices.tools to be a lazy getter that re-evaluated buildFleetToolSpecs on every read. The 2026-05 fleet-core-public-services-4-unification mission removed FleetServices entirely. Default Fleet tool specs are now auto-registered when the admiral.agent facade is loaded; consumers access tools through runtime.admiral.agent.tools.list/invoke/registerExtraTools/unregisterExtraTools. There is no longer a getter on any public service object.
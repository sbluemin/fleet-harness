---
id: "prd-tui-cli-bay-source"
created: "2026-05-24T11:11:20.616Z"
sourceType: "inline"
title: "Conversation brief: CLI Bay MVP product direction"
tags: ["fleet-tui", "fleet-agent", "dedicated-cli", "mission-control", "cli-bay", "region-stack", "ux"]
contentHash: "388a12f5"
---
User reported that when Claude or Codex exits through supported exit commands, the dedicated CLI area remains blank and the PTY cannot be recovered. The product direction discussed is to preserve Claude and Codex as first-class CLIs while making fleet-harness Mission Control own the presented screen. Instead of presenting a raw PTY as the first screen, a Fleet-defined interactive region should host launcher, active CLI, exited state, transcript, and recovery actions. The MVP should use the region-stack as the user-facing navigation model so process exit becomes a region transition rather than a dead blank screen. Related Fleet Wiki orientation confirmed PRD template requirements and relevant existing entries for fleet overview, carrier status, dedicated CLI options, keyboard protocol, and mouse routing.
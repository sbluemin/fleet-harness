---
id: "prd-tui-mission-control-source"
created: "2026-05-24T11:19:54.420Z"
sourceType: "inline"
title: "Conversation brief: Mission Control MVP product direction"
tags: ["fleet-tui", "fleet-agent", "dedicated-cli", "mission-control", "region-stack", "ux"]
contentHash: "f512572c"
---
User reported that when Claude or Codex exits through supported exit commands, the dedicated CLI area remains blank and the PTY cannot be recovered. The final product name is defined as Mission Control. The product direction is to preserve Claude and Codex as first-class CLIs while making fleet-harness Mission Control own the presented screen. Instead of presenting a raw PTY as the first screen, a Fleet-defined interactive region should host launcher, active CLI, ended state, transcript, and recovery actions. The MVP should use a Fleet-owned state surface for the upper dedicated area so process exit becomes a Mission Control state transition rather than a dead blank screen. Related Fleet Wiki orientation confirmed PRD template requirements and relevant existing entries for fleet overview, carrier status, dedicated CLI options, keyboard protocol, and mouse routing.
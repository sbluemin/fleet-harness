---
id: "synthesis-fleet-console-main-dashboard-research-source"
created: "2026-06-14T03:13:07.212Z"
sourceType: "inline"
title: "2026-06-14 Fleet Console main dashboard and Mission Control investigation"
tags: ["synthesis", "fleet-console", "fleet-cli", "mission-control", "dashboard", "ux", "product"]
contentHash: "d0bb6521"
---
Investigation performed on 2026-06-14 in the feat-fleet-console worktree. Evidence included browser automation against the local Fleet Console at /console, direct execution of pnpm fleet to inspect Mission Control, Fleet Wiki orientation and briefing results, and source inspection of the console routing, Codex mount behavior, Mission Control root/menu behavior, authentication panel, wiki server panel, diagnostics panel, about panel, and carrier roster documentation. Observed console state: main page showed workspace/live job/connection summary and Operations CTA; Operations had no active Admiral station in the selected Theater; Codex exposed reading, command palette, Drydock, Index, Log, and Conflicts for Wiki-enabled Theaters and unavailable state for a Theater without Wiki data. Observed CLI state: Mission Control root grouped actions into LAUNCH, OPTION, and SYSTEM; launch choices included Claude, Claude Kimi, and Codex; options included Fleet Action mode, system prompt Append/Replace, and metaphor Enabled/Off; system included Carrier Roster, System Menu, and Exit; System Menu led to Authentication, Wiki Server, Diagnostics, and About.
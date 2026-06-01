---
id: "guide-004-cli-subagent-injection-source"
created: "2026-06-01T13:25:35.349Z"
sourceType: "inline"
title: "Carrier doc sortie — guide-004 prefix-free contract 정합화 근거, 2026-06-01"
tags: ["guide", "cli", "sub-agent", "native-subagent", "claude-code", "codex", "opencode", "spawn", "comparison", "fleet-cli", "dedicated-cli", "carrier", "current"]
contentHash: "89c3a393"
---
Design contract update issued 2026-06-01 by Admiral directive. Key changes from prior entry (v1, 2026-05-31): (1) fleet_ prefix fully removed from all Codex role keys — role key, TOML name field, filename, and agents.&lt;roleKey&gt;.* argv now use bare carrier id (e.g. vanguard, not fleet_vanguard; file vanguard.toml; name="vanguard"; -c agents.vanguard.*). Reserved-name guard against Codex built-in roles (default/explorer/worker/awaiter) is retained and surfaces as an error. (2) Storage is global ~/.fleet/codex-agents/&lt;roleKey&gt;.toml; file I/O owned by fleet-carriers store. Per-session UUID subdirectory scheme, orphan sweep, and per-session cleanup are removed. (3) Model and reasoning effort are serialized in role TOML as model and model_reasoning_effort fields; the former effort field is dropped because Codex rejects it. (4) native=true triggers full injection skip (no TOML written, no argv injected); TUI toggle colors are Rose (enabled) and Magenta (SA/native). (5) Claude Code continues using existing --agents inline JSON path unchanged. Rejected patch bed601c0 (2026-06-01) was the prior attempt that still carried the fleet_ prefix.
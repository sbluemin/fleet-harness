---
id: "guide-004-cli-subagent-injection-source"
created: "2026-05-31T09:21:56.506Z"
sourceType: "inline"
title: "Codex native subagent spawn-time research insights, 2026-05-31"
tags: ["guide", "cli", "sub-agent", "native-subagent", "claude-code", "codex", "opencode", "spawn", "comparison", "fleet-cli", "dedicated-cli", "carrier", "current"]
contentHash: "64d34adf"
---
Research synthesis from Fleet carrier reconnaissance and review on 2026-05-31. Key evidence: local Codex CLI 0.135.0 exposes multi_agent stable true and multi_agent_v2 under development false; official OpenAI Codex subagents documentation states custom agents are TOML files; upstream Codex source shows AgentRoleToml descriptor supports description/config_file/nickname_candidates while developer_instructions is parsed from role TOML. Fleet jobs consulted: carrier:795b1505-fd5c-4150-8515-8628b3a3b757, carrier:97b10df7-3b0e-4abd-b48c-ba73fae2a8c1, carrier:3e853a2e-8e39-40f9-8833-711a76c547c7, carrier:2fcf044f-b691-4d88-9776-10e95ff0896f, carrier:b5f304be-ab55-4ea7-8d76-12c328adc062, taskforce:86aaeea8-2b3f-4538-9533-82a5c2611b0b, taskforce:0a53fd24-5104-4764-8a54-18a98d382f14, carrier:153a7bc7-3b5b-4b52-ba19-63c7485d7ceb.
---
id: "guide-004-cli-subagent-injection-source"
created: "2026-06-01T14:32:45.800Z"
sourceType: "inline"
title: "Carrier doc sortie — guide-004 Codex sidecar mechanism finalization, 2026-06-01"
tags: ["guide", "cli", "sub-agent", "native-subagent", "claude-code", "codex", "opencode", "spawn", "comparison", "fleet-cli", "dedicated-cli", "carrier", "current"]
contentHash: "a0d6c283"
---
Design contract update issued 2026-06-01 by Admiral directive. Key changes from prior entry (v2, 2026-06-01): (1) The Codex subagent persona is no longer embedded inline as `developer_instructions` in the role TOML. Instead, it is written as a RAW sidecar file at `~/.fleet/codex-agents/<roleKey>.md` (no TOML escaping), and the role TOML at `~/.fleet/codex-agents/<roleKey>.toml` references it via `model_instructions_file = "<absolute path>"`. (2) Storage is now two files per role: `.toml` (role descriptor) + `.md` (raw instructions). Both are atomic write / 0700-dir / 0600-file / path-confined. (3) Effect: the subagent's base_instructions become a FULL REPLACE with the carrier persona (not a supplemental developer message). The role-layer `model_instructions_file` overrides the host's same-key value, while the host spawn path is unchanged. (4) The `model_instructions_file` "discouraged" caveat is acceptable since the host already uses it. (5) The "why not inline developer_instructions" section is removed as it is no longer relevant. (6) Claude Code path remains unchanged.
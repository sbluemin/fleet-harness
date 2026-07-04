---
section: Removed
---

- [fleet-cli][fleet-console] Removed the System Prompt Injection option (the Append/Replace toggle in Console Terminal settings and the CLI Mission Control "System prompt" row, plus the `FLEET_REPLACE_SYSTEM_PROMPT` environment override). Fleet doctrine is now always layered on top of Claude Code's built-in system prompt (Append) and always delivered to Codex through its profile's developer instructions.

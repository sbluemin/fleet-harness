# Fake agy ACP

Use this when the claim needs the isolated Console's real Gateway↔agy ACP path, not a real model answer. On macOS/Linux, [`scripts/fake-agy.mjs`](../scripts/fake-agy.mjs) is an executable adapter over the existing runtime unit fake; it requires the full checkout, not just a copied script. Keep goal-specific edge cases in that goal's fixtures.

Follow the existing [isolated Console setup](setup.md) and add these values to its wrapper invocation **before starting the host**:

```text
--set FLEET_ANTIGRAVITY_CLI=<worktree>/.claude/skills/console-e2e/scripts/fake-agy.mjs
--set FAKE_AGY_LOG=<run-dir>/fake-agy.jsonl
```

Use absolute checkout and owned run-directory paths. The executable's header owns the inputs, defaults, consumption points, and log fields; inspect it when choosing a model or overriding the available models. Its minimal usage response makes the fake account visible to Console, not a real signed-in account.

`FLEET_ANTIGRAVITY_CLI` selects the Gateway's agy child, not the host's agent CLI. The separate [fake Claude](setup.md#no-cost-fake-claude), selected through `CLAUDE_BIN`, is a host fixture and sends no Gateway requests. Only when the claim needs a real client→Gateway turn, use the existing [live-agent route](live-agent-prompt-testing.md#headless-claude-code-against-the-owned-console) with its isolation and trust preflight. This grants no real agy, account, or paid-call authority.

The JSONL records structural call metadata rather than prompt bodies. The reused fake still reads the session's MCP configuration and can send authenticated HTTP requests to the configured Console MCP endpoint and call tools; use only the owned isolated endpoint and synthetic prompts. Do not describe the run as network-free or assume arbitrary logs are secret-free.

A pass establishes the exercised Gateway/ACP path and synthetic responses. It does not establish real login, provider failure timing, quota accuracy, or model judgment.

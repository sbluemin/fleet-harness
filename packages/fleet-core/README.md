# @sbluemin/fleet-core

`@sbluemin/fleet-core` is the host-agnostic product core for Fleet: agent runtime contracts, tool registry contracts, MCP registry surface, prompt assets, and adapter-facing types. It exposes high-level domain facades through the `admiral` (agent, mcp, protocols) and `admiralty` namespaces. Host-agnostic runtime infrastructure belongs in `@sbluemin/fleet-infra`, and CLI host runtime integration belongs in `@sbluemin/fleet-agent`.

Runtime data defaults to `.fleet`, including the active auth store at `~/.fleet/auth.json` and the data directory at `~/.fleet/`. The former `~/.fleet/agent/auth.json` path is treated only as a merge-only migration input.

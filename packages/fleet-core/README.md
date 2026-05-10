# @sbluemin/fleet-core

`@sbluemin/fleet-core` is the Pi-agnostic product core for Fleet: agent runtime contracts, tool registry contracts, MCP registry surface, job services, prompt assets, and adapter-facing types. Pi runtime integration belongs in `@sbluemin/fleet-harness-extension`.

Fleet-owned runtime data defaults to `.fleet`, including the auth store at `~/.fleet/agent/auth.json` and the fleet data directory at `~/.fleet/`.

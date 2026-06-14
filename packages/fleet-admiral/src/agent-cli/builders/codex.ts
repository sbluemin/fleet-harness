import type { AgentCliInjectionContext } from "../types.js";
import { escapeTomlBasicString } from "./toml.js";

const CODEX_TOOL_TIMEOUT_SEC = 1_800;

export function buildCodexNativeArgs(context: AgentCliInjectionContext): string[] {
  const profileName = requireCodexProfileName(context);
  const args = [
    "--enable",
    "plugins",
    "--enable",
    "child_agents_md",
    "--profile",
    profileName,
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="danger-full-access"',
  ];
  for (const server of context.mcpServers) {
    const prefix = `mcp_servers.${server.name}`;
    const bearerHeader = `Bearer ${server.bearerToken}`;
    args.push(
      "-c",
      `${prefix}.url="${escapeTomlBasicString(server.endpointUrl)}"`,
      "-c",
      `${prefix}.http_headers={"Authorization" = "${escapeTomlBasicString(bearerHeader)}"}`,
      "-c",
      `${prefix}.tool_timeout_sec=${CODEX_TOOL_TIMEOUT_SEC}`,
    );
  }
  return args;
}

function requireCodexProfileName(context: AgentCliInjectionContext): string {
  if (context.codexProfileName) return context.codexProfileName;
  throw new Error("Codex profile name is required for native injection");
}

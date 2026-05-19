import type { DedicatedCliInjectionContext } from "../types.js";
import { escapeTomlBasicString } from "./toml.js";

const FLEET_TOOLS_MCP_SERVER = "fleet-tools";
const CODEX_TOOL_TIMEOUT_SEC = 1_800;

export function buildCodexNativeArgs(context: DedicatedCliInjectionContext): string[] {
  const prefix = `mcp_servers.${FLEET_TOOLS_MCP_SERVER}`;
  const bearerHeader = `Bearer ${context.bearerToken}`;
  return [
    "-c",
    `developer_instructions="${escapeTomlBasicString(context.systemPrompt)}"`,
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="danger-full-access"',
    "-c",
    `${prefix}.url="${escapeTomlBasicString(context.endpointUrl)}"`,
    "-c",
    `${prefix}.http_headers={"Authorization" = "${escapeTomlBasicString(bearerHeader)}"}`,
    "-c",
    `${prefix}.tool_timeout_sec=${CODEX_TOOL_TIMEOUT_SEC}`,
  ];
}

import type { AgentCliInjectionContext } from "../types.js";
import { escapeTomlBasicString } from "./toml.js";

const CODEX_TOOL_TIMEOUT_SEC = 1_800;

export function buildCodexNativeArgs(context: AgentCliInjectionContext): string[] {
  const profileName = requireCodexProfileName(context);
  const args = [
    ...buildResumeArgs(context.resumeSessionId),
    "--enable",
    "plugins",
    "--enable",
    "hooks",
    "--profile",
    profileName,
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="danger-full-access"',
    // hook 신뢰 프롬프트("Hooks need review")를 fleet 관리 세션에서 건너뛴다. bypass_hook_trust는
    // config 키가 아니라 전용 CLI 플래그이므로 -c override가 아닌 플래그로 전달해야 한다.
    "--dangerously-bypass-hook-trust",
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

function buildResumeArgs(resumeSessionId: string | undefined): string[] {
  return resumeSessionId === undefined ? [] : ["resume", resumeSessionId];
}

function requireCodexProfileName(context: AgentCliInjectionContext): string {
  if (context.codexProfileName) return context.codexProfileName;
  throw new Error("Codex profile name is required for native injection");
}

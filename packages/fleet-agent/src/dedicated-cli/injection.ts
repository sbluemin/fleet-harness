import type { FleetCoreRuntimeContext } from "../runtime/runtime.js";
import { buildClaudeNativeArgs } from "./builders/claude.js";
import { buildCodexNativeArgs } from "./builders/codex.js";
import { getDedicatedCliInjectionCapability } from "./capabilities.js";
import type { DedicatedCliInjectionContext, DedicatedCliProfile } from "./types.js";

export async function injectDedicatedCliProfile(
  profile: DedicatedCliProfile,
  rt: FleetCoreRuntimeContext,
): Promise<DedicatedCliProfile> {
  const capability = getDedicatedCliInjectionCapability(profile.id);
  if (!capability.enabled) {
    return profile;
  }

  const endpoint = await rt.admiral.mcp.getEndpoint();
  const context: DedicatedCliInjectionContext = {
    bearerToken: rt.admiral.mcp.issueDedicatedSessionToken({
      cwd: profile.cwd,
      label: `dedicated:${profile.id}`,
    }),
    cliId: profile.id,
    endpointUrl: endpoint.url,
    systemPrompt: rt.admiral.prompts.buildSystemPrompt(),
  };
  const injectedArgs = buildDedicatedCliArgs(capability.builderId, context);
  return {
    ...profile,
    args: [...profile.args, ...injectedArgs],
    env: { ...profile.env },
  };
}

function buildDedicatedCliArgs(
  builderId: "claude-native" | "codex-native",
  context: DedicatedCliInjectionContext,
): string[] {
  switch (builderId) {
    case "claude-native":
      return buildClaudeNativeArgs(context);
    case "codex-native":
      return buildCodexNativeArgs(context);
  }
}

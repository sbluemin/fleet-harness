import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExecutorSessionManager } from "@dotobokuri/fleet-mcp-server";

import { buildClaudeNativeArgs } from "./builders/claude.js";
import { buildCodexNativeArgs } from "./builders/codex.js";
import { getDedicatedCliInjectionCapability } from "./capabilities.js";
import type { DedicatedCliInjectionContext, DedicatedCliProfile } from "./types.js";

export interface InjectDedicatedCliProfileOptions {
  readonly buildSystemPrompt: (injectTone: boolean) => string;
  readonly dedicatedMcpSession: ExecutorSessionManager;
  readonly replaceSystemPrompt?: boolean;
  readonly enableMetaphor?: boolean;
}

export async function injectDedicatedCliProfile(
  profile: DedicatedCliProfile,
  options: InjectDedicatedCliProfileOptions,
): Promise<DedicatedCliProfile> {
  const capability = getDedicatedCliInjectionCapability(profile.id);
  if (!capability.enabled) {
    return profile;
  }

  const injectTone = options.enableMetaphor ?? false;
  const endpoint = await options.dedicatedMcpSession.getEndpoint();
  const tokens = options.dedicatedMcpSession.issueSessionToken({
    cwd: profile.cwd,
    label: `dedicated:${profile.id}`,
  });
  const systemPromptFile = writeSystemPromptFile(profile.id, options.buildSystemPrompt(injectTone));
  const context: DedicatedCliInjectionContext = {
    cliId: profile.id,
    mcpServers: buildDedicatedCliMcpServerConfigs(endpoint.servers, tokens),
    replaceSystemPrompt: options.replaceSystemPrompt ?? false,
    systemPromptFile,
  };
  const injectedArgs = buildDedicatedCliArgs(capability.builderId, context);
  return {
    ...profile,
    args: [...profile.args, ...injectedArgs],
    env: { ...profile.env },
  };
}

function buildDedicatedCliMcpServerConfigs(
  endpoints: readonly { readonly name: string; readonly url: string }[],
  tokens: readonly { readonly name: string; readonly token: string }[],
): DedicatedCliInjectionContext["mcpServers"] {
  return endpoints.map((endpoint) => {
    const token = tokens.find((entry) => entry.name === endpoint.name)?.token;
    if (!token) {
      throw new Error(`Dedicated MCP token missing for ${endpoint.name}`);
    }
    return {
      name: endpoint.name,
      endpointUrl: endpoint.url,
      bearerToken: token,
    };
  });
}

function writeSystemPromptFile(cliId: string, systemPrompt: string): string {
  const filePath = path.join(os.tmpdir(), `fleet-${cliId}-system-prompt.md`);
  writeFileSync(filePath, systemPrompt, "utf8");
  return filePath;
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

import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { admiral } from "@sbluemin/fleet-core";

import { buildClaudeNativeArgs } from "./builders/claude.js";
import { buildCodexNativeArgs } from "./builders/codex.js";
import { getDedicatedCliInjectionCapability } from "./capabilities.js";
import type { DedicatedCliInjectionContext, DedicatedCliProfile } from "./types.js";

export interface InjectDedicatedCliProfileOptions {
  readonly replaceSystemPrompt?: boolean;
  readonly enableMetaphor?: boolean;
}

export async function injectDedicatedCliProfile(
  profile: DedicatedCliProfile,
  options: InjectDedicatedCliProfileOptions = {},
): Promise<DedicatedCliProfile> {
  const capability = getDedicatedCliInjectionCapability(profile.id);
  if (!capability.enabled) {
    return profile;
  }

  const injectTone = options.enableMetaphor ?? false;
  const endpoint = await admiral.mcp.getEndpoint();
  const systemPromptFile = writeSystemPromptFile(profile.id, admiral.prompts.buildSystemPrompt(injectTone));
  const context: DedicatedCliInjectionContext = {
    bearerToken: admiral.mcp.issueDedicatedSessionToken({
      cwd: profile.cwd,
      label: `dedicated:${profile.id}`,
    }),
    cliId: profile.id,
    endpointUrl: endpoint.url,
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

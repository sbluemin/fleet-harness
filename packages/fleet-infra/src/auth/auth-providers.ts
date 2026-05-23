import type { CliType } from "@sbluemin/fleet-unified-agent";

import { createAuthService } from "./auth-storage.js";
import { formatMissingAuthKeyMessage } from "./messages.js";
import { migrateLegacyAuthStore } from "./migration.js";
import type {
  AuthValidationFailureResult,
  AuthValidationFailureStatus,
} from "./types.js";
import {
  createAuthValidationError,
  isAuthValidationSuccess,
  validateAnthropicCompatibleApiKey,
} from "./validation.js";

interface AuthProviderDefinition {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly env: Record<string, string>;
}

export const CLI_TO_AUTH_PROVIDER_ID: Partial<Record<CliType, string>> = {
  "claude-zai": "Claude Code with Z.AI GLM",
  "claude-kimi": "Claude Code with Moonshot Kimi",
};

const CLAUDE_ZAI_PROVIDER_ID = "Claude Code with Z.AI GLM";
const CLAUDE_KIMI_PROVIDER_ID = "Claude Code with Moonshot Kimi";

const AUTH_PROVIDER_DEFINITIONS: Partial<Record<CliType, AuthProviderDefinition>> = {
  "claude-zai": {
    providerId: CLAUDE_ZAI_PROVIDER_ID,
    baseUrl: "https://api.z.ai/api/anthropic",
    env: {
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      API_TIMEOUT_MS: "3000000",
    },
  },
  "claude-kimi": {
    providerId: CLAUDE_KIMI_PROVIDER_ID,
    baseUrl: "https://api.kimi.com/coding/",
    env: {
      ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_SUBAGENT_MODEL: "kimi-k2.5",
      API_TIMEOUT_MS: "3000000",
    },
  },
};

export async function resolveAuthEnv(
  cli: CliType,
): Promise<Record<string, string>> {
  const provider = AUTH_PROVIDER_DEFINITIONS[cli];
  if (!provider) return {};
  await migrateLegacyAuthStore();
  const auth = createAuthService();
  const token = await auth.getApiKey(provider.providerId);
  if (!token) {
    throw new Error(formatMissingAuthKeyMessage({ cli, providerId: provider.providerId }));
  }
  const validation = await validateAnthropicCompatibleApiKey({
    providerId: provider.providerId,
    apiKey: token,
    baseUrl: provider.baseUrl,
  });
  if (!isAuthValidationSuccess(validation)) {
    const failure: AuthValidationFailureResult = {
      providerId: validation.providerId,
      status: validation.status as AuthValidationFailureStatus,
      detail: validation.detail,
    };
    throw createAuthValidationError(failure);
  }
  return { ...provider.env, ANTHROPIC_AUTH_TOKEN: token };
}

export async function validateAuthKeyForCli(
  cli: CliType,
  apiKey: string,
): Promise<AuthValidationFailureResult | { providerId: string; status: "success" }> {
  const provider = AUTH_PROVIDER_DEFINITIONS[cli];
  if (!provider) {
    return { providerId: cli, status: "success" };
  }

  const validation = await validateAnthropicCompatibleApiKey({
    providerId: provider.providerId,
    apiKey,
    baseUrl: provider.baseUrl,
  });
  if (isAuthValidationSuccess(validation)) {
    return { providerId: validation.providerId, status: "success" };
  }
  return {
    providerId: validation.providerId,
    status: validation.status as AuthValidationFailureStatus,
    detail: validation.detail,
  };
}

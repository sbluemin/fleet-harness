import { CLI_BACKENDS, type CliType } from "@dotobokuri/core-unified-agent";

import { createAuthService, DEFAULT_AUTH_PATH } from "./auth-storage.js";
import { formatMissingAuthKeyMessage } from "./messages.js";
import { migrateLegacyAuthStore } from "./migration.js";
import type {
  AuthService,
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

// providerId 문자열은 ~/.fleet/auth.json 영속 키이므로 derive 금지 — 리터럴로 유지한다.
export const CLI_TO_AUTH_PROVIDER_ID: Partial<Record<CliType, string>> = {
  "claude-zai": "Claude Code with Z.AI GLM",
  "claude-kimi": "Claude Code with Moonshot Kimi",
};

const CLAUDE_ZAI_PROVIDER_ID = "Claude Code with Z.AI GLM";
const CLAUDE_KIMI_PROVIDER_ID = "Claude Code with Moonshot Kimi";

// env·baseUrl은 CLI provider 카탈로그 SSoT인 CLI_BACKENDS.defaultEnv에서 파생한다.
// spawn env(UnifiedClaudeAgentClient)와 auth 검증 env가 갈라지는 회귀를 차단한다.
const AUTH_PROVIDER_DEFINITIONS: Partial<Record<CliType, AuthProviderDefinition>> = {
  "claude-zai": {
    providerId: CLAUDE_ZAI_PROVIDER_ID,
    baseUrl: CLI_BACKENDS["claude-zai"].defaultEnv.ANTHROPIC_BASE_URL,
    env: CLI_BACKENDS["claude-zai"].defaultEnv,
  },
  "claude-kimi": {
    providerId: CLAUDE_KIMI_PROVIDER_ID,
    baseUrl: CLI_BACKENDS["claude-kimi"].defaultEnv.ANTHROPIC_BASE_URL,
    env: CLI_BACKENDS["claude-kimi"].defaultEnv,
  },
};

export async function resolveAuthEnv(
  cli: CliType,
  deps?: { authService?: AuthService },
): Promise<Record<string, string>> {
  const provider = AUTH_PROVIDER_DEFINITIONS[cli];
  if (!provider) return {};
  await migrateLegacyAuthStore();
  const auth = deps?.authService ?? createAuthService({ authPath: DEFAULT_AUTH_PATH });
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

import {
  CLI_BACKENDS,
  type CliType,
} from "@dotobokuri/core-unified-agent";
import {
  isAuthValidationSuccess,
  validateAnthropicCompatibleApiKey,
  type AuthService,
  type AuthValidationFailureResult,
  type AuthValidationFailureStatus,
} from "@dotobokuri/core-infra";

import {
  buildKimiModelEnv,
  resolveKimiModelSelection,
  type KimiModelSelection,
} from "./kimi-model.js";

export const KIMI_AUTH_PROVIDER_ID = "Claude Code with Moonshot Kimi";

export const CLI_TO_AUTH_PROVIDER_ID: Partial<Record<CliType, string>> = {
  "claude-kimi": KIMI_AUTH_PROVIDER_ID,
};

export interface AgentCliAuthStatus {
  readonly cli: CliType;
  readonly signedIn: boolean;
}

export async function resolveAgentCliAuthEnv(
  cli: CliType,
  authService: Pick<AuthService, "getApiKey"> | undefined,
  selection?: KimiModelSelection,
): Promise<Record<string, string>> {
  if (cli !== "claude-kimi") return {};
  const token = await authService?.getApiKey(KIMI_AUTH_PROVIDER_ID);
  if (!token) {
    throw new Error(
      "Kimi sign-in is required. Run `fleet auth login claude-kimi` or sign in from Fleet Console settings.",
    );
  }
  return {
    ...CLI_BACKENDS[cli].defaultEnv,
    ...buildKimiModelEnv(selection ?? resolveKimiModelSelection(undefined)),
    ANTHROPIC_API_KEY: token,
  };
}

export async function validateAgentCliAuthKey(
  cli: CliType,
  apiKey: string,
): Promise<AuthValidationFailureResult | { readonly providerId: string; readonly status: "success" }> {
  const providerId = CLI_TO_AUTH_PROVIDER_ID[cli];
  if (!providerId || cli !== "claude-kimi") {
    return { providerId: cli, status: "success" };
  }
  const backendEnv = CLI_BACKENDS[cli].defaultEnv;
  const validation = await validateAnthropicCompatibleApiKey({
    providerId,
    apiKey,
    baseUrl: backendEnv.ANTHROPIC_BASE_URL,
    model: backendEnv.ANTHROPIC_MODEL,
  });
  if (isAuthValidationSuccess(validation)) {
    return { providerId, status: "success" };
  }
  return {
    providerId,
    status: validation.status as AuthValidationFailureStatus,
    detail: validation.detail,
  };
}

export async function getAgentCliAuthStatuses(
  authService: Pick<AuthService, "listProviderIds">,
): Promise<readonly AgentCliAuthStatus[]> {
  const configured = new Set(await authService.listProviderIds());
  return [{
    cli: "claude-kimi",
    signedIn: configured.has(KIMI_AUTH_PROVIDER_ID),
  }];
}

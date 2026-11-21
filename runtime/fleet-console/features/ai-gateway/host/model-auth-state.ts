import { ANTHROPIC_AUTH_PROVIDER_ID, GEMINI_AUTH_PROVIDER_ID, OPENCODE_AUTH_PROVIDER_ID } from "@fleet-console/ai-gateway";
import type { AuthService } from "@fleet-console/ai-gateway";

export type TerminalModelAuthProviderId = "opencode" | "gemini" | "anthropic";

export interface TerminalModelAuthProviderState {
  readonly provider: TerminalModelAuthProviderId;
  readonly displayName: string;
  readonly signedIn: boolean;
}

export interface TerminalModelAuthState {
  readonly providers: readonly TerminalModelAuthProviderState[];
}

/** Route provider id → persisted auth-store provider id. */
export const MODEL_AUTH_STORE_IDS: Readonly<Record<TerminalModelAuthProviderId, string>> = Object.freeze({
  opencode: OPENCODE_AUTH_PROVIDER_ID,
  gemini: GEMINI_AUTH_PROVIDER_ID,
  anthropic: ANTHROPIC_AUTH_PROVIDER_ID,
});

const MODEL_AUTH_DISPLAY_NAMES: Readonly<Record<TerminalModelAuthProviderId, string>> = Object.freeze({
  opencode: "OpenCode Go",
  gemini: "Gemini",
  anthropic: "Anthropic",
});

export function isTerminalModelAuthProviderId(value: string): value is TerminalModelAuthProviderId {
  return value in MODEL_AUTH_STORE_IDS;
}

export async function buildModelAuthState(
  authService: Pick<AuthService, "listProviderIds">,
): Promise<TerminalModelAuthState> {
  const signedInIds = new Set(await authService.listProviderIds());
  return {
    providers: (Object.keys(MODEL_AUTH_STORE_IDS) as TerminalModelAuthProviderId[]).map((provider) => ({
      provider,
      displayName: MODEL_AUTH_DISPLAY_NAMES[provider],
      signedIn: signedInIds.has(MODEL_AUTH_STORE_IDS[provider]),
    })),
  };
}

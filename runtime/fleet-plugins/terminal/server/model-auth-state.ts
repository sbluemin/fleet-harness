import {
  KIMI_AUTH_PROVIDER_ID,
} from "@dotobokuri/fleet-admiral";
import type { AuthService } from "@dotobokuri/core-infra";

export interface TerminalModelAuthProviderState {
  readonly cli: "claude-kimi";
  readonly displayName: string;
  readonly signedIn: boolean;
}

export interface TerminalModelAuthState {
  readonly providers: readonly TerminalModelAuthProviderState[];
}

export async function buildModelAuthState(
  authService: Pick<AuthService, "listProviderIds">,
): Promise<TerminalModelAuthState> {
  const signedInIds = new Set(await authService.listProviderIds());
  return {
    providers: [{
      cli: "claude-kimi",
      displayName: "Kimi via Claude Code",
      signedIn: signedInIds.has(KIMI_AUTH_PROVIDER_ID),
    }],
  };
}

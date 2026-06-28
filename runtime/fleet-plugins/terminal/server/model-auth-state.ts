import type { CliType } from "@dotobokuri/core-unified-agent";
import {
  CLI_TO_AUTH_PROVIDER_ID,
  type AuthService,
} from "@dotobokuri/fleet-infra/auth";

interface TerminalModelAuthProviderDefinition {
  readonly cli: CliType;
  readonly displayName: string;
}

export interface TerminalModelAuthProviderState {
  readonly cli: string;
  readonly displayName: string;
  readonly signedIn: boolean;
}

export interface TerminalModelAuthState {
  readonly providers: readonly TerminalModelAuthProviderState[];
}

// Terminal model sign-in provider 화이트리스트. 다른 provider(claude-zai 등)는
// 의도적으로 제외한다. 경로로 들어온 임의 cli는 이 목록 대조로만 통과한다.
// displayName은 브라우저-안전 표기만 쓴다 — providerId(저장 키)는 절대 노출하지 않는다(Token Boundary).
export const TERMINAL_MODEL_AUTH_PROVIDERS: readonly TerminalModelAuthProviderDefinition[] = [
  { cli: "claude-kimi", displayName: "Moonshot Kimi" },
  { cli: "claude-glm", displayName: "ZhipuAI GLM" },
];

export async function buildModelAuthState(
  authService: Pick<AuthService, "listProviderIds">,
): Promise<TerminalModelAuthState> {
  const signedInIds = new Set(await authService.listProviderIds());
  return {
    providers: TERMINAL_MODEL_AUTH_PROVIDERS.map((provider) => toProviderState(provider, signedInIds)),
  };
}

function toProviderState(
  provider: TerminalModelAuthProviderDefinition,
  signedInIds: ReadonlySet<string>,
): TerminalModelAuthProviderState {
  // providerId(= ~/.fleet/auth.json 영속 키)는 signedIn 판정에만 쓰고 브라우저 DTO로는 내보내지 않는다(Token Boundary).
  const providerId = CLI_TO_AUTH_PROVIDER_ID[provider.cli] ?? provider.cli;
  return {
    cli: provider.cli,
    displayName: provider.displayName,
    signedIn: signedInIds.has(providerId),
  };
}

import { KIMI_AUTH_PROVIDER_ID, OPENCODE_AUTH_PROVIDER_ID, TYPESAFE_AUTH_PROVIDER_ID } from "@fleet-console/ai-gateway";
import type { AuthService } from "@fleet-console/ai-gateway";

export type TerminalModelAuthProviderId = "kimi" | "opencode" | "typesafe";

/**
 * 자격증명이 무엇에 쓰이는지. `model-provider`는 모델 카탈로그에 좌석을 가진 공급자라
 * 모델 팔레트에서 로그인하고, `service`는 라우팅되는 모델이 없는 서비스 자격증명이라
 * 팔레트 밖에서 로그인한다. 브라우저가 id를 외우지 않고 갈라 보도록 상태에 싣는다.
 */
export type TerminalModelAuthProviderKind = "model-provider" | "service";

export interface TerminalModelAuthProviderState {
  readonly provider: TerminalModelAuthProviderId;
  readonly kind: TerminalModelAuthProviderKind;
  readonly displayName: string;
  readonly signedIn: boolean;
}

export interface TerminalModelAuthState {
  readonly providers: readonly TerminalModelAuthProviderState[];
}

/** Route provider id → persisted auth-store provider id. */
export const MODEL_AUTH_STORE_IDS: Readonly<Record<TerminalModelAuthProviderId, string>> = Object.freeze({
  kimi: KIMI_AUTH_PROVIDER_ID,
  opencode: OPENCODE_AUTH_PROVIDER_ID,
  typesafe: TYPESAFE_AUTH_PROVIDER_ID,
});

const MODEL_AUTH_KINDS: Readonly<Record<TerminalModelAuthProviderId, TerminalModelAuthProviderKind>> = Object.freeze({
  kimi: "model-provider",
  opencode: "model-provider",
  typesafe: "service",
});

const MODEL_AUTH_DISPLAY_NAMES: Readonly<Record<TerminalModelAuthProviderId, string>> = Object.freeze({
  kimi: "Kimi for AI Gateway",
  opencode: "OpenCode Go for AI Gateway",
  typesafe: "TypeSafe System One",
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
      kind: MODEL_AUTH_KINDS[provider],
      displayName: MODEL_AUTH_DISPLAY_NAMES[provider],
      signedIn: signedInIds.has(MODEL_AUTH_STORE_IDS[provider]),
    })),
  };
}

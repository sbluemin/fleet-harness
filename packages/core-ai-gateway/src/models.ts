export interface GatewayModel {
  readonly id: string;
  readonly displayName: string;
}

/**
 * ChatGPT 구독 계정이 Codex 백엔드에서 실제로 허용하는 모델.
 * 백엔드는 목록 API를 제공하지 않으므로(400/403) 카탈로그를 게이트웨이가 소유한다.
 * 허용되지 않는 ID는 400 "... is not supported when using Codex with a ChatGPT account"로 거절된다.
 */
export const OPENAI_SUBSCRIPTION_MODELS: readonly GatewayModel[] = [
  { id: "gpt-5.5", displayName: "GPT-5.5" },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
  { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" },
];

export interface AnthropicModelEntry {
  readonly type: "model";
  readonly id: string;
  readonly display_name: string;
  readonly created_at: string;
}

export interface AnthropicModelList {
  readonly data: readonly AnthropicModelEntry[];
  readonly has_more: false;
  readonly first_id: string | null;
  readonly last_id: string | null;
}

/** Claude Code의 gateway model discovery(GET /v1/models)가 기대하는 Anthropic 목록 형태. */
export function buildAnthropicModelList(
  models: readonly GatewayModel[] = OPENAI_SUBSCRIPTION_MODELS,
  createdAt = "2026-01-01T00:00:00Z",
): AnthropicModelList {
  const data = models.map((model) => ({
    type: "model" as const,
    id: model.id,
    display_name: model.displayName,
    created_at: createdAt,
  }));
  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}

/**
 * 요청이 지목한 모델을 카탈로그에 비추어 해석한다.
 * Claude Code는 discovery가 꺼져 있으면 claude-* 이름을 그대로 보내므로, 그때는 기본 모델로 떨어진다.
 */
export function resolveGatewayModel(
  requested: string | undefined,
  options: { readonly override?: string; readonly catalog?: readonly GatewayModel[]; readonly fallback: string },
): string {
  if (options.override) return options.override;
  const catalog = options.catalog ?? OPENAI_SUBSCRIPTION_MODELS;
  if (requested && catalog.some((model) => model.id === requested)) return requested;
  return options.fallback;
}

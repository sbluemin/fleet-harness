export type GatewayProvider = "openai" | "cursor";

export interface GatewayModel {
  /** 게이트웨이가 노출하는 id. picker에는 claude- alias를 씌워 내보낸다. */
  readonly id: string;
  readonly displayName: string;
  readonly provider: GatewayProvider;
  /** upstream에 실제로 보낼 id. 생략하면 id를 그대로 쓴다. */
  readonly upstreamId?: string;
}

/**
 * ChatGPT 구독 계정이 Codex 백엔드에서 실제로 허용하는 모델.
 * 백엔드는 목록 API를 제공하지 않으므로(400/403) 카탈로그를 게이트웨이가 소유한다.
 * 허용되지 않는 ID는 400 "... is not supported when using Codex with a ChatGPT account"로 거절된다.
 */
export const OPENAI_SUBSCRIPTION_MODELS: readonly GatewayModel[] = [
  { id: "gpt-5.5", displayName: "GPT-5.5", provider: "openai" },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", provider: "openai" },
  { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", provider: "openai" },
];

/**
 * Claude Code는 discovery 응답에서 id가 "claude"로 시작하지 않는 모델을 picker에서 버린다(실측).
 * 게이트웨이 모델은 이 접두를 달아 노출하고, 요청이 돌아오면 벗겨서 실제 id로 되돌린다.
 */
export const GATEWAY_MODEL_ALIAS_PREFIX = "claude-gateway--";

export function toGatewayModelAlias(modelId: string): string {
  return `${GATEWAY_MODEL_ALIAS_PREFIX}${modelId}`;
}

export function fromGatewayModelAlias(alias: string): string {
  return alias.startsWith(GATEWAY_MODEL_ALIAS_PREFIX)
    ? alias.slice(GATEWAY_MODEL_ALIAS_PREFIX.length)
    : alias;
}

/** Cursor 구독이 노출하는 모델. GetUsableModels 실측에서 확인한 대표값. */
export const CURSOR_SUBSCRIPTION_MODELS: readonly GatewayModel[] = [
  { id: "cursor-auto", displayName: "Cursor Auto", provider: "cursor", upstreamId: "default" },
];

/** 게이트웨이가 discovery로 노출하는 전체 카탈로그. */
export const GATEWAY_MODELS: readonly GatewayModel[] = [
  ...OPENAI_SUBSCRIPTION_MODELS,
  ...CURSOR_SUBSCRIPTION_MODELS,
];

export function findGatewayModel(
  id: string,
  catalog: readonly GatewayModel[] = GATEWAY_MODELS,
): GatewayModel | undefined {
  const bare = fromGatewayModelAlias(id);
  return catalog.find((model) => model.id === bare);
}

export function upstreamModelId(model: GatewayModel): string {
  return model.upstreamId ?? model.id;
}

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
  models: readonly GatewayModel[] = GATEWAY_MODELS,
  createdAt = "2026-01-01T00:00:00Z",
): AnthropicModelList {
  const data = models.map((model) => ({
    type: "model" as const,
    id: toGatewayModelAlias(model.id),
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
  const catalog = options.catalog ?? GATEWAY_MODELS;
  const bare = requested === undefined ? undefined : fromGatewayModelAlias(requested);
  if (bare && catalog.some((model) => model.id === bare)) return bare;
  return options.fallback;
}

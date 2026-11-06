import {
  GATEWAY_MODELS,
  GATEWAY_MODELS_UPDATED_AT,
  anthropicModelCapabilities,
  findGatewayModel,
  resolveGatewayModel,
  type GatewayModel,
} from "../../../models.js";
import { buildAnthropicModelListPayload } from "../../wire/anthropic-messages/protocol.js";
import type {
  AnthropicModelEntry,
  AnthropicModelList,
} from "../../wire/anthropic-messages/protocol.js";

import {
  hasClaudeOneMillionMarker,
  isClaudeOneMillionContextWindow,
  stripClaudeOneMillionMarker,
} from "./context.js";

/**
 * Claude Code의 모델 디스커버리 방언.
 *
 * 카탈로그는 자기 id만 알고, 이 파일이 그 위에 Claude Code가 읽는 문법 — `claude-gateway--`
 * 접두와 `[1m]` 좌표 표식 — 을 씌운다. 다른 하네스는 같은 카탈로그를 자기 문법으로 광고하며,
 * 그래서 이 문법은 `models.ts`가 아니라 이 하네스 폴더가 소유한다.
 */

/**
 * The prefix every discovered gateway model id carries.
 *
 * It was introduced against a Claude Code discovery filter that dropped ids not
 * beginning with `claude`. That filter no longer exists: in 2.1.221 the reader of
 * the gateway model cache maps every entry into the picker with no id test at all
 * (observed 2026-08-04). The prefix is therefore not what makes a model
 * discoverable, and a future reader should not infer that it is.
 *
 * It stays because the grammar is already published. Persisted sessions,
 * `ANTHROPIC_MODEL` values, and stored defaults hold prefixed ids, and
 * `findGatewayModel` resolves a prefixed id and a bare registry id to the same
 * model. Dropping the prefix is a migration of those persisted values, not an
 * edit to this constant.
 */
export const GATEWAY_MODEL_ALIAS_PREFIX = "claude-gateway--";
const CLAUDE_ONE_MILLION_MARKER = "[1m]";

export function toGatewayModelAlias(modelId: string): string {
  return `${GATEWAY_MODEL_ALIAS_PREFIX}${modelId}`;
}

/**
 * Claude Code는 `[1m]`이 없는 사용자 정의 id의 좌표를 200_000으로 clamp한다.
 * 실제 창과 무관하게 모든 모델을 1M 좌표로 광고하려면 마커가 필요하다(2.1.319 실측).
 * 압축 시점은 이 마커가 아니라 settings `autoCompactWindow`가 정한다.
 */
export function toClaudeGatewayModelId(model: GatewayModel): string {
  // 네이티브 가족은 alias를 넘긴다 — 버전은 자식 CLI가 푼다.
  const id = model.provider === "claude"
    ? (model.claudeAlias ?? model.upstreamId ?? model.id)
    : toGatewayModelAlias(model.id);
  return hasClaudeOneMillionMarker(id) ? id : `${id}${CLAUDE_ONE_MILLION_MARKER}`;
}

/**
 * A catalog entry by the id Claude Code actually sends.
 *
 * Claude Code may omit the discovery marker from the request, so both forms
 * resolve to the same registry model. Every advertised id carries `[1m]`; a marker
 * is still refused when discovery would not emit one. A bare catalog id still
 * resolves — the child sends one when a stored default predates the alias grammar.
 */
export function findClaudeGatewayModel(
  id: string,
  catalog: readonly GatewayModel[] = GATEWAY_MODELS,
): GatewayModel | undefined {
  if (!id.startsWith(GATEWAY_MODEL_ALIAS_PREFIX)) {
    return findGatewayModel(id, catalog)
      ?? catalog.find((model) => model.provider === "claude" && toClaudeGatewayModelId(model) === id);
  }
  const scopedId = stripClaudeOneMillionMarker(id).slice(GATEWAY_MODEL_ALIAS_PREFIX.length);
  const model = catalog.find((candidate) => candidate.id === scopedId);
  if (!model || model.provider === "claude") return undefined;
  return hasClaudeOneMillionMarker(id)
    && !hasClaudeOneMillionMarker(toClaudeGatewayModelId(model))
    ? undefined
    : model;
}

export type { AnthropicModelEntry, AnthropicModelList };

/** Claude Code gateway model discovery (`GET /v1/models`). */
export function buildAnthropicModelList(
  models: readonly GatewayModel[] = GATEWAY_MODELS,
  createdAt = GATEWAY_MODELS_UPDATED_AT,
): AnthropicModelList {
  const exposed = models.filter((model) => model.provider !== "claude");
  return buildAnthropicModelListPayload(
    exposed,
    createdAt,
    (model) => ({
      id: toClaudeGatewayModelId(model),
      displayName: model.displayName,
    }),
    (model) => anthropicModelCapabilities(model.effort),
  );
}


/**
 * Resolve a model string a Claude Code client sent to the upstream wire id it names.
 *
 * The published `claude-gateway--`/`[1m]` grammar reaches this package through persisted
 * sessions, `ANTHROPIC_MODEL` values, and stored defaults, so the resolver a caller gets
 * from the compatibility facade has to keep understanding it. The catalog itself stays
 * bare (`models.ts`); this is where that grammar is spent.
 */
export function resolveClaudeGatewayModel(
  requested: string | undefined,
  options: {
    readonly override?: string;
    readonly catalog?: readonly GatewayModel[];
    readonly fallback: string;
  },
): string {
  return resolveGatewayModel(requested, { ...options, find: findClaudeGatewayModel });
}

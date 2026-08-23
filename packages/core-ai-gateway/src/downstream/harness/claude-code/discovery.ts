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
const CLAUDE_ONE_MILLION_DISPLAY_SUFFIX = " (1M Context)";

export function toGatewayModelAlias(modelId: string): string {
  return `${GATEWAY_MODEL_ALIAS_PREFIX}${modelId}`;
}

/**
 * Claude Code understands only its default 200k coordinate and the `[1m]` 1M
 * coordinate. Keep that marker truthful: only a provider model whose real window
 * reaches 1M is advertised as such. The response compatibility seam maps every
 * other real window onto the unmarked 200k coordinate while preserving Claude's
 * absolute compaction reserve.
 */
export function toClaudeGatewayModelId(model: GatewayModel): string {
  const alias = toGatewayModelAlias(model.id);
  return isClaudeOneMillionContextWindow(model.contextWindow)
    ? `${alias}${CLAUDE_ONE_MILLION_MARKER}`
    : alias;
}

function toClaudeGatewayModelDisplayName(model: GatewayModel): string {
  return isClaudeOneMillionContextWindow(model.contextWindow)
    ? `${model.displayName}${CLAUDE_ONE_MILLION_DISPLAY_SUFFIX}`
    : model.displayName;
}


/**
 * A catalog entry by the id Claude Code actually sends.
 *
 * Claude Code may omit the discovery-only marker from the request, so both forms
 * resolve to the same registry model. A fabricated marker for a genuinely unmarked
 * 200k model would make Claude undercount its context, so accept a marker only when
 * discovery emits one. A bare catalog id still resolves — the child sends one when a
 * stored default predates the alias grammar.
 */
export function findClaudeGatewayModel(
  id: string,
  catalog: readonly GatewayModel[] = GATEWAY_MODELS,
): GatewayModel | undefined {
  if (!id.startsWith(GATEWAY_MODEL_ALIAS_PREFIX)) return findGatewayModel(id, catalog);
  const scopedId = stripClaudeOneMillionMarker(id).slice(GATEWAY_MODEL_ALIAS_PREFIX.length);
  const model = catalog.find((candidate) => candidate.id === scopedId);
  if (!model) return undefined;
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
  return buildAnthropicModelListPayload(
    models,
    createdAt,
    (model) => ({
      id: toClaudeGatewayModelId(model),
      displayName: toClaudeGatewayModelDisplayName(model),
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

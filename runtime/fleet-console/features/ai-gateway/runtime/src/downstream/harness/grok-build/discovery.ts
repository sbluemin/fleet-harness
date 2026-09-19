import {
  GATEWAY_MODELS,
  GATEWAY_MODELS_UPDATED_AT,
  anthropicModelCapabilities,
  type GatewayModel,
} from "../../../models.js";
import { buildAnthropicModelListPayload } from "../../wire/anthropic-messages/protocol.js";
import type { AnthropicModelList } from "../../wire/anthropic-messages/protocol.js";

/**
 * Grok Build의 모델 디스커버리 방언.
 *
 * Claude Code의 방언과 두 가지가 다르고, 두 차이 모두 Grok Build 쪽 사실에서 나온다.
 *
 * - **점이 없다.** Grok Build는 모델을 `~/.grok/config.toml`의 `[model.<id>]` 절로 받는데,
 *   TOML의 bare key는 점을 테이블 구분자로 읽는다. `[model.a--gpt-5.6-luna]`는 오류가 아니라
 *   조용히 중첩 테이블이 되므로, 인용을 빠뜨린 손편집이 아무 진단 없이 모델을 잃는다.
 *   인용하면 점도 동작하지만(실측 확인), 그 함정을 남기는 것보다 문법에서 점을 없애는 쪽이 싸다.
 * - **1M 좌표 표식이 없다.** Grok Build는 창 크기를 자기 `context_window` 설정에서 읽으므로
 *   id에 좌표를 실을 이유가 없다. 그래서 이 하네스는 사용량 투영도 갖지 않는다 —
 *   공급자의 실제 수치가 그대로 보고된다.
 */

/** Grok Build가 읽는 게이트웨이 모델 id의 접두. */
export const GROK_GATEWAY_MODEL_ALIAS_PREFIX = "grok-build-gateway--";

/**
 * 카탈로그 id를 TOML bare key로 안전한 형태로 바꾼다.
 *
 * 점만 바꾼다. 카탈로그 id는 이미 `[A-Za-z0-9._-]`만 쓰므로 이 치환 뒤에는 bare key가 되고,
 * 되돌릴 필요가 없다 — 조회는 카탈로그를 같은 함수로 사상해 비교한다.
 *
 * 이 사상은 단사(injective)여야 한다. 오늘 카탈로그 53개에서 충돌은 0건이지만 그것은 성질이지
 * 불변식이 아니므로, 충돌이 생기면 실패하는 가드 테스트가 이 파일의 계약을 지킨다.
 */
export function toGrokModelSlug(catalogId: string): string {
  return catalogId.replaceAll(".", "-");
}

/** 디스커버리가 광고하는 id. */
export function toGrokGatewayModelId(model: GatewayModel): string {
  return `${GROK_GATEWAY_MODEL_ALIAS_PREFIX}${toGrokModelSlug(model.id)}`;
}

/**
 * Grok Build가 보낸 모델 문자열이 지목하는 카탈로그 항목.
 *
 * 발행한 문법만 인정한다. Claude Code 쪽은 접두 없는 옛 id까지 받아 주는데, 그것은 별칭 문법보다
 * 앞선 영속 값이 실재하기 때문이다. 이 하네스에는 그런 값이 없다 — Grok Build가 보내는 id는
 * 전부 Fleet이 그 세션에 써 준 config에서 온다. 그래서 관대할 이유가 없고, 관대하면 오타가
 * 400 대신 조용히 다른 모델이 된다.
 */
export function findGrokGatewayModel(
  id: string,
  catalog: readonly GatewayModel[] = GATEWAY_MODELS,
): GatewayModel | undefined {
  if (!id.startsWith(GROK_GATEWAY_MODEL_ALIAS_PREFIX)) return undefined;
  const slug = id.slice(GROK_GATEWAY_MODEL_ALIAS_PREFIX.length);
  return catalog.find((candidate) => toGrokModelSlug(candidate.id) === slug);
}

/** Grok Build gateway model discovery (`GET /v1/models`). */
export function buildGrokModelList(
  models: readonly GatewayModel[] = GATEWAY_MODELS,
  createdAt = GATEWAY_MODELS_UPDATED_AT,
): AnthropicModelList {
  return buildAnthropicModelListPayload(
    models,
    createdAt,
    (model) => ({ id: toGrokGatewayModelId(model), displayName: model.displayName }),
    (model) => anthropicModelCapabilities(model.effort),
  );
}

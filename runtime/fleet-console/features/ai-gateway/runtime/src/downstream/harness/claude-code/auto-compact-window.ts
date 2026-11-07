import type { GatewayModel } from "../../../models.js";
import { compactThresholdTokens, hasClaudeOneMillionMarker, type CompactCeiling } from "./context.js";
import { findClaudeGatewayModel, toClaudeGatewayModelId } from "./discovery.js";

/**
 * Claude Code가 `autoCompactWindow`에서 빼는 몫 — 출력 예약 `min(maxOutputTokens, 20k)`과 여유 13k.
 *
 * 압축은 창이 아니라 `창 − 33_000`에서 일어난다. Claude Code 2.1.319 로컬 fixture(제공자 호출 없음):
 * `autoCompactWindow` 200_000에서 입력 166_000은 압축되지 않고 167_000은 압축됐다.
 */
export const CLAUDE_AUTO_COMPACT_RESERVE = 33_000;
/** Claude Code가 받는 자동 압축 창의 범위. 밖은 자식이 이 끝으로 clamp한다. */
export const CLAUDE_AUTO_COMPACT_WINDOW_MIN = 100_000;
export const CLAUDE_AUTO_COMPACT_WINDOW_MAX = 1_000_000;

/**
 * 모델의 실제 최대 창과 Fleet 압축 시점(ceiling)으로 Claude Code `autoCompactWindow`를 만든다.
 *
 * 지점은 {@link compactThresholdTokens}다. ceiling이 없으면 창 − 16_000(Auto). `earlierAt`이 있으면
 * 그 지점과 정책 지점 중 이른 쪽을 쓴다. 자식은 창에서 33_000을 빼고 압축하므로 그 몫을 더해
 * 실제 압축이 정책 지점에 오게 하고, SDK가 받는 100_000–1_000_000 안으로 clamp한다.
 * 실제 창이 1_048_576인 모델의 Auto 지점(1_032_576)은 이 상한 때문에 1_000_000으로 잘리고,
 * 그때 자식은 967_000에서 압축한다(2.1.319: 창 1_000_000, 입력 966_000은 아니오, 968_000은 예).
 */
export function claudeAutoCompactWindowTokens(
  contextWindow: number,
  ceiling: CompactCeiling | null | undefined,
  earlierAt?: number,
): number | undefined {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return undefined;
  let point = compactThresholdTokens(contextWindow, ceiling ?? null);
  if (earlierAt !== undefined) {
    if (!Number.isSafeInteger(earlierAt) || earlierAt <= 0) return undefined;
    point = Math.min(earlierAt, point);
  }
  if (!Number.isFinite(point) || point <= 0) return undefined;
  return Math.min(
    CLAUDE_AUTO_COMPACT_WINDOW_MAX,
    Math.max(CLAUDE_AUTO_COMPACT_WINDOW_MIN, point + CLAUDE_AUTO_COMPACT_RESERVE),
  );
}

/**
 * 한 모델이 Claude Code에서 불리는 모든 이름 — 광고 id(`toClaudeGatewayModelId`, 항상 `[1m]`)와,
 * 네이티브 Claude 가족이면 CLI가 푼 정식 id(`claude-opus-5-5[1m]`).
 *
 * 자식은 `modelSettings` 키를 모델로 정규화하고, 같은 모델로 모이는 키가 여럿이면 정규형과 같은 키가 아닌 한
 * 먼저 나온 키를 쓴다(2.1.319). 이름마다 값이 다르면 객체 순서가 압축 시점을 정하므로, 한 모델의 이름은 늘 같은 값을 받는다.
 */
export function claudeModelAutoCompactKeys(model: GatewayModel): readonly string[] {
  const advertised = toClaudeGatewayModelId(model);
  if (model.provider !== "claude" || model.upstreamId === undefined) return [advertised];
  const resolved = hasClaudeOneMillionMarker(model.upstreamId) ? model.upstreamId : `${model.upstreamId}[1m]`;
  return resolved === advertised ? [advertised] : [advertised, resolved];
}

/**
 * 세션이 요청한 모델 id(광고 id든 정식 id든)가 가리키는 카탈로그 모델과 그 모델의 모든 이름(요청한 이름 포함).
 * 카탈로그가 아직 모르는 정식 id(`claude-opus-5-6[1m]`)도 가족 접두로 그 가족에 모은다 — 세션 도중 CLI가 올라가
 * 카탈로그의 정식 id가 바뀌어도 가족의 별칭 키가 다른 값으로 남지 않는다. 가족을 모르는 원문 모델은 요청한 이름 하나다.
 */
export function claudeAutoCompactTarget(
  requested: string,
  models: readonly GatewayModel[],
): { readonly model?: GatewayModel; readonly keys: readonly string[] } {
  const model = models.find((candidate) => claudeModelAutoCompactKeys(candidate).includes(requested))
    ?? findClaudeGatewayModel(requested, models)
    ?? models.find((candidate) => candidate.provider === "claude" && candidate.claudeAlias !== undefined && requested.startsWith(`claude-${candidate.claudeAlias}-`));
  return model ? { model, keys: [...new Set([...claudeModelAutoCompactKeys(model), requested])] } : { keys: [requested] };
}

/**
 * 카탈로그 전 모델의 이름별 자동 압축 창. 한 모델의 모든 이름({@link claudeModelAutoCompactKeys})이 같은 값을 받는다.
 *
 * 최상위 `autoCompactWindow`는 프로세스에 하나라 모델 전환 때 다른 창을 덮어쓴다.
 * `modelSettings.<name>.autoCompactWindow`는 그 모델만 대체한다.
 */
export function claudeModelAutoCompactWindows(
  models: readonly GatewayModel[],
  ceiling: CompactCeiling | null | undefined,
): Readonly<Record<string, number>> {
  const windows: Record<string, number> = {};
  for (const model of models) {
    if (model.contextWindow === undefined) continue;
    const window = claudeAutoCompactWindowTokens(model.contextWindow, ceiling);
    if (window === undefined) continue;
    for (const key of claudeModelAutoCompactKeys(model)) windows[key] = window;
  }
  return windows;
}

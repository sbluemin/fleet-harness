/**
 * 이 채팅 세션이 무엇으로 도는가 — 모델과 강도.
 *
 * 좌표는 런치 때 Operation payload에 실린 값이고, 세션이 사는 동안 바뀌지 않는다: 모델·강도는
 * 턴이 아니라 세션이 소유하며, 바꾸는 길은 이 세션을 접고 새로 여는 것뿐이다. 그래서 이 값은
 * 컨트롤이 아니라 **사실**로 그려진다.
 *
 * 좌표가 payload에 없는 세션(구세대·미지정)은 서버가 자기 기본값으로 이어 간다. 그 규칙을 여기서
 * 복제하면 진실이 두 곳에 살고, 서버가 기본을 바꾸는 날 이 표식만 조용히 거짓말한다 — 그래서
 * 모델 이름을 추측하지 않고 "기본"이라고 말한다.
 */

import {
  launchProviderFromModelId,
  type LaunchProviderGlyphId,
} from "@fleet-console/sdk/components/launch-provider-glyphs";

/** 게이트웨이 모델 id의 Console 접두. 표시에서는 벗긴다. */
const GATEWAY_MODEL_PREFIX = "claude-gateway--";

/**
 * 표시 어휘는 런치 메뉴와 같아야 한다 — 같은 세션을 두 표면이 다른 이름으로 부르면 사용자는
 * 자기가 고른 것과 지금 도는 것을 대조하지 못한다. 서버의 `agent-cli-launch-kinds.ts`가 원본이며,
 * `tests/chat-session-coordinates.test.ts`가 두 표를 맞물려 고정한다.
 */
const NATIVE_MODEL_LABELS: Readonly<Record<string, string>> = {
  "fable[1m]": "Fable",
  "opus[1m]": "Opus",
  sonnet: "Sonnet",
};

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "LOW",
  medium: "MED",
  high: "HIGH",
  xhigh: "XHIGH",
  max: "MAX",
  ultra: "ULTRACODE",
};

export interface AgentChatSessionCoordinates {
  /** 표시용 모델 이름. payload에 좌표가 없으면 `null` — 부르는 쪽이 "기본"을 말한다. */
  readonly model: string | null;
  /** 표시용 강도. 지정되지 않았으면 `null` — 부르는 쪽이 "AUTO"를 말한다. */
  readonly effort: string | null;
  /** 사다리 단 그대로의 값. CSS가 티어를 이 값으로 가른다(`ultra`만 apex 물결). */
  readonly effortLevel: string;
  /** 원문 좌표 — 툴팁이 축약하지 않은 사실을 보여 준다. */
  readonly title: string | null;
  /** 이 세션이 ultracode 오케스트레이션으로 도는가. */
  readonly ultracode: boolean;
  /**
   * 이 세션을 실제로 돌린 공급자. 런치가 payload에 적어 둔 값이 먼저이고, 없으면 모델 id의
   * 게이트웨이 범위에서 읽는다 — 이름만으로는 같은 자리에 선 두 모델이 어디서 온 것인지
   * 말하지 못한다. 어느 쪽으로도 읽히지 않으면 `null`이고, 표식은 중립 마름모로 돌아간다.
   */
  readonly provider: LaunchProviderGlyphId | null;
}

/** payload의 `launchModel`을 표시 이름으로 옮긴다. 알 수 없는 게이트웨이 id는 접두만 벗긴다. */
function modelLabel(model: string): string {
  const named = NATIVE_MODEL_LABELS[model];
  if (named) return named;
  const bare = model.startsWith(GATEWAY_MODEL_PREFIX) ? model.slice(GATEWAY_MODEL_PREFIX.length) : model;
  // 게이트웨이 id는 `<provider>--<model>` 범위형이다. 각인은 한 줄이므로 모델 쪽만 남긴다.
  const separator = bare.lastIndexOf("--");
  return separator < 0 ? bare : bare.slice(separator + 2);
}

function readPayloadString(payload: Record<string, unknown> | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function readAgentChatSessionCoordinates(
  payload: Record<string, unknown> | undefined,
): AgentChatSessionCoordinates {
  const session = payload?.session && typeof payload.session === "object" && !Array.isArray(payload.session)
    ? payload.session as Record<string, unknown>
    : undefined;
  const model = readPayloadString(session, "model");
  const effort = readPayloadString(session, "effort");
  return {
    model: model === null ? null : modelLabel(model),
    effort: effort === null ? null : EFFORT_LABELS[effort] ?? effort.toUpperCase(),
    effortLevel: effort ?? "auto",
    title: model === null && effort === null ? null : [model, effort].filter(Boolean).join(" · "),
    ultracode: effort === "ultra",
    provider: launchProviderFromModelId(model),
  };
}

/**
 * 세션이 명시한 모델 속도(일반·Fast) — 사람이 선택기에서 좌표와 함께 고른 값이다.
 *
 * 카탈로그는 모델당 id 하나다. 같은 모델의 Fast를 새 id로 만들지 않고, 세션 런치 env의
 * `ANTHROPIC_CUSTOM_HEADERS`로 「이 모델 id는 fast|standard」를 매 요청 헤더에 싣는다. Claude Code
 * CLI와 Agent SDK 자식 모두 이 env를 요청 헤더로 옮긴다(2.1.319·SDK 0.3.306 무료 실측). 한 세션의 다른
 * 모델 요청(위임·압축)에는 새지 않도록 라우터는 요청 모델이 헤더의 모델과 같을 때만 따른다. 명시가 없는
 * 세션은 AI Gateway 설정의 Fast 토글을 따른다.
 */

export const FLEET_MODEL_SPEED_HEADER = "x-fleet-model-speed";

export interface ModelSpeedChoice {
  /** 실행 id(정준 id). */
  readonly model: string;
  readonly fast: boolean;
}

const CUSTOM_HEADERS_ENV = "ANTHROPIC_CUSTOM_HEADERS";

/**
 * 자식 env에 얹을 `ANTHROPIC_CUSTOM_HEADERS` — 상속된 값의 다른 헤더는 보존하고 이 헤더 줄만 바꾼다.
 * Claude Code는 이 값을 줄마다 `Name: Value`로 읽는다.
 */
export function modelSpeedLaunchEnv(inherited: Readonly<Record<string, string | undefined>>, choice: ModelSpeedChoice): Record<string, string> {
  const kept = (inherited[CUSTOM_HEADERS_ENV] ?? "").split(/\r?\n/u)
    .filter((line) => line.trim() !== "" && line.split(":", 1)[0]!.trim().toLowerCase() !== FLEET_MODEL_SPEED_HEADER);
  return { [CUSTOM_HEADERS_ENV]: [...kept, `${FLEET_MODEL_SPEED_HEADER}: ${choice.model}=${choice.fast ? "fast" : "standard"}`].join("\n") };
}

/** 요청 헤더의 명시 속도. 모양이 다르면 명시가 없는 것으로 본다. */
export function readModelSpeedHeader(value: string | readonly string[] | undefined): ModelSpeedChoice | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const at = raw.lastIndexOf("=");
  if (at <= 0) return null;
  const model = raw.slice(0, at).trim();
  const speed = raw.slice(at + 1).trim();
  if (!model || (speed !== "fast" && speed !== "standard")) return null;
  return { model, fast: speed === "fast" };
}

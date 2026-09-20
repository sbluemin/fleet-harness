/**
 * TypeSafe 접속 좌표. `src/auth/`는 공급자를 모르는 채로 남아야 하므로 저장 id·기반
 * URL·검증 경로는 공급자 폴더인 이 자리에 산다.
 */

// Keep the persisted provider id stable so stored keys survive upgrades.
// 키는 계정(TypeSafe)에 속하고 Jev는 그 계정이 부르는 모델이므로, 모델명이 아니라
// 서비스명으로 고정한다 — 다음 System One 모델이 와도 재로그인이 필요 없다.
// 표시 이름과 일부러 다른 문자열이다: 라우트는 저장 id를 브라우저에 실어 보내지
// 않으며, 두 이름이 같으면 그 보장을 시험으로 확인할 수 없다.
export const TYPESAFE_AUTH_PROVIDER_ID = "Fleet Console with TypeSafe System One";
export const TYPESAFE_API_BASE_URL = "https://api.typesafe.ai";
export const TYPESAFE_SYSTEM_ONE_PATH = "/v1/systemone";
export const TYPESAFE_MODELS_PATH = "/v1/models";
/** 현행 System One 모델 별칭. 추론 호출은 이 좌표로 나간다. */
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

/**
 * TypeSafe가 내놓는 System One 모델들. `models.json`에 넣지 않는 것이 요점이다 — 그
 * 카탈로그에 앉는 순간 `/model` 픽커와 Operation 실행 메뉴가 이 이름들을 고를 수 있는
 * 대화 모델로 내놓고, 고르면 Anthropic Messages 요청이 이 wire로 나가 반드시 실패한다.
 * 설정 화면은 이 목록을 "쓸 수 있는 것"으로 보여 줄 뿐, 선택지로 내놓지 않는다.
 */
export const TYPESAFE_MODELS: readonly { readonly id: string; readonly name: string }[] = Object.freeze([
  Object.freeze({ id: "jev-latest", name: "Jev" }),
  Object.freeze({ id: "jev-preview", name: "Jev Preview" }),
]);

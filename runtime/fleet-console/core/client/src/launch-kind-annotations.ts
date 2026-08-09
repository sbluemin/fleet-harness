import type { CoreMessageKey } from "./i18n/index.js";

// 실행 메뉴 항목에 덧붙는 설명. 플러그인이 주는 title은 로케일 없는 서버 문자열이라
// 번역할 수 없으므로, 번역이 필요한 문구는 여기(코어 i18n)에 두고 kind id로만 맞붙인다.
// 코어가 특정 kind id를 아는 것은 feature-tour 카탈로그가 이미 쓰는 방식과 같다 — 두 곳 모두
// 번역 가능한 라벨이 아니라 안정 식별자에 건다.
//
// 두 층으로 나뉜다: brief는 라벨 옆에 늘 서서 훑기만 해도 종류가 갈리게 하고,
// description은 그 항목을 짚었을 때만 옆에 펼친다. 상시로 두 줄을 쓰면 메뉴가 실행 목록이
// 아니라 설명서가 되고, 아예 없애면 이름만으로 두 Claude를 못 가른다.
export interface LaunchKindAnnotation {
  readonly descriptionKey: CoreMessageKey;
  readonly briefKey: CoreMessageKey;
}

export const LAUNCH_KIND_ANNOTATIONS: Readonly<Record<string, LaunchKindAnnotation>> = {
  "claude-gateway": {
    descriptionKey: "launchKind.claudeGateway.description",
    briefKey: "launchKind.claudeGateway.brief",
  },
};

export function resolveLaunchKindAnnotation(kindId: string): LaunchKindAnnotation | null {
  return LAUNCH_KIND_ANNOTATIONS[kindId] ?? null;
}

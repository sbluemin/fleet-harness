import type { CoreMessageKey } from "./i18n/index.js";

// 실행 메뉴 항목에 덧붙는 한 줄 설명. 플러그인이 주는 title은 로케일 없는 서버 문자열이라
// 번역할 수 없으므로, 번역이 필요한 문구는 여기(코어 i18n)에 두고 kind id로만 맞붙인다.
// 코어가 특정 kind id를 아는 것은 feature-tour 카탈로그가 이미 쓰는 방식과 같다 — 두 곳 모두
// 번역 가능한 라벨이 아니라 안정 식별자에 건다.
export interface LaunchKindAnnotation {
  readonly descriptionKey: CoreMessageKey;
}

export const LAUNCH_KIND_ANNOTATIONS: Readonly<Record<string, LaunchKindAnnotation>> = {
  "claude-native": {
    descriptionKey: "launchKind.claudeNative.description",
  },
  claude: {
    descriptionKey: "launchKind.claude.description",
  },
  "claude-gateway": {
    descriptionKey: "launchKind.claudeGateway.description",
  },
};

export function resolveLaunchKindAnnotation(kindId: string): LaunchKindAnnotation | null {
  return LAUNCH_KIND_ANNOTATIONS[kindId] ?? null;
}

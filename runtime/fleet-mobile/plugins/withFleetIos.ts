import { ConfigPlugin } from "expo/config-plugins";

// iOS 프리빌드 하드닝 플러그인. 스캐폴딩 단계에서는 자리만 잡는다 — ATS 강제, fleet://join
// URL 타입 소유, 서명 fail-closed 정책은 콘솔 뷰 이식 태스크(계획 Task 7)가 채운다.
// withFleetAndroid.ts와 같은 계약을 따른다: 생성된 iOS 프로젝트에 가하는 모든 패치는
// 정확히 한 번 매치해야 하고, 아니면 던진다.
export const withFleetIos: ConfigPlugin = (config) => config;

export default withFleetIos;

// Node v22.19.0+/v24.6.0+는 NODE_USE_SYSTEM_CA=1로 OS 신뢰 저장소의 CA를 추가 신뢰한다
// (TLS 검사 프록시 환경 대응, issue #531). 미지원 버전은 알 수 없는 env를 무시하므로 무조건 주입해도 안전하다.
const NODE_USE_SYSTEM_CA_ENV = "NODE_USE_SYSTEM_CA";

export function withNodeSystemCa(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  // 사용자가 명시한 값(0 포함)은 존중한다. Windows는 env 키가 대소문자 무시라 `node_use_system_ca=0` 같은
  // 변형이 있는데 대문자 키를 추가하면 child env 구성 시 명시값을 덮을 수 있어, 존재 여부는 대소문자 무관하게 본다.
  const hasExplicitValue = Object.keys(next).some((key) => key.toUpperCase() === NODE_USE_SYSTEM_CA_ENV);
  if (!hasExplicitValue) next[NODE_USE_SYSTEM_CA_ENV] = "1";
  return next;
}

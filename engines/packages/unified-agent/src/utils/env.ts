/**
 * 환경변수 정제 유틸리티
 * 자식 프로세스에 전달할 환경변수에서 간섭 요소를 제거합니다.
 */

/** 제거 대상 환경변수 키 */
const REMOVE_KEYS = [
  'NODE_OPTIONS',
  'NODE_INSPECT',
  'NODE_DEBUG',
  'CLAUDECODE', // Claude 중첩 세션 감지 방지
  'CLAUDE_CODE_ENTRYPOINT', // Claude Code 내부에서 실행 시 충돌 방지
] as const;

/** npm lifecycle 변수 접두사 */
const NPM_PREFIX = 'npm_';

/**
 * 환경변수를 정제하여 자식 프로세스에 안전하게 전달할 수 있는 형태로 변환합니다.
 *
 * - NODE_OPTIONS, NODE_INSPECT, NODE_DEBUG 제거 (자식 프로세스 디버깅 간섭 방지)
 * - CLAUDECODE 제거 (Claude 중첩 세션 방지)
 * - npm_ 접두사 변수 제거 (npx 동작 간섭 방지)
 *
 * @param baseEnv - 기본 환경변수 (기본값: process.env)
 * @param customEnv - 추가/덮어쓸 환경변수
 * @returns 정제된 환경변수
 */
export function cleanEnvironment(
  baseEnv: Record<string, string | undefined> = process.env,
  customEnv?: Record<string, string>,
): Record<string, string | undefined> {
  // 복사본 생성
  const env = { ...baseEnv };

  // 고정 키 제거
  for (const key of REMOVE_KEYS) {
    delete env[key];
  }

  // npm lifecycle 변수 제거
  for (const key of Object.keys(env)) {
    if (key.startsWith(NPM_PREFIX)) {
      delete env[key];
    }
  }

  // 커스텀 환경변수 병합
  if (customEnv) {
    Object.assign(env, customEnv);
  }

  return env;
}

/**
 * 현재 OS가 Windows인지 확인합니다.
 */
export function isWindows(): boolean {
  return process.platform === 'win32';
}

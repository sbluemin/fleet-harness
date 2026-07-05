/**
 * npx 경로 해석 유틸리티
 */

import { findBinaryPath } from '@dotobokuri/core-process';
import { isWindows } from './env.js';

/**
 * 시스템에서 npx 바이너리의 전체 경로를 해석합니다.
 *
 * @param env - 환경변수 (PATH 해석에 사용)
 * @returns npx 실행 경로
 */
export function resolveNpxPath(
  env?: Record<string, string | undefined>,
): string {
  const resolved = findBinaryPath('npx', (env ?? process.env) as NodeJS.ProcessEnv);
  if (resolved) {
    return resolved;
  }
  return isWindows() ? 'npx.cmd' : 'npx';
}

/**
 * npx를 사용한 패키지 실행 인자를 생성합니다.
 *
 * scoped 패키지의 경우 `npx <pkg>@<version>` 형태가 일부 환경에서
 * 패키지 스펙을 실행 파일 이름으로 잘못 해석할 수 있으므로,
 * 항상 `npx --package=<pkg> <bin>` 형태로 고정합니다.
 *
 * @param packageName - 실행할 npm 패키지 (e.g., '@agentclientprotocol/claude-agent-acp@0.33.1')
 * @param preferOffline - npm 캐시 우선 사용 여부 (기본: false)
 * @returns npx 실행 인자 배열
 */
export function buildNpxArgs(
  packageName: string,
  preferOffline = false,
): string[] {
  const args = ['--yes'];
  if (preferOffline) {
    args.push('--prefer-offline');
  }
  args.push(`--package=${packageName}`);
  args.push(inferBinName(packageName));
  return args;
}

/**
 * npm 패키지 스펙에서 실행 바이너리 이름을 추론합니다.
 *
 * 예:
 * - @agentclientprotocol/claude-agent-acp@0.33.1 -> claude-agent-acp
 * - @scope/example-tool@1.2.3 -> example-tool
 */
function inferBinName(packageName: string): string {
  const lastSegment = packageName.split('/').pop() ?? packageName;
  return lastSegment.replace(/@[^@/]+$/, '');
}

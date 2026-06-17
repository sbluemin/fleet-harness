/**
 * npx 경로 해석 유틸리티
 */

import { execSync } from 'child_process';
import { isWindows } from './env.js';

/**
 * 시스템에서 npx 바이너리의 전체 경로를 해석합니다.
 *
 * @param env - 환경변수 (PATH 해석에 사용)
 * @returns npx 실행 경로
 * @throws npx를 찾을 수 없는 경우 에러
 */
export function resolveNpxPath(
  env?: Record<string, string | undefined>,
): string {
  const windows = isWindows();
  const whichCmd = windows ? 'where npx' : 'which npx';

  try {
    const result = execSync(whichCmd, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
      env: env as NodeJS.ProcessEnv,
      // 콘솔 없는 호스트에서 `where npx` 실행 시 콘솔 창이 깜빡이는 것을 방지한다.
      windowsHide: true,
    }).trim();

    const candidates = result
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (windows) {
      // Windows의 `where`는 확장자 없는 shell script(`npx`)와 `npx.cmd`를 함께 반환합니다.
      // 단독 실행 가능한 배치/실행 파일만 선별해 우선 사용합니다.
      const executable = candidates.find((p) => /\.(cmd|bat|exe)$/i.test(p));
      if (executable) {
        return executable;
      }
    }

    if (candidates.length > 0) {
      return candidates[0];
    }

    return windows ? 'npx.cmd' : 'npx';
  } catch {
    // PATH가 정제된 환경에서는 기본 경로 시도
    if (windows) {
      return 'npx.cmd';
    }
    return 'npx';
  }
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

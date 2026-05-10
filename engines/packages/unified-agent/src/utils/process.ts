/**
 * 프로세스 관리 유틸리티
 * 자식 프로세스의 안전한 종료 처리
 */

import { ChildProcess } from 'child_process';
import { execSync } from 'child_process';
import { isWindows } from './env.js';

/**
 * 자식 프로세스를 안전하게 종료합니다.
 *
 * - Windows: `taskkill /PID <pid> /T /F` (트리 킬)
 * - POSIX: `SIGTERM` → 3초 후 `SIGKILL` 강제 종료
 *
 * @param child - 종료할 자식 프로세스
 * @param forceTimeoutMs - 강제 종료까지 대기 시간 (기본: 3000ms)
 */
export function killProcess(child: ChildProcess, forceTimeoutMs = 3000): void {
  if (!child.pid || child.killed) {
    return;
  }

  if (isWindows()) {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, {
        stdio: 'pipe',
        timeout: 5000,
      });
    } catch {
      // taskkill 실패 시 일반 kill 시도
      child.kill('SIGKILL');
    }
    return;
  }

  // POSIX: SIGTERM → 타임아웃 후 SIGKILL
  child.kill('SIGTERM');

  const forceKillTimer = setTimeout(() => {
    if (!child.killed) {
      child.kill('SIGKILL');
    }
  }, forceTimeoutMs);

  // 프로세스가 정상 종료되면 타이머 해제
  child.once('exit', () => {
    clearTimeout(forceKillTimer);
  });
}

/**
 * 프로세스 그룹 전체를 종료합니다 (detached 프로세스용).
 *
 * @param pid - 프로세스 그룹 리더 PID
 */
export function killProcessGroup(pid: number): void {
  if (isWindows()) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, {
        stdio: 'pipe',
        timeout: 5000,
      });
    } catch {
      // 무시 - 이미 종료되었을 수 있음
    }
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // 무시 - 이미 종료되었을 수 있음
  }
}

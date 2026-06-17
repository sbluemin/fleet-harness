/**
 * 프로세스 관리 유틸리티
 * 자식 프로세스의 안전한 종료 처리
 */

import { ChildProcess } from 'child_process';
import { execSync } from 'child_process';
import { isWindows } from './env.js';

export interface IntentionalKillMarkedChildProcess extends ChildProcess {
  __intentionalKill?: boolean;
}

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
  if (!child.pid || child.killed || !isChildProcessRunning(child)) {
    return;
  }

  markIntentionalKill(child);

  if (isWindows()) {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, {
        stdio: 'pipe',
        timeout: 5000,
        // 콘솔 없는 호스트에서 taskkill 호출 시 새 콘솔 창이 깜빡이는 것을 방지한다.
        windowsHide: true,
      });
    } catch {
      // taskkill 실패 시 일반 kill 시도
      child.kill('SIGKILL');
    }
    return;
  }

  // POSIX: detached 자식은 프로세스 그룹 리더이므로 그룹 전체에 신호를 보냅니다.
  killProcessGroupWithFallback(child, 'SIGTERM');

  const forceKillTimer = setTimeout(() => {
    if (isChildProcessRunning(child)) {
      killProcessGroupWithFallback(child, 'SIGKILL');
    }
  }, forceTimeoutMs);

  // 프로세스가 정상 종료되면 타이머 해제
  child.once('exit', () => {
    clearTimeout(forceKillTimer);
  });
}

export function markIntentionalKill(child: ChildProcess): void {
  (child as IntentionalKillMarkedChildProcess).__intentionalKill = true;
}

export function isIntentionalKillMarked(child: ChildProcess | null | undefined): boolean {
  return Boolean((child as IntentionalKillMarkedChildProcess | null | undefined)?.__intentionalKill);
}

function killProcessGroupWithFallback(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    // 그룹 종료 실패 시 직속 자식만이라도 안전하게 종료합니다.
    try {
      child.kill(signal);
    } catch {
      // 무시 - 이미 종료되었을 수 있음
    }
  }
}

function isChildProcessRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

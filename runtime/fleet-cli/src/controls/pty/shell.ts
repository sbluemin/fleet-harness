import { spawn, type IPty } from "node-pty";

import type { PtyLaunchConfig, PtyStartOptions } from "../types.js";

export type ShellStarter = (config: PtyLaunchConfig, opts: PtyStartOptions) => IPty;

export function startShell(config: PtyLaunchConfig, opts: PtyStartOptions): IPty {
  return spawn(config.profile.bin, [...config.profile.args], {
    cols: opts.cols,
    cwd: config.profile.cwd,
    env: config.profile.env,
    name: config.profile.terminalName,
    rows: opts.rows,
  });
}

export function resizeShell(child: IPty | undefined, cols: number, rows: number): void {
  if (child === undefined) {
    return;
  }
  try {
    child.resize(cols, rows);
  } catch (error) {
    // Windows ConPTY에서 child PTY가 종료된 직후, exit 이벤트가 host로 전파되어 child 참조가
    // 비워지기 전 짧은 경합 창이 존재한다. 이 창에서 마지막 출력 flush가 유발한 렌더→resize가
    // 이미 종료된 PTY에 도달하면 node-pty가 동기 throw를 던진다. resize는 순수 화면 보정이므로
    // 이 종료-경합 케이스만 무시하고, 잘못된 cols/rows 같은 그 외 오류는 그대로 다시 던진다.
    if (isPtyAlreadyExitedError(error)) {
      return;
    }
    throw error;
  }
}

function isPtyAlreadyExitedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("already exited");
}

export function killShell(child: IPty | undefined): void {
  child?.kill();
}

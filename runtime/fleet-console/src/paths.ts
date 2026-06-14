import os from "node:os";
import path from "node:path";

import { readFleetConsoleRelease, type FleetConsoleChannel } from "./release.js";

export interface ConsolePaths {
  readonly dir: string;
  readonly lockFile: string;
}

export interface CreateConsolePathsDeps {
  readonly channel?: FleetConsoleChannel;
  readonly env?: NodeJS.ProcessEnv;
  readonly uid?: number;
}

const LOCK_DIR_NAME = "fleet-console";
const LOCK_FILE_NAME = "console.lock";

export function createConsolePaths(deps: CreateConsolePathsDeps = {}): ConsolePaths {
  const env = deps.env ?? process.env;
  // 명시 override가 있으면 채널별 락 네임스페이스보다 사용자가 지정한 경로를 우선한다.
  const base = env.FLEET_CONSOLE_DIR ?? defaultConsoleBaseDir(deps);
  return { dir: base, lockFile: path.join(base, LOCK_FILE_NAME) };
}

function defaultConsoleBaseDir(deps: CreateConsolePathsDeps): string {
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const channel = deps.channel ?? readFleetConsoleRelease().channel;
  // stable/local 채널별로 락 디렉터리를 분리해 글로벌 설치본과 개발 실행본의 데몬 슬롯을 격리한다.
  return path.join(os.tmpdir(), `${LOCK_DIR_NAME}-${uid}-${channel}`);
}

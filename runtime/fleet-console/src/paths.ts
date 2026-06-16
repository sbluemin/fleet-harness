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
  readonly packageRoot?: string;
  readonly uid?: number;
}

const LOCK_DIR_NAME = "fleet-console";
const CONSOLE_RUNTIME_DIR_NAME = "console";
const LOCK_FILE_NAME = "console.lock";

export function createConsolePaths(deps: CreateConsolePathsDeps = {}): ConsolePaths {
  const env = deps.env ?? process.env;
  // 명시 override가 있으면 채널별 락 네임스페이스보다 사용자가 지정한 경로를 우선한다.
  const base = env.FLEET_CONSOLE_DIR ?? defaultConsoleBaseDir(deps);
  return { dir: base, lockFile: path.join(base, LOCK_FILE_NAME) };
}

function defaultConsoleBaseDir(deps: CreateConsolePathsDeps): string {
  let release: ReturnType<typeof readFleetConsoleRelease> | undefined;
  const channel = deps.channel ?? (release = readFleetConsoleRelease()).channel;

  if (channel === "local") {
    const packageRoot = deps.packageRoot ?? (release ??= readFleetConsoleRelease()).packageRoot;
    // local 개발 실행은 워크트리/체크아웃별 데몬 슬롯을 분리하기 위해 프로젝트 .fleet 하위에 격리한다.
    return path.join(path.resolve(packageRoot, "..", ".."), ".fleet", CONSOLE_RUNTIME_DIR_NAME);
  }

  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  return path.join(os.tmpdir(), `${LOCK_DIR_NAME}-${uid}-${channel}`);
}

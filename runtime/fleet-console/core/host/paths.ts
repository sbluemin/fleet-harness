import os from "node:os";
import path from "node:path";

import { getFleetDataDir } from "@dotobokuri/fleet-infra";

import { readFleetConsoleRelease, type FleetConsoleChannel } from "./release.js";

export interface ConsolePaths {
  readonly dir: string;
  readonly lockFile: string;
}

export interface ConsoleDataPaths {
  readonly dir: string;
  readonly stateFile: string;
  readonly capturesDir: string;
}

export interface CreateConsolePathsDeps {
  readonly channel?: FleetConsoleChannel;
  readonly env?: NodeJS.ProcessEnv;
  readonly packageRoot?: string;
  readonly uid?: number;
}

export interface CreateConsoleDataPathsDeps {
  readonly channel?: FleetConsoleChannel;
  readonly env?: NodeJS.ProcessEnv;
  readonly packageRoot?: string;
  readonly fleetDataDir?: string;
}

const LOCK_DIR_NAME = "fleet-console";
const CONSOLE_RUNTIME_DIR_NAME = "console";
const LOCK_FILE_NAME = "console.lock";
const CONSOLE_DATA_DIR_NAME = "console";
const CONSOLE_STATE_FILE_NAME = "state.json";
const CONSOLE_CAPTURES_DIR_NAME = "captures";

export function createConsolePaths(deps: CreateConsolePathsDeps = {}): ConsolePaths {
  const env = deps.env ?? process.env;
  // 명시 override가 있으면 채널별 락 네임스페이스보다 사용자가 지정한 경로를 우선한다.
  const base = env.FLEET_CONSOLE_DIR ?? defaultConsoleBaseDir(deps);
  return { dir: base, lockFile: path.join(base, LOCK_FILE_NAME) };
}

export function createConsoleDataPaths(deps: CreateConsoleDataPathsDeps = {}): ConsoleDataPaths {
  const dir = defaultConsoleDataBaseDir(deps);
  return {
    dir,
    stateFile: path.join(dir, CONSOLE_STATE_FILE_NAME),
    capturesDir: path.join(dir, CONSOLE_CAPTURES_DIR_NAME),
  };
}

function defaultConsoleBaseDir(deps: CreateConsolePathsDeps): string {
  let release: ReturnType<typeof readFleetConsoleRelease> | undefined;
  const channel = deps.channel ?? (release = readFleetConsoleRelease()).channel;

  if (channel === "local") {
    const packageRoot = deps.packageRoot ?? (release ??= readFleetConsoleRelease()).packageRoot;
    return localConsoleDir(packageRoot);
  }

  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  return path.join(os.tmpdir(), `${LOCK_DIR_NAME}-${uid}-${channel}`);
}

function defaultConsoleDataBaseDir(deps: CreateConsoleDataPathsDeps): string {
  // 1순위: 명시 fleetDataDir override(테스트/임베드)는 결정적 제어를 위해 env·채널보다 우선한다.
  if (deps.fleetDataDir !== undefined) {
    return path.join(deps.fleetDataDir, CONSOLE_DATA_DIR_NAME);
  }

  // 2순위: FLEET_CONSOLE_DIR escape hatch. lock(createConsolePaths)과 동일하게 durable state도
  // override 슬롯에 co-locate한다 — read-only 체크아웃에서 쓰기 가능 런타임 슬롯을 지정하는 경우 등에
  // state/captures가 체크아웃이 아닌 선택된 데몬 디렉터리에 격리되도록 보장한다.
  const env = deps.env ?? process.env;
  if (env.FLEET_CONSOLE_DIR) {
    return env.FLEET_CONSOLE_DIR;
  }

  // 3순위: 채널 기반 경로.
  let release: ReturnType<typeof readFleetConsoleRelease> | undefined;
  const channel = deps.channel ?? (release = readFleetConsoleRelease()).channel;

  if (channel === "local") {
    const packageRoot = deps.packageRoot ?? (release ??= readFleetConsoleRelease()).packageRoot;
    // local 개발 실행은 durable state를 lock과 동일한 프로젝트 .fleet/console 슬롯으로 격리한다.
    // 게시본(stable)과 ~/.fleet/console을 공유하지 않도록 워크트리/체크아웃별로 분리한다.
    return localConsoleDir(packageRoot);
  }

  // 게시된 stable 빌드는 durable state를 ~/.fleet/console에 영속한다(tmpdir lock과 분리).
  return path.join(getFleetDataDir(), CONSOLE_DATA_DIR_NAME);
}

function localConsoleDir(packageRoot: string): string {
  // local 개발 실행은 워크트리/체크아웃별로 lock·durable state를 프로젝트 .fleet/console 한 슬롯에 co-locate한다.
  return path.join(path.resolve(packageRoot, "..", ".."), ".fleet", CONSOLE_RUNTIME_DIR_NAME);
}

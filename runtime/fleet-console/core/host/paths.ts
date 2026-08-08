import os from "node:os";
import path from "node:path";

import { getFleetDataDir } from "@dotobokuri/core-infra";

import { resolveCanonicalStableConsolePaths } from "./desktop-protocol.js";
import { readFleetConsoleRelease, type FleetConsoleChannel } from "./release.js";

export interface ConsolePaths {
  readonly dir: string;
  readonly lockFile: string;
}

export interface ConsoleDataPaths {
  readonly dir: string;
  readonly stateFile: string;
  readonly settingsFile: string;
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

const CONSOLE_RUNTIME_DIR_NAME = "console";
const CONSOLE_DATA_DIR_NAME = "console";
const CONSOLE_STATE_FILE_NAME = "state.json";
const CONSOLE_SETTINGS_FILE_NAME = "settings.json";
const CONSOLE_DATA_DIR_ENV = "FLEET_CONSOLE_DATA_DIR";
/**
 * 개명 전 이름. 게시된 Desktop 셸이 sidecar에 넘기고 capture hook 자식이 읽는 값이라,
 * 이미 배포된 조합이 최신 Console과 계속 맞물리려면 계속 인정해야 한다.
 */
const LEGACY_CONSOLE_DATA_DIR_ENV = "FLEET_CONSOLE_DIR";

/** 이 Console 인스턴스의 슬롯을 지정한 명시 override. 새 이름이 옛 이름을 이긴다. */
function readConsoleDirOverride(env: NodeJS.ProcessEnv): string | undefined {
  return env[CONSOLE_DATA_DIR_ENV] ?? env[LEGACY_CONSOLE_DATA_DIR_ENV];
}

export function createConsolePaths(deps: CreateConsolePathsDeps = {}): ConsolePaths {
  const env = deps.env ?? process.env;
  // 명시 override가 있으면 채널별 락 네임스페이스보다 사용자가 지정한 경로를 우선한다.
  const base = readConsoleDirOverride(env) ?? defaultConsoleBaseDir(deps);
  return { dir: base, lockFile: path.join(base, "console.lock") };
}

export function createConsoleDataPaths(deps: CreateConsoleDataPathsDeps = {}): ConsoleDataPaths {
  const dir = defaultConsoleDataBaseDir(deps);
  return {
    dir,
    stateFile: path.join(dir, CONSOLE_STATE_FILE_NAME),
    settingsFile: path.join(dir, CONSOLE_SETTINGS_FILE_NAME),
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
  return resolveCanonicalStableConsolePaths({
    tmpDir: os.tmpdir(),
    uid,
    fleetDataDir: getFleetDataDir(),
  }).dir;
}

function defaultConsoleDataBaseDir(deps: CreateConsoleDataPathsDeps): string {
  // 1순위: 명시 fleetDataDir override(테스트/임베드)는 결정적 제어를 위해 env·채널보다 우선한다.
  if (deps.fleetDataDir !== undefined) {
    return path.join(deps.fleetDataDir, CONSOLE_DATA_DIR_NAME);
  }

  // 2순위: FLEET_CONSOLE_DATA_DIR escape hatch. lock(createConsolePaths)과 동일하게 durable state도
  // override 슬롯에 co-locate한다 — read-only 체크아웃에서 쓰기 가능 런타임 슬롯을 지정하는 경우 등에
  // state가 체크아웃이 아닌 선택된 데몬 디렉터리에 격리되도록 보장한다.
  const env = deps.env ?? process.env;
  const override = readConsoleDirOverride(env);
  if (override) {
    return override;
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

  // desktop은 stable과 동일한 단일 writer namespace를 사용한다.
  return resolveCanonicalStableConsolePaths({
    tmpDir: os.tmpdir(),
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    fleetDataDir: getFleetDataDir(),
  }).dataDir;
}

function localConsoleDir(packageRoot: string): string {
  // local 개발 실행은 워크트리/체크아웃별로 lock·durable state를 프로젝트 .fleet/console 한 슬롯에 co-locate한다.
  return path.join(path.resolve(packageRoot, "..", ".."), ".fleet", CONSOLE_RUNTIME_DIR_NAME);
}

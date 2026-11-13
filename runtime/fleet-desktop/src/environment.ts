import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { prependPathEntries, withNodeSystemCa } from "@fleet-console/process";
import { DESKTOP_CONSOLE_SOURCE_ENV, DESKTOP_CONSOLE_SOURCE_GITHUB_RELEASE, DESKTOP_DEVELOPMENT_ENV, DESKTOP_OWNER_ID_ENV, DESKTOP_OWNER_KIND_ENV, DESKTOP_PROTOCOL_VERSION, DESKTOP_PROTOCOL_VERSION_ENV, DESKTOP_RESOURCE_ROOT_ENV, resolveCanonicalLocalConsolePaths, resolveCanonicalStableConsolePaths } from "@fleet-console/protocol/desktop";
import { CONSOLE_RELEASE_TAG_OVERRIDE_ENV, readConsoleReleaseTagOverride } from "@fleet-console/protocol/release";

export interface DesktopEnvironment {
  readonly ownerId: string;
  readonly consoleDir: string;
  readonly dataDir: string;
  readonly serviceEnv: NodeJS.ProcessEnv;
}

export interface LoginShellPathProbe {
  readonly run: (file: string, arguments_: readonly string[], options: { readonly env: NodeJS.ProcessEnv; readonly maxBuffer: number; readonly timeout: number; readonly windowsHide: boolean }) => Promise<{ readonly stdout: string }>;
}

export interface HydratedDesktopEnvironmentOptions {
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly loginShellPathProbe?: LoginShellPathProbe;
}

const DESKTOP_CONTROL_ENV_KEYS = new Set([
  CONSOLE_RELEASE_TAG_OVERRIDE_ENV,
  DESKTOP_CONSOLE_SOURCE_ENV,
  DESKTOP_DEVELOPMENT_ENV,
  DESKTOP_OWNER_ID_ENV,
  DESKTOP_OWNER_KIND_ENV,
  DESKTOP_PROTOCOL_VERSION_ENV,
  DESKTOP_RESOURCE_ROOT_ENV,
  "FLEET_CONSOLE_DESKTOP_VERSION",
  "FLEET_CONSOLE_DIR",
  "FLEET_CONSOLE_DATA_DIR",
]);

const CONSOLE_DATA_DIR_ENV = "FLEET_CONSOLE_DATA_DIR";
const LEGACY_CONSOLE_DATA_DIR_ENV = "FLEET_CONSOLE_DIR";
const DESKTOP_DATA_DIR_ENV = "FLEET_DESKTOP_DATA_DIR";
// Fleet 루트는 sidecar까지 그대로 흘러야 하므로 위 제어 키 목록에 넣지 않는다 — Desktop이
// 다시 세우는 값이 아니라, 이 실행 전체가 어느 루트에 격리됐는지를 나르는 입력이다.
const FLEET_DATA_DIR_ENV = "FLEET_DATA_DIR";
const LOGIN_SHELL_ARGUMENTS = ["-ilc", "printf '%s' \"$PATH\""] as const;
const LOGIN_SHELL_PATH_TIMEOUT_MS = 1_000;
const LOGIN_SHELL_PATH_MAX_BUFFER = 8 * 1_024;
const INVALID_PATH_OUTPUT = /[\u0000-\u001f\u007f]/;
const execFileAsync = promisify(execFile);
const defaultLoginShellPathProbe: LoginShellPathProbe = {
  run: async (file, arguments_, options) => {
    const result = await execFileAsync(file, arguments_, { ...options, windowsHide: true });
    return { stdout: result.stdout };
  },
};

export function resolveDesktopUserDataDirectory(userDataDir: string, resourceRoot: string, isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): string {
  // 격리 실행은 Desktop의 자리를 직접 지정한다 — 콘솔 슬롯 밑이 아니라 Fleet 루트의 형제로
  // 앉아야 `~/.fleet/{console,desktop}`과 같은 모양이 된다.
  const override = resolveDesktopDataDirectoryOverride(env);
  if (override !== undefined) return override;
  return isPackaged ? userDataDir : path.join(resolveCanonicalLocalConsolePaths({ packageRoot: resourceRoot }).dir, "desktop");
}

/**
 * 패키지된 앱이 쓰던 프로필 루트. macOS·Linux 는 더 이상 여기 두지 않고, 한 번만 옮긴다.
 * Windows 는 계속 이 자리다.
 */
export function resolveLegacyBrowserProfileRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = resolveDesktopDataDirectoryOverride(env) ?? path.join(resolveFleetDataDir(env), "desktop");
  return path.join(base, "browser-profiles");
}

/**
 * 영속 브라우저 프로필이 사는 자리.
 *
 * macOS·Linux 네트워크 서비스 샌드박스는 기동 때 받은 `sessionData`(기본은 userData) 아래만
 * 파일로 쓸 수 있다. 그 밖에 `session.fromPath` 를 두면 Cookies, Network Persistent State,
 * TransportSecurity 가 생기지 않고 쿠키는 메모리에만 남는다. Local Storage 는 다른 서비스라 남는다.
 * 그래서 이 플랫폼의 프로필은 userData 안으로 둔다. 개발 실행은 userData 가 이미 격리 슬롯이다.
 *
 * Windows 는 네트워크 데이터 이전 때 그 디렉터리 ACL 을 주므로 userData 밖도 쓸 수 있다.
 * userData 기본값이 `%APPDATA%`(Roaming)이라 캐시와 쿠키가 로그온마다 동기화되므로, 로밍되지 않는 Fleet 루트를 유지한다.
 */
export function resolveBrowserProfileRoot(userDataDir: string, isPackaged: boolean, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return resolveLegacyBrowserProfileRoot(env);
  // 패키지된 앱은 격리 지정이 있어도 userData 를 옮기지 않는다. 그 실행이 사람의 실제 프로필을 열거나 비우지 않게
  // 지정된 자리를 그대로 쓴다. 그 자리가 userData 밖이면 쿠키 파일은 생기지 않는다 — 격리가 먼저다.
  if (isPackaged && (resolveDesktopDataDirectoryOverride(env) !== undefined || readEnvironmentValue(env, FLEET_DATA_DIR_ENV) !== undefined)) return resolveLegacyBrowserProfileRoot(env);
  return path.join(userDataDir, "browser-profiles");
}

export type BrowserProfileRootMigration = "moved" | "skipped" | "occupied";

/**
 * 패키지된 macOS·Linux 앱의 기존 프로필 트리를 userData 밑으로 한 번 옮긴다.
 * 개발 실행과 `FLEET_DATA_DIR`·`FLEET_DESKTOP_DATA_DIR` 격리는 사람의 실제 프로필을 건드리지 않는다.
 * 대상에 이미 내용이 있으면 `occupied`(원본은 그대로 둔다. 합치지 않는다). 원본이 심볼릭 링크면 건너뛴다.
 * 다른 볼륨으로 옮길 때는 임시 디렉터리에 복사를 끝내고 이름을 올린 뒤에만 원본을 지운다.
 * 복사가 실패하면 임시 디렉터리만 치운다. 그 실행에서 대상이 비어 있는 동안만 다음 실행이 다시 시도한다.
 * 실패한 실행에서 프로필 세션이나 히스토리 저장이 대상에 파일을 만들면 다음은 `occupied`로 건너뛰고 원본은 그 자리에 남는다.
 */
export function migrateLegacyBrowserProfileRoot(input: {
  readonly targetRoot: string;
  readonly legacyRoot: string;
  readonly isPackaged: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly renameDirectory?: (from: string, to: string) => void;
  readonly copyDirectory?: (from: string, to: string) => void;
}): BrowserProfileRootMigration {
  const env = input.env ?? process.env;
  if (!input.isPackaged) return "skipped";
  if (resolveDesktopDataDirectoryOverride(env) !== undefined) return "skipped";
  if (readEnvironmentValue(env, FLEET_DATA_DIR_ENV) !== undefined) return "skipped";
  if (path.resolve(input.targetRoot) === path.resolve(input.legacyRoot)) return "skipped";
  if (!fs.existsSync(input.legacyRoot)) return "skipped";
  const legacyStat = fs.lstatSync(input.legacyRoot);
  if (!legacyStat.isDirectory() || legacyStat.isSymbolicLink()) return "skipped";
  if (fs.existsSync(input.targetRoot)) {
    const targetStat = fs.lstatSync(input.targetRoot);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink() || fs.readdirSync(input.targetRoot).length > 0) return "occupied";
    fs.rmdirSync(input.targetRoot);
  }
  fs.mkdirSync(path.dirname(input.targetRoot), { recursive: true, mode: 0o700 });
  moveBrowserProfileRoot(input.legacyRoot, input.targetRoot, input.renameDirectory ?? fs.renameSync, input.copyDirectory ?? ((from, to) => fs.cpSync(from, to, { recursive: true })));
  return "moved";
}

function moveBrowserProfileRoot(legacyRoot: string, targetRoot: string, renameDirectory: (from: string, to: string) => void, copyDirectory: (from: string, to: string) => void): void {
  try {
    renameDirectory(legacyRoot, targetRoot);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  const staging = path.join(path.dirname(targetRoot), `${path.basename(targetRoot)}.partial`);
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    copyDirectory(legacyRoot, staging);
    renameDirectory(staging, targetRoot);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  fs.rmSync(legacyRoot, { recursive: true, force: true });
}

export function createDesktopEnvironment(userDataDir: string, appVersion: string, resourceRoot: string, isPackaged: boolean, env: NodeJS.ProcessEnv = process.env, options: HydratedDesktopEnvironmentOptions & { readonly loginShellPath?: string } = {}): DesktopEnvironment {
  // 개발 실행도 명시 슬롯을 존중한다 — 단 **새 이름만**. 옛 이름은 개발 모드에서 계속 무시하는
  // 것이 기존 불변식이다: 개발자 셸에 떠돌던 값 하나가 dev Desktop을 엉뚱한 슬롯으로 끌고 가면
  // 안 되기 때문이다. 새 이름은 이 런처가 의도적으로 심는 값이라 그 위험이 없다.
  const overrideDirectory = resolveConsoleDirectoryOverride(env, isPackaged);
  const paths = isPackaged || overrideDirectory !== undefined
    ? resolveCanonicalStableConsolePaths({ tmpDir: os.tmpdir(), uid: typeof process.getuid === "function" ? process.getuid() : 0, fleetDataDir: resolveFleetDataDir(env), consoleDirOverride: overrideDirectory })
    : resolveCanonicalLocalConsolePaths({ packageRoot: resourceRoot });
  const ownerDirectory = resolveDesktopDataDirectoryOverride(env) ?? (isPackaged ? userDataDir : paths.dir);
  const ownerFile = path.join(ownerDirectory, "desktop-owner-id");
  fs.mkdirSync(ownerDirectory, { recursive: true, mode: 0o700 });
  const ownerId = fs.existsSync(ownerFile) ? fs.readFileSync(ownerFile, "utf8").trim() : crypto.randomUUID();
  if (!fs.existsSync(ownerFile)) fs.writeFileSync(ownerFile, `${ownerId}\n`, { mode: 0o600 });
  const sanitized = sanitizeEnvironment(env);
  const releaseTagOverride = readConsoleReleaseTagOverride(env);
  const serviceBase = isPackaged
    ? createPackagedServiceEnvironment(sanitized, options.loginShellPath, options.platform ?? process.platform, options.homeDirectory ?? os.homedir())
    : sanitized;
  // TLS 검사 프록시 환경 대응(issue #531): sidecar Node가 OS 신뢰 저장소를 기본 신뢰하도록 한다. opt-out은 FLEET_CONSOLE_NO_SYSTEM_CA=1.
  const serviceBaseWithCa = env.FLEET_CONSOLE_NO_SYSTEM_CA === "1" ? serviceBase : withNodeSystemCa(serviceBase);
  return {
    ownerId,
    consoleDir: paths.dir,
    dataDir: paths.dataDir,
    serviceEnv: {
      ...serviceBaseWithCa,
      [DESKTOP_OWNER_ID_ENV]: ownerId,
      [DESKTOP_OWNER_KIND_ENV]: "desktop",
      [DESKTOP_PROTOCOL_VERSION_ENV]: String(DESKTOP_PROTOCOL_VERSION),
      [DESKTOP_RESOURCE_ROOT_ENV]: resourceRoot,
      ...(isPackaged ? {} : { [DESKTOP_DEVELOPMENT_ENV]: "1" }),
      // sidecar에는 두 이름을 함께 싣는다. 새 이름은 정식 경로이고, 옛 이름은 이 Desktop이
      // 더 낡은 Console을 절차적으로 조달했을 때의 안전망이다 — 한쪽만 아는 Console도 자리를 찾는다.
      ...(isPackaged && overrideDirectory === undefined ? {} : { FLEET_CONSOLE_DIR: paths.dir, FLEET_CONSOLE_DATA_DIR: paths.dir }),
      FLEET_CONSOLE_DESKTOP_VERSION: appVersion,
      // This shell procures Console from GitHub Releases, so Console may offer its own updates here.
      // The release tag override reaches Console only in the form the installer itself accepted.
      ...(isPackaged ? { [DESKTOP_CONSOLE_SOURCE_ENV]: DESKTOP_CONSOLE_SOURCE_GITHUB_RELEASE } : {}),
      ...(releaseTagOverride.kind === "tag" ? { [CONSOLE_RELEASE_TAG_OVERRIDE_ENV]: releaseTagOverride.tag } : {}),
    },
  };
}

export async function createHydratedDesktopEnvironment(userDataDir: string, appVersion: string, resourceRoot: string, isPackaged: boolean, env: NodeJS.ProcessEnv = process.env, options: HydratedDesktopEnvironmentOptions = {}): Promise<DesktopEnvironment> {
  const platform = options.platform ?? process.platform;
  // 잘못된 override는 느린 로그인 셸 프로브 **전에** 터뜨린다.
  resolveConsoleDirectoryOverride(env, isPackaged);
  resolveDesktopDataDirectoryOverride(env);
  resolveFleetDataDir(env);
  const loginShellPath = await readInteractiveLoginShellPath(isPackaged, env, options);
  return createDesktopEnvironment(userDataDir, appVersion, resourceRoot, isPackaged, env, { platform, homeDirectory: options.homeDirectory, loginShellPath });
}

export async function readInteractiveLoginShellPath(isPackaged: boolean, env: NodeJS.ProcessEnv, options: HydratedDesktopEnvironmentOptions = {}): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  if (!isPackaged || platform !== "darwin") return undefined;
  const sanitized = sanitizeEnvironment(env);
  const shellPath = readEnvironmentValue(sanitized, "SHELL");
  if (shellPath === undefined || !path.isAbsolute(shellPath)) return undefined;
  try {
    const { stdout } = await (options.loginShellPathProbe ?? defaultLoginShellPathProbe).run(shellPath, LOGIN_SHELL_ARGUMENTS, {
      env: sanitized,
      maxBuffer: LOGIN_SHELL_PATH_MAX_BUFFER,
      timeout: LOGIN_SHELL_PATH_TIMEOUT_MS,
      windowsHide: true,
    });
    return isSafeLoginShellPath(stdout) ? stdout : undefined;
  } catch {
    return undefined;
  }
}

export function desktopExecutableSearchPaths(homeDirectory: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): readonly string[] {
  const configuredPrefix = readEnvironmentValue(env, "npm_config_prefix");
  const pnpmHome = readEnvironmentValue(env, "PNPM_HOME");
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    const appData = readEnvironmentValue(env, "APPDATA");
    return compactPaths([
      configuredPrefix,
      pnpmHome,
      appData ? platformPath.join(appData, "npm") : undefined,
    ]);
  }
  return compactPaths([
    configuredPrefix ? platformPath.join(configuredPrefix, "bin") : undefined,
    pnpmHome,
    platformPath.join(homeDirectory, ".local", "bin"),
    ...(platform === "darwin" ? [platformPath.join(homeDirectory, "Library", "pnpm"), "/opt/homebrew/bin"] : []),
    "/usr/local/bin",
  ]);
}

export function sanitizeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toUpperCase();
    if (value !== undefined && normalizedKey !== "NODE_OPTIONS" && !normalizedKey.startsWith("ELECTRON_") && !DESKTOP_CONTROL_ENV_KEYS.has(normalizedKey)) next[key] = value;
  }
  return next;
}

function createPackagedServiceEnvironment(sanitized: NodeJS.ProcessEnv, loginShellPath: string | undefined, platform: NodeJS.Platform, homeDirectory: string): NodeJS.ProcessEnv {
  const fallbackEnvironment = prependPathEntries(sanitized, desktopExecutableSearchPaths(homeDirectory, sanitized, platform), { platform });
  if (platform !== "darwin" || loginShellPath === undefined) return fallbackEnvironment;
  // 로그인 셸, Finder가 물려준 PATH, 기존의 결정적 폴백 순서로 한 번만 정규화한다.
  // 셸에서 온 값은 오직 PATH 출력이며, 다른 셸 환경 변수는 sidecar로 전달하지 않는다.
  const pathDelimiter = ":";
  const inheritedAndFallbackPath = [sanitized.PATH, ...desktopExecutableSearchPaths(homeDirectory, sanitized, platform)].filter((value): value is string => value !== undefined).join(pathDelimiter);
  return prependPathEntries({ ...sanitized, PATH: inheritedAndFallbackPath }, loginShellPath.split(pathDelimiter), { platform });
}

function isSafeLoginShellPath(value: string): boolean {
  return value.trim().length > 0 && !INVALID_PATH_OUTPUT.test(value);
}

function resolveConsoleDirectoryOverride(env: NodeJS.ProcessEnv, isPackaged: boolean): string | undefined {
  // 새 이름이 옛 이름을 이긴다. 옛 이름은 packaged 배포에서만 인정한다 — 개발 모드에서 상속된
  // 제어 변수를 무시하는 계약을 그대로 둔다.
  const overrideDirectory = readEnvironmentValue(env, CONSOLE_DATA_DIR_ENV)
    ?? (isPackaged ? readEnvironmentValue(env, LEGACY_CONSOLE_DATA_DIR_ENV) : undefined);
  return requireAbsoluteOverride(overrideDirectory, "desktop_console_dir_must_be_absolute");
}

function resolveDesktopDataDirectoryOverride(env: NodeJS.ProcessEnv): string | undefined {
  return requireAbsoluteOverride(readEnvironmentValue(env, DESKTOP_DATA_DIR_ENV), "desktop_data_dir_must_be_absolute");
}

/** Fleet 루트. core-infra에 기대지 않되(Desktop은 그 패키지를 의존하지 않는다) 같은 스위치를 읽는다. */
function resolveFleetDataDir(env: NodeJS.ProcessEnv): string {
  return requireAbsoluteOverride(readEnvironmentValue(env, FLEET_DATA_DIR_ENV), "fleet_data_dir_must_be_absolute")
    ?? path.join(os.homedir(), ".fleet");
}

function requireAbsoluteOverride(value: string | undefined, errorCode: string): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  if (!path.isAbsolute(value)) throw new Error(errorCode);
  return value;
}

function readEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalizedName = name.toUpperCase();
  return Object.entries(env).find(([key]) => key.toUpperCase() === normalizedName)?.[1];
}

function compactPaths(values: readonly (string | undefined)[]): string[] {
  return values.filter((value): value is string => value !== undefined && value.trim().length > 0);
}

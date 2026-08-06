import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { prependPathEntries, withNodeSystemCa } from "@dotobokuri/core-process";
import { DESKTOP_DEVELOPMENT_ENV, DESKTOP_OWNER_ID_ENV, DESKTOP_OWNER_KIND_ENV, DESKTOP_PROTOCOL_VERSION, DESKTOP_PROTOCOL_VERSION_ENV, DESKTOP_RESOURCE_ROOT_ENV, resolveCanonicalLocalConsolePaths, resolveCanonicalStableConsolePaths } from "@fleet-console/desktop-protocol";

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
  readonly loginShellPathProbe?: LoginShellPathProbe;
}

const DESKTOP_CONTROL_ENV_KEYS = new Set([
  DESKTOP_DEVELOPMENT_ENV,
  DESKTOP_OWNER_ID_ENV,
  DESKTOP_OWNER_KIND_ENV,
  DESKTOP_PROTOCOL_VERSION_ENV,
  DESKTOP_RESOURCE_ROOT_ENV,
  "FLEET_CONSOLE_DESKTOP_VERSION",
  "FLEET_CONSOLE_DIR",
]);
const LOGIN_SHELL_ARGUMENTS = ["-ilc", "printf '%s' \"$PATH\""] as const;
const LOGIN_SHELL_PATH_TIMEOUT_MS = 1_000;
const LOGIN_SHELL_PATH_MAX_BUFFER = 8 * 1_024;
const INVALID_PATH_OUTPUT = /[\u0000-\u001f\u007f]/;
const execFileAsync = promisify(execFile);
const defaultLoginShellPathProbe: LoginShellPathProbe = {
  run: async (file, arguments_, options) => {
    const result = await execFileAsync(file, arguments_, options);
    return { stdout: result.stdout };
  },
};

export function resolveDesktopUserDataDirectory(userDataDir: string, resourceRoot: string, isPackaged: boolean): string {
  return isPackaged ? userDataDir : path.join(resolveCanonicalLocalConsolePaths({ packageRoot: resourceRoot }).dir, "desktop");
}

export function createDesktopEnvironment(userDataDir: string, appVersion: string, resourceRoot: string, isPackaged: boolean, env: NodeJS.ProcessEnv = process.env, options: HydratedDesktopEnvironmentOptions & { readonly loginShellPath?: string } = {}): DesktopEnvironment {
  const overrideDirectory = resolvePackagedConsoleDirectoryOverride(isPackaged, env);
  const paths = isPackaged
    ? resolveCanonicalStableConsolePaths({ tmpDir: os.tmpdir(), uid: typeof process.getuid === "function" ? process.getuid() : 0, fleetDataDir: path.join(os.homedir(), ".fleet"), consoleDirOverride: overrideDirectory })
    : resolveCanonicalLocalConsolePaths({ packageRoot: resourceRoot });
  const ownerDirectory = isPackaged ? userDataDir : paths.dir;
  const ownerFile = path.join(ownerDirectory, "desktop-owner-id");
  fs.mkdirSync(ownerDirectory, { recursive: true, mode: 0o700 });
  const ownerId = fs.existsSync(ownerFile) ? fs.readFileSync(ownerFile, "utf8").trim() : crypto.randomUUID();
  if (!fs.existsSync(ownerFile)) fs.writeFileSync(ownerFile, `${ownerId}\n`, { mode: 0o600 });
  const sanitized = sanitizeEnvironment(env);
  const serviceBase = isPackaged
    ? createPackagedServiceEnvironment(sanitized, options.loginShellPath, options.platform ?? process.platform)
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
      ...(isPackaged ? (overrideDirectory === undefined ? {} : { FLEET_CONSOLE_DIR: paths.dir }) : { FLEET_CONSOLE_DIR: paths.dir }),
      FLEET_CONSOLE_DESKTOP_VERSION: appVersion,
    },
  };
}

export async function createHydratedDesktopEnvironment(userDataDir: string, appVersion: string, resourceRoot: string, isPackaged: boolean, env: NodeJS.ProcessEnv = process.env, options: HydratedDesktopEnvironmentOptions = {}): Promise<DesktopEnvironment> {
  const platform = options.platform ?? process.platform;
  resolvePackagedConsoleDirectoryOverride(isPackaged, env);
  const loginShellPath = await readInteractiveLoginShellPath(isPackaged, env, options);
  return createDesktopEnvironment(userDataDir, appVersion, resourceRoot, isPackaged, env, { platform, loginShellPath });
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
  if (platform === "win32") {
    const appData = readEnvironmentValue(env, "APPDATA");
    return compactPaths([
      configuredPrefix,
      pnpmHome,
      appData ? path.win32.join(appData, "npm") : undefined,
    ]);
  }
  return compactPaths([
    configuredPrefix ? path.join(configuredPrefix, "bin") : undefined,
    pnpmHome,
    path.join(homeDirectory, ".local", "bin"),
    ...(platform === "darwin" ? [path.join(homeDirectory, "Library", "pnpm"), "/opt/homebrew/bin"] : []),
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

function createPackagedServiceEnvironment(sanitized: NodeJS.ProcessEnv, loginShellPath: string | undefined, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const fallbackEnvironment = prependPathEntries(sanitized, desktopExecutableSearchPaths(os.homedir(), sanitized, platform), { platform });
  if (platform !== "darwin" || loginShellPath === undefined) return fallbackEnvironment;
  // 로그인 셸, Finder가 물려준 PATH, 기존의 결정적 폴백 순서로 한 번만 정규화한다.
  // 셸에서 온 값은 오직 PATH 출력이며, 다른 셸 환경 변수는 sidecar로 전달하지 않는다.
  const inheritedAndFallbackPath = [sanitized.PATH, ...desktopExecutableSearchPaths(os.homedir(), sanitized, platform)].filter((value): value is string => value !== undefined).join(path.delimiter);
  return prependPathEntries({ ...sanitized, PATH: inheritedAndFallbackPath }, loginShellPath.split(path.delimiter), { platform });
}

function isSafeLoginShellPath(value: string): boolean {
  return value.trim().length > 0 && !INVALID_PATH_OUTPUT.test(value);
}

function resolvePackagedConsoleDirectoryOverride(isPackaged: boolean, env: NodeJS.ProcessEnv): string | undefined {
  const overrideDirectory = isPackaged ? readEnvironmentValue(env, "FLEET_CONSOLE_DIR") : undefined;
  if (overrideDirectory !== undefined && !path.isAbsolute(overrideDirectory)) throw new Error("desktop_console_dir_must_be_absolute");
  return overrideDirectory;
}

function readEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalizedName = name.toUpperCase();
  return Object.entries(env).find(([key]) => key.toUpperCase() === normalizedName)?.[1];
}

function compactPaths(values: readonly (string | undefined)[]): string[] {
  return values.filter((value): value is string => value !== undefined && value.trim().length > 0);
}

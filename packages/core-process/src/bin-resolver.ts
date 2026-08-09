import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";

export interface ResolveBinaryOptions {
  readonly platform?: NodeJS.Platform;
}

export interface ResolvedBinary {
  readonly bin: string;
  readonly prefixArgs: readonly string[];
}

const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const WINDOWS_PATH_SEPARATOR = ";";
const POSIX_PATH_SEPARATOR = ":";
const WINDOWS_SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);
const CMD_EXPANSION_SENSITIVE_PATTERN = /[%^]/;

export function resolveBinary(defaultBin: string, overrideName: string, env: NodeJS.ProcessEnv, options: ResolveBinaryOptions = {}): ResolvedBinary {
  const override = env[overrideName];
  if (override && override.trim().length > 0) {
    const resolvedOverride = resolvePathBinary(override, env, options);
    if (!resolvedOverride) {
      throw new Error(`${overrideName}="${override}" did not resolve to an executable; provide an absolute path or a name discoverable on PATH`);
    }
    return resolvedOverride;
  }

  const resolved = resolvePathBinary(defaultBin, env, options);
  if (!resolved) {
    throw new Error(`${defaultBin} binary not found; set ${overrideName} or install ${defaultBin} on PATH`);
  }

  return resolved;
}

export function resolvePathBinary(command: string, env: NodeJS.ProcessEnv, options: ResolveBinaryOptions = {}): ResolvedBinary | undefined {
  const resolved = findBinaryPath(command, env, options);
  return resolved ? wrapWindowsShim(resolved, env, options.platform ?? process.platform) : undefined;
}

export function findBinaryPath(command: string, env: NodeJS.ProcessEnv, options: ResolveBinaryOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const isWindows = platform === "win32";
  const pathValue = isWindows ? (env.Path ?? env.PATH ?? "") : (env.PATH ?? "");
  const pathExts = isWindows ? parsePathExt(env.PATHEXT) : [""];
  return findOnPath(command, pathValue, pathExts, platform);
}

export function createChildEnv(env: NodeJS.ProcessEnv, overlay: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      child[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined) {
      child[key] = value;
    }
  }
  return child;
}

export function prependPathEntries(env: NodeJS.ProcessEnv, entries: readonly string[], options: ResolveBinaryOptions = {}): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const isWindows = platform === "win32";
  const pathKey = isWindows ? Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path" : "PATH";
  const existingPath = isWindows ? (env.Path ?? env.PATH) : env.PATH;
  const separator = isWindows ? WINDOWS_PATH_SEPARATOR : POSIX_PATH_SEPARATOR;
  const seen = new Set<string>();
  const pathEntries: string[] = [];
  for (const entry of [...entries, ...(existingPath?.split(separator) ?? [])]) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const identity = isWindows ? trimmed.toLowerCase() : trimmed;
    if (seen.has(identity)) continue;
    seen.add(identity);
    pathEntries.push(trimmed);
  }
  const next = createChildEnv(env, {});
  if (isWindows) {
    for (const key of Object.keys(next)) {
      if (key.toLowerCase() === "path") delete next[key];
    }
  }
  if (pathEntries.length > 0) next[pathKey] = pathEntries.join(separator);
  return next;
}

function wrapWindowsShim(resolved: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ResolvedBinary {
  if (platform !== "win32" || !WINDOWS_SHIM_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    return { bin: resolved, prefixArgs: [] };
  }
  rejectCmdExpansionSensitiveShim(resolved);
  return {
    bin: env.ComSpec ?? "cmd.exe",
    prefixArgs: ["/d", "/s", "/c", "call", forceWindowsArgQuoting(resolved)],
  };
}

function rejectCmdExpansionSensitiveShim(resolved: string): void {
  if (CMD_EXPANSION_SENSITIVE_PATTERN.test(resolved)) {
    throw new Error(`Refusing to run Windows shim path with cmd.exe expansion-sensitive characters (% or ^): ${resolved}`);
  }
}

function forceWindowsArgQuoting(value: string): string {
  return `${value} `;
}

function findOnPath(bin: string, pathValue: string, pathExts: readonly string[], platform: NodeJS.Platform): string | undefined {
  const pathSeparator = platform === "win32" ? WINDOWS_PATH_SEPARATOR : path.delimiter;
  if (hasPathSeparator(bin, platform) || path.isAbsolute(bin)) {
    return resolveWithExtensions(bin, pathExts, platform);
  }

  for (const entry of pathValue.split(pathSeparator)) {
    const searchDir = entry.length === 0 ? "." : entry;
    const candidate = resolveWithExtensions(path.join(searchDir, bin), pathExts, platform);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function resolveWithExtensions(candidate: string, pathExts: readonly string[], platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32" || path.extname(candidate).length > 0) {
    return isAccessibleExecutable(candidate, platform) ? candidate : undefined;
  }
  for (const ext of pathExts) {
    if (ext.length === 0) {
      continue;
    }
    const withExt = `${candidate}${ext}`;
    if (existsSync(withExt)) {
      return withExt;
    }
  }
  return isAccessibleExecutable(candidate, platform) ? candidate : undefined;
}

function isAccessibleExecutable(candidate: string, platform: NodeJS.Platform): boolean {
  if (!existsSync(candidate)) return false;
  if (platform === "win32") return true;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasPathSeparator(value: string, platform: NodeJS.Platform): boolean {
  if (value.includes("/")) {
    return true;
  }
  return platform === "win32" && value.includes("\\");
}

function parsePathExt(pathExt: string | undefined): string[] {
  const raw = pathExt && pathExt.trim().length > 0 ? pathExt : DEFAULT_WINDOWS_PATHEXT;
  return raw
    .split(WINDOWS_PATH_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function withHidden<T extends object>(options?: T): T & { windowsHide: true } {
  return { ...(options ?? {}), windowsHide: true } as T & { windowsHide: true };
}

import fs from "node:fs";
import path from "node:path";

export interface ResolvePathBinaryOptions {
  readonly exists?: (path: string) => boolean;
  readonly platform?: NodeJS.Platform;
}

export interface ResolvedBinary {
  readonly bin: string;
  readonly prefixArgs: readonly string[];
}

const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const WINDOWS_PATH_SEPARATOR = ";";
const WINDOWS_SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);
const CMD_EXPANSION_SENSITIVE_PATTERN = /[%^]/;

export function resolvePathBinary(
  command: string,
  env: NodeJS.ProcessEnv,
  options: ResolvePathBinaryOptions = {},
): ResolvedBinary | undefined {
  const platform = options.platform ?? process.platform;
  const isWindows = platform === "win32";
  const pathValue = isWindows ? (env.Path ?? env.PATH ?? "") : (env.PATH ?? "");
  const pathExts = isWindows ? parsePathExt(env.PATHEXT) : [""];
  const resolved = findOnPath(command, pathValue, pathExts, platform, options.exists ?? fs.existsSync);
  return resolved ? wrapWindowsShim(resolved, env, platform) : undefined;
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

function findOnPath(
  bin: string,
  pathValue: string,
  pathExts: readonly string[],
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
): string | undefined {
  const pathSeparator = platform === "win32" ? WINDOWS_PATH_SEPARATOR : path.delimiter;
  if (hasPathSeparator(bin, platform) || path.isAbsolute(bin)) {
    return resolveWithExtensions(bin, pathExts, platform, exists);
  }

  for (const entry of pathValue.split(pathSeparator)) {
    const searchDir = entry.length === 0 ? "." : entry;
    const candidate = resolveWithExtensions(path.join(searchDir, bin), pathExts, platform, exists);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function resolveWithExtensions(
  candidate: string,
  pathExts: readonly string[],
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
): string | undefined {
  if (platform !== "win32" || path.extname(candidate).length > 0) {
    return exists(candidate) ? candidate : undefined;
  }
  for (const ext of pathExts) {
    if (ext.length === 0) {
      continue;
    }
    const withExt = `${candidate}${ext}`;
    if (exists(withExt)) {
      return withExt;
    }
  }
  return exists(candidate) ? candidate : undefined;
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

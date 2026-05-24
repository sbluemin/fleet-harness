import { existsSync } from "node:fs";
import path from "node:path";

export interface ResolvedBinary {
  readonly bin: string;
  readonly prefixArgs: readonly string[];
}

const PATH_SEPARATOR = path.delimiter;
const IS_WINDOWS = process.platform === "win32";
const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const WINDOWS_SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);

export function resolveBinary(defaultBin: string, overrideName: string, env: NodeJS.ProcessEnv): ResolvedBinary {
  const pathValue = IS_WINDOWS ? (env.Path ?? env.PATH ?? "") : (env.PATH ?? "");
  const pathExts = IS_WINDOWS ? parsePathExt(env.PATHEXT) : [""];

  const override = env[overrideName];
  if (override && override.trim().length > 0) {
    const resolvedOverride = findOnPath(override, pathValue, pathExts);
    if (!resolvedOverride) {
      throw new Error(`${overrideName}="${override}" did not resolve to an executable; provide an absolute path or a name discoverable on PATH`);
    }
    return wrapWindowsShim(resolvedOverride);
  }

  const resolved = findOnPath(defaultBin, pathValue, pathExts);
  if (!resolved) {
    throw new Error(`${defaultBin} binary not found; set ${overrideName} or install ${defaultBin} on PATH`);
  }

  return wrapWindowsShim(resolved);
}

function wrapWindowsShim(resolved: string): ResolvedBinary {
  if (!IS_WINDOWS || !WINDOWS_SHIM_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    return { bin: resolved, prefixArgs: [] };
  }
  return {
    bin: process.env.ComSpec ?? "cmd.exe",
    prefixArgs: ["/d", "/s", "/c", resolved],
  };
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

function findOnPath(bin: string, pathValue: string, pathExts: readonly string[]): string | undefined {
  if (hasPathSeparator(bin) || path.isAbsolute(bin)) {
    return resolveWithExtensions(bin, pathExts);
  }

  for (const entry of pathValue.split(PATH_SEPARATOR)) {
    const searchDir = entry.length === 0 ? "." : entry;
    const candidate = resolveWithExtensions(path.join(searchDir, bin), pathExts);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function resolveWithExtensions(candidate: string, pathExts: readonly string[]): string | undefined {
  // POSIX, or an explicit extension on Windows: only the literal candidate is a match.
  if (!IS_WINDOWS || path.extname(candidate).length > 0) {
    return existsSync(candidate) ? candidate : undefined;
  }
  // Windows + bare name: PATHEXT extensions take precedence over an extensionless match.
  for (const ext of pathExts) {
    if (ext.length === 0) {
      continue;
    }
    const withExt = `${candidate}${ext}`;
    if (existsSync(withExt)) {
      return withExt;
    }
  }
  return existsSync(candidate) ? candidate : undefined;
}

function hasPathSeparator(value: string): boolean {
  if (value.includes("/")) {
    return true;
  }
  return IS_WINDOWS && value.includes("\\");
}

function parsePathExt(pathExt: string | undefined): string[] {
  const raw = pathExt && pathExt.trim().length > 0 ? pathExt : DEFAULT_WINDOWS_PATHEXT;
  return raw
    .split(PATH_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}


import { existsSync } from "node:fs";
import path from "node:path";

const PATH_SEPARATOR = path.delimiter;

export function resolveBinary(defaultBin: string, overrideName: string, env: NodeJS.ProcessEnv): string {
  const override = env[overrideName];
  if (override && override.trim().length > 0) {
    return override;
  }

  const resolved = findOnPath(defaultBin, env.PATH ?? "");
  if (!resolved) {
    throw new Error(`${defaultBin} binary not found; set ${overrideName} or install ${defaultBin} on PATH`);
  }

  return resolved;
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

function findOnPath(bin: string, pathValue: string): string | undefined {
  if (bin.includes("/")) {
    return existsSync(bin) ? bin : undefined;
  }

  for (const entry of pathValue.split(PATH_SEPARATOR)) {
    const candidate = path.join(entry, bin);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}


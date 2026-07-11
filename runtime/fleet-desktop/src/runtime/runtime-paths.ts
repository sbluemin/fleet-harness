import path from "node:path";

export interface RuntimePaths {
  readonly root: string;
  readonly node: string;
  readonly console: string;
  readonly latest: string;
}

export interface RuntimePathFileSystem {
  access(path: string): Promise<void>;
}

export interface RuntimePresence {
  readonly node: boolean;
  readonly latest: boolean;
}

const FLEET_DIRECTORY = ".fleet";

export function resolveRuntimePaths(homeDirectory: string): RuntimePaths {
  const root = path.join(homeDirectory, FLEET_DIRECTORY, "desktop", "runtime");
  const console = path.join(root, "console");
  return { root, node: path.join(root, "node"), console, latest: path.join(console, "latest") };
}

export function createStagingPath(paths: RuntimePaths, suffix: string): string {
  if (!suffix || /[\\/]/.test(suffix)) throw new Error("runtime_staging_suffix_invalid");
  return path.join(paths.console, `.staging-${suffix}`);
}

export async function readRuntimePresence(paths: RuntimePaths, fileSystem: RuntimePathFileSystem): Promise<RuntimePresence> {
  const [node, latest] = await Promise.all([pathExists(paths.node, fileSystem), pathExists(paths.latest, fileSystem)]);
  return { node, latest };
}

async function pathExists(target: string, fileSystem: RuntimePathFileSystem): Promise<boolean> {
  try {
    await fileSystem.access(target);
    return true;
  } catch {
    return false;
  }
}

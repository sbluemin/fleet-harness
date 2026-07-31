import { spawn } from "node:child_process";
import path from "node:path";

import { resolveContainedActionPath } from "./path-actions.js";

export type FileRevealMode = "reveal" | "open";

export class FileActionUnavailableError extends Error {
  constructor() {
    super("action_unavailable");
    this.name = "FileActionUnavailableError";
  }
}

export interface RevealCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export interface RevealActionDependencies {
  readonly platform: NodeJS.Platform;
  readonly launch: (file: string, args: readonly string[]) => Promise<void>;
}

const DEFAULT_DEPENDENCIES: RevealActionDependencies = {
  platform: process.platform,
  launch: spawnDetached,
};

export async function revealPath(
  theaterPath: string,
  relativePath: string,
  mode: FileRevealMode,
  dependencies: Partial<RevealActionDependencies> = {},
): Promise<void> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const absolutePath = await resolveContainedActionPath(theaterPath, relativePath);
  const command = resolveRevealCommand(deps.platform, mode, absolutePath);
  if (!command) throw new FileActionUnavailableError();

  try {
    await deps.launch(command.file, command.args);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new FileActionUnavailableError();
    throw error;
  }
}

export function resolveRevealCommand(
  platform: NodeJS.Platform,
  mode: FileRevealMode,
  absolutePath: string,
): RevealCommand | null {
  if (platform === "darwin") {
    return mode === "reveal"
      ? { file: "open", args: ["-R", absolutePath] }
      : { file: "open", args: [absolutePath] };
  }
  if (platform === "linux") {
    return {
      file: "xdg-open",
      args: [mode === "reveal" ? path.dirname(absolutePath) : absolutePath],
    };
  }
  if (platform === "win32") {
    return mode === "reveal"
      ? { file: "explorer", args: [`/select,${absolutePath}`] }
      : { file: "explorer", args: [absolutePath] };
  }
  return null;
}

function spawnDetached(file: string, args: readonly string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(file, [...args], {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

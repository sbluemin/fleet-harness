import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveContainedActionPath } from "./path-actions.js";

export class ClipboardUnavailableError extends Error {
  constructor() {
    super("clipboard_unavailable");
    this.name = "ClipboardUnavailableError";
  }
}

export interface ClipboardCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export interface ClipboardActionDependencies {
  readonly platform: NodeJS.Platform;
  readonly findExecutable: (name: string) => Promise<string | null>;
  readonly runWithInput: (file: string, args: readonly string[], input: string) => Promise<void>;
}

const LINUX_CLIPBOARD_TOOLS = [
  { name: "wl-copy", args: [] },
  { name: "xclip", args: ["-selection", "clipboard"] },
  { name: "xsel", args: ["--clipboard", "--input"] },
] as const;

const DEFAULT_DEPENDENCIES: ClipboardActionDependencies = {
  platform: process.platform,
  findExecutable: findExecutableOnPath,
  runWithInput: execFileWithInput,
};

export async function copyPathToClipboard(
  theaterPath: string,
  relativePath: string,
  dependencies: Partial<ClipboardActionDependencies> = {},
): Promise<void> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const { logicalPath } = await resolveContainedActionPath(theaterPath, relativePath);
  const command = await resolveClipboardCommand(deps.platform, deps.findExecutable);
  if (!command) throw new ClipboardUnavailableError();

  try {
    await deps.runWithInput(command.file, command.args, logicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ClipboardUnavailableError();
    throw error;
  }
}

export async function resolveClipboardCommand(
  platform: NodeJS.Platform,
  findExecutable: ClipboardActionDependencies["findExecutable"] = findExecutableOnPath,
): Promise<ClipboardCommand | null> {
  if (platform === "darwin") return { file: "pbcopy", args: [] };
  if (platform === "win32") return { file: "clip.exe", args: [] };
  if (platform !== "linux") return null;

  for (const candidate of LINUX_CLIPBOARD_TOOLS) {
    const executable = await findExecutable(candidate.name);
    if (executable) return { file: executable, args: candidate.args };
  }
  return null;
}

async function findExecutableOnPath(name: string): Promise<string | null> {
  const rawPath = process.env.PATH ?? "";
  for (const directory of rawPath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep probing PATH in order.
    }
  }
  return null;
}

function execFileWithInput(file: string, args: readonly string[], input: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const child = execFile(
      file,
      [...args],
      { shell: false, timeout: 5_000, windowsHide: true },
      (error) => finish(error),
    );
    child.once("error", finish);
    if (!child.stdin) {
      finish(new Error("clipboard stdin unavailable"));
      return;
    }
    child.stdin.once("error", finish);
    child.stdin.end(input);
  });
}

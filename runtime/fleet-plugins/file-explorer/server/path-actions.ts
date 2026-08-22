import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type PathActionErrorCode = "path_outside_theater" | "not_found" | "forbidden";

export class PathActionError extends Error {
  readonly code: PathActionErrorCode;

  constructor(code: PathActionErrorCode) {
    super(code);
    this.name = "PathActionError";
    this.code = code;
  }
}

export interface ResolvedActionPath {
  readonly logicalPath: string;
  readonly realPath: string;
}

async function resolveContainedActionPath(
  theaterPath: string,
  relativePath: string,
): Promise<ResolvedActionPath> {
  if (path.isAbsolute(relativePath)) throw new PathActionError("path_outside_theater");
  const rootPath = path.resolve(theaterPath);
  const candidatePath = path.resolve(rootPath, relativePath);
  if (!isPathContained(rootPath, candidatePath)) throw new PathActionError("path_outside_theater");

  let realRootPath: string;
  let realCandidatePath: string;
  try {
    [realRootPath, realCandidatePath] = await Promise.all([
      fs.realpath(rootPath),
      fs.realpath(candidatePath),
    ]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new PathActionError("forbidden");
    throw new PathActionError("not_found");
  }

  if (!isPathContained(realRootPath, realCandidatePath)) {
    throw new PathActionError("path_outside_theater");
  }

  return {
    // Preserve the row the user acted on for display-only actions such as copying path text.
    logicalPath: candidatePath,
    // Process-launch actions must use the same resolved path that passed containment.
    realPath: realCandidatePath,
  };
}

function isPathContained(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// ═══ reveal ══════════════════════════════════════════════════════════════════

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

const DEFAULT_REVEAL_DEPENDENCIES: RevealActionDependencies = {
  platform: process.platform,
  launch: spawnDetached,
};

export async function revealPath(
  theaterPath: string,
  relativePath: string,
  mode: FileRevealMode,
  dependencies: Partial<RevealActionDependencies> = {},
): Promise<void> {
  const deps = { ...DEFAULT_REVEAL_DEPENDENCIES, ...dependencies };
  const { realPath } = await resolveContainedActionPath(theaterPath, relativePath);
  const command = resolveRevealCommand(deps.platform, mode, realPath);
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

// ═══ clipboard ═══════════════════════════════════════════════════════════════

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

const DEFAULT_CLIPBOARD_ACTION_DEPENDENCIES: ClipboardActionDependencies = {
  platform: process.platform,
  findExecutable: findExecutableOnPath,
  runWithInput: execFileWithInput,
};

export async function copyPathToClipboard(
  theaterPath: string,
  relativePath: string,
  dependencies: Partial<ClipboardActionDependencies> = {},
): Promise<void> {
  const deps = { ...DEFAULT_CLIPBOARD_ACTION_DEPENDENCIES, ...dependencies };
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

async function resolveClipboardCommand(
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

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface DesktopDevProcess {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

interface DesktopDevInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

export interface DesktopDevLauncherDeps {
  readonly cwd?: string;
  readonly desktopPackageDirectory?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly isPackageManagerExecutable?: (filePath: string) => boolean;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: (command: string, args: readonly string[], options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly stdio: "inherit"; readonly windowsHide: true }) => DesktopDevProcess;
}

const cliPackageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function runDesktopDev(deps: DesktopDevLauncherDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const desktopPackageDirectory = deps.desktopPackageDirectory ?? path.resolve(cliPackageDirectory, "..", "fleet-console-desktop");
  const invocation = platform === "win32"
    ? resolveWindowsPackageManager(env, deps.execPath ?? process.execPath, desktopPackageDirectory, deps.isPackageManagerExecutable)
    : { command: "pnpm", args: ["--dir", desktopPackageDirectory, "dev"] };
  const child = (deps.spawn ?? spawn)(invocation.command, invocation.args, {
    cwd: deps.cwd ?? env.INIT_CWD ?? process.cwd(),
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  return new Promise<number>((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (typeof code === "number") {
        resolve(code);
        return;
      }
      resolve(signal ? 1 : 0);
    });
  });
}

function resolveWindowsPackageManager(env: NodeJS.ProcessEnv, execPath: string, desktopPackageDirectory: string, isPackageManagerExecutable = isRegularFile): DesktopDevInvocation {
  const packageManagerPath = env.npm_execpath;
  if (!packageManagerPath || !path.win32.isAbsolute(packageManagerPath) || !isPackageManagerExecutable(packageManagerPath)) {
    throw new Error("desktop_development_package_manager_unavailable: npm_execpath must reference an absolute package-manager executable");
  }
  const args = ["--dir", desktopPackageDirectory, "dev"];
  const extension = path.win32.extname(packageManagerPath).toLowerCase();
  if ([".js", ".cjs", ".mjs"].includes(extension)) return { command: execPath, args: [packageManagerPath, ...args] };
  if (extension === ".exe") return { command: packageManagerPath, args };
  throw new Error("desktop_development_package_manager_unavailable: npm_execpath must reference a JavaScript entrypoint or native .exe");
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

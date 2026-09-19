import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export {
  assertCliCanControlDaemon,
  buildConsoleHelpText,
  createConsoleDaemonLifecycle,
  isLockProcessAlive,
  main,
  resolveDefaultServerModulePath,
  openFleetConsole,
  parseConsoleCliMode,
  parseConsoleHookCommand,
  runConsoleRestart,
  runConsoleStatus,
  runConsoleStop,
  type BuildConsoleHelpTextOptions,
  type ConsoleCliMode,
  type ConsoleDaemonLifecycleDeps,
  type ConsoleDaemonProcess,
  type ConsoleDaemonSpawner,
  type ConsoleHookCommand,
  type ConsoleRestartDeps,
  type ConsoleStatusDeps,
  type ConsoleStopDeps,
  type OpenFleetConsoleDeps,
  type OpenFleetConsoleResult,
} from "./console-lifecycle.js";

import { main } from "./console-lifecycle.js";

// npm/pnpm 글로벌 bin은 dist/cli.mjs로의 symlink다. path.resolve는 symlink를
// 풀지 않으므로 argv[1]과 import.meta.url이 달라 main()이 영영 스킵된다.
// /var vs /private/var 같은 플랫폼 alias도 realpath로 정규화한다.
export function isCliDirectRun(argv1: string | undefined, moduleUrl: string = import.meta.url): boolean {
  if (!argv1) return false;
  try {
    return fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isCliDirectRun(process.argv[1])) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

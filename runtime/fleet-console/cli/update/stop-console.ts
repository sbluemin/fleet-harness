import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePathBinary, type ResolvedBinary } from "@dotobokuri/core-agent";

import type { UpdateCommandIo } from "./types.js";

const CONSOLE_BIN = "fleet-console";
const STOP_TIMEOUT_MS = 15_000;
const CONSOLE_PACKAGE_NAME = "@dotobokuri/fleet-console";

export interface StopRunningConsoleDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly resolveBinary?: (command: string, env: NodeJS.ProcessEnv) => ResolvedBinary | undefined;
  readonly spawn?: typeof spawn;
  readonly siblingCliPath?: string;
}

// fleet update가 글로벌 패키지를 덮어쓰기 전에 실행 중인 Fleet Console 데몬을
// best-effort로 정지시킨다. 데몬은 네이티브 애드온과 플랫폼 바이너리를
// 로드한 채 유지되므로, 살아 있는 동안에는 Windows에서 설치 트리 파일이 잠겨
// npm cleanup이 EPERM으로 실패하고 전역 bin shim 재링크가 치명 종료된다.
// 데몬을 먼저 내려 잠금을 풀면 재설치가 깨끗하게 진행되며, 다음 사용 시 자동 재기동된다.
//
// 같은 패키지의 sibling dist/cli.mjs stop을 먼저 시도하고, 없으면 PATH의
// `fleet-console` 바이너리로 폴백한다.
export async function stopRunningConsoleBeforeUpdate(
  io: UpdateCommandIo,
  deps: StopRunningConsoleDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const siblingCliPath = deps.siblingCliPath ?? resolveSiblingConsoleCliPath();
  if (siblingCliPath) {
    io.stdout.write("Stopping the running Fleet Console to release file locks before update...\n");
    await runNodeStop(siblingCliPath, io, deps.spawn ?? spawn);
    return;
  }

  const resolveBinary = deps.resolveBinary ?? ((command, processEnv) => resolvePathBinary(command, processEnv));
  let consoleBin: ResolvedBinary | undefined;
  try {
    consoleBin = resolveBinary(CONSOLE_BIN, env);
  } catch {
    // Windows shim 경로의 %/^ 거부처럼 resolver 실패도 best-effort로 통과한다.
    return;
  }
  if (!consoleBin) {
    // fleet-console가 PATH에 없으면 정지할 데몬도 없다 — 조용히 통과.
    return;
  }
  io.stdout.write("Stopping the running Fleet Console to release file locks before update...\n");
  await runConsoleStop(consoleBin, io, deps.spawn ?? spawn);
}

// 소스(cli/update/*.ts)와 번들(dist/fleet.mjs) 모두에서 패키지 루트의 dist/cli.mjs를 찾는다.
// 상대 경로 한 칸으로는 둘을 동시에 맞출 수 없으므로 package.json 이름으로 패키지 루트를 확정한다.
export function resolveSiblingConsoleCliPath(moduleUrl: string = import.meta.url): string | undefined {
  try {
    const start = path.dirname(fileURLToPath(moduleUrl));
    let dir = start;
    for (let i = 0; i < 8; i += 1) {
      const packageJsonPath = path.join(dir, "package.json");
      if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: string };
        if (pkg.name === CONSOLE_PACKAGE_NAME) {
          const candidate = path.join(dir, "dist", "cli.mjs");
          return fs.existsSync(candidate) ? candidate : undefined;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    // package.json을 못 찾는 변형 레이아웃에서도 dist/fleet.mjs 옆의 cli.mjs는 인정한다.
    const sameDir = path.join(start, "cli.mjs");
    if (path.basename(start) === "dist" && fs.existsSync(sameDir)) return sameDir;
  } catch {
    // best-effort
  }
  return undefined;
}

function runNodeStop(
  cliPath: string,
  io: UpdateCommandIo,
  spawnImpl: typeof spawn,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const child = spawnImpl(process.execPath, [cliPath, "stop"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      io.stderr.write("Fleet Console did not stop within the timeout; continuing with the update.\n");
      child.kill();
      finish();
    }, STOP_TIMEOUT_MS);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.on("error", finish);
    child.on("exit", finish);
  });
}

function runConsoleStop(
  consoleBin: ResolvedBinary,
  io: UpdateCommandIo,
  spawnImpl: typeof spawn,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const child = spawnImpl(consoleBin.bin, [...consoleBin.prefixArgs, "stop"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      // 데몬이 응답하지 않아도 update를 막지 않는다 — 정지 자식을 종료하고 진행.
      io.stderr.write("Fleet Console did not stop within the timeout; continuing with the update.\n");
      child.kill();
      finish();
    }, STOP_TIMEOUT_MS);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.on("error", finish);
    child.on("exit", finish);
  });
}

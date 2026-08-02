import { spawn } from "node:child_process";

import { resolvePathBinary, type ResolvedBinary } from "@dotobokuri/core-agent";

import type { UpdateCommandIo } from "./types.js";

const CONSOLE_BIN = "fleet-console";
const STOP_TIMEOUT_MS = 15_000;

export interface StopRunningConsoleDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly resolveBinary?: (command: string, env: NodeJS.ProcessEnv) => ResolvedBinary | undefined;
  readonly spawn?: typeof spawn;
}

// fleet update가 글로벌 패키지를 덮어쓰기 전에 실행 중인 Fleet Console 데몬을
// best-effort로 정지시킨다. 데몬은 node-pty 네이티브 애드온과 winpty 바이너리를
// 로드한 채 유지되므로, 살아 있는 동안에는 Windows에서 설치 트리 파일이 잠겨
// npm cleanup이 EPERM(node-pty\deps rmdir)으로 실패하고 전역 bin shim 재링크가
// 치명 종료된다. 데몬을 먼저 내려 잠금을 풀면 재설치가 깨끗하게 진행되며,
// 데몬은 다음 사용 시 자동 재기동된다.
//
// fleet-cli와 fleet-console는 peer 패키지라 require.resolve로 sibling을 찾을 수
// 없다. 독립 설치된 `fleet-console` PATH 바이너리를 호출한다.
export async function stopRunningConsoleBeforeUpdate(
  io: UpdateCommandIo,
  deps: StopRunningConsoleDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const resolveBinary = deps.resolveBinary ?? ((command, processEnv) => resolvePathBinary(command, processEnv));
  const consoleBin = resolveBinary(CONSOLE_BIN, env);
  if (!consoleBin) {
    // fleet-console가 PATH에 없으면 정지할 데몬도 없다 — 조용히 통과.
    return;
  }
  io.stdout.write("Stopping the running Fleet Console to release file locks before update...\n");
  await runConsoleStop(consoleBin, io, deps.spawn ?? spawn);
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

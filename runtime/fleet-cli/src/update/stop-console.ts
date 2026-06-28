import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import type { UpdateCommandIo } from "./types.js";

const CONSOLE_CLI_SPECIFIER = "@dotobokuri/fleet-console/cli";
const STOP_TIMEOUT_MS = 15_000;

const requireFromHere = createRequire(import.meta.url);

// fleet update가 글로벌 패키지를 덮어쓰기 전에 실행 중인 Fleet Console 데몬을
// best-effort로 정지시킨다. 데몬은 node-pty 네이티브 애드온과 winpty 바이너리를
// 로드한 채 유지되므로, 살아 있는 동안에는 Windows에서 설치 트리 파일이 잠겨
// npm cleanup이 EPERM(node-pty\deps rmdir)으로 실패하고 전역 bin shim 재링크가
// 치명 종료된다. 데몬을 먼저 내려 잠금을 풀면 재설치가 깨끗하게 진행되며,
// 데몬은 다음 사용 시 자동 재기동된다.
export async function stopRunningConsoleBeforeUpdate(io: UpdateCommandIo): Promise<void> {
  let cliPath: string;
  try {
    cliPath = requireFromHere.resolve(CONSOLE_CLI_SPECIFIER);
  } catch {
    // fleet-console가 설치돼 있지 않으면 정지할 데몬도 없다 — 조용히 통과.
    return;
  }
  io.stdout.write("Stopping the running Fleet Console to release file locks before update...\n");
  await runConsoleStop(cliPath, io);
}

function runConsoleStop(cliPath: string, io: UpdateCommandIo): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const child = spawn(process.execPath, [cliPath, "stop"], { stdio: "ignore" });
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

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `pnpm cli` / `pnpm console` / `pnpm desktop`의 공통 진입점. 세 호스트가 **같은** 격리
 * 데이터 루트를 보게 만드는 것이 이 런처의 전부다.
 *
 * 격리가 필요한 이유는 이 셋이 기본값으로는 사용자의 실제 `~/.fleet`을 읽고 쓰기 때문이다 —
 * 자격 증명·전역 설정·AI Gateway 선별·워크스페이스가 전부 거기 산다. 개발 실행이 그 자리를
 * 공유하면 테스트가 실사용자 환경을 오염시킨다.
 *
 * 배치는 프로덕션과 같은 모양을 격리 루트 밑에 그대로 재현한다:
 *
 *   <checkout>/.fleet/isolated/          FLEET_DATA_DIR         (auth·settings·ai-gateway·workspaces)
 *   <checkout>/.fleet/isolated/console/  FLEET_CONSOLE_DATA_DIR (durable state·잠금)
 *   <checkout>/.fleet/isolated/desktop/  FLEET_DESKTOP_DATA_DIR (owner·userData)
 *
 * 값은 모두 절대경로다. 이 변수들은 cwd가 제각각인 자식 프로세스로 상속되므로(capture hook은
 * Theater 루트에서 돈다) 상대경로면 프로세스마다 다른 자리를 가리킨다.
 *
 * 셸 앞에 붙이는 `FOO=... pnpm ...` 대신 런처를 두는 이유는 두 가지다: 그 문법은 Windows
 * cmd에서 동작하지 않고, 체크아웃 절대경로는 실행 시점에만 알 수 있다.
 */

const TARGETS = {
  cli: ["pnpm", "--filter", "@dotobokuri/fleet-cli", "dev"],
  console: [process.execPath, "runtime/fleet-console/dist/cli.mjs"],
  desktop: ["pnpm", "--filter", "@dotobokuri/fleet-desktop", "dev"],
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const isolatedRoot = path.join(repoRoot, ".fleet", "isolated");

const [target, ...forwarded] = process.argv.slice(2);
const command = TARGETS[target];
if (command === undefined) {
  process.stderr.write(`unknown target: ${target ?? "(none)"}. expected one of ${Object.keys(TARGETS).join(", ")}\n`);
  process.exit(1);
}

// 호출자가 이미 자기 슬롯을 지정했다면 그쪽이 사실이다 — e2e·진단 실행이 자기 데이터 디렉터리를
// 잡고 들어오는 경로를 이 기본값이 덮어써서는 안 된다.
const env = {
  ...process.env,
  FLEET_DATA_DIR: process.env.FLEET_DATA_DIR ?? isolatedRoot,
  FLEET_CONSOLE_DATA_DIR: process.env.FLEET_CONSOLE_DATA_DIR ?? process.env.FLEET_CONSOLE_DIR ?? path.join(isolatedRoot, "console"),
  FLEET_DESKTOP_DATA_DIR: process.env.FLEET_DESKTOP_DATA_DIR ?? path.join(isolatedRoot, "desktop"),
};

const [file, ...args] = command;
// Windows에서 `pnpm`은 `.cmd` shim이라 Node가 셸 없이는 띄우지 못한다. POSIX에서는 셸을 거치지
// 않으므로 전달 인자가 다시 파싱되지 않는다.
const useShell = file === "pnpm" && process.platform === "win32";
const child = spawn(file, [...args, ...forwarded], {
  cwd: repoRoot,
  stdio: "inherit",
  env,
  shell: useShell,
});

child.on("error", (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

// 신호로 끝난 자식은 exit code가 null이다. 그대로 0으로 접히면 Ctrl+C나 강제 종료가 성공한
// 실행으로 보고되므로, 셸 관례대로 128+signal로 옮긴다.
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 128 + (os.constants.signals[signal] ?? 0) : code ?? 0;
});

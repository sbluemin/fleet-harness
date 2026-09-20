import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const NODE_MODULES_DIR = path.join(PKG_ROOT, "node_modules");

if (process.platform === "darwin" && existsSync(NODE_MODULES_DIR)) {
  for (const filePath of findSpawnHelpers(NODE_MODULES_DIR)) {
    const mode = statSync(filePath).mode;
    chmodSync(filePath, mode | 0o755);
  }
}

// 설치 끝에 콘솔 서버를 다시 세우고 그 주소를 출력한다. 브라우저는 열지 않는다 —
// 어디로 갈지는 주소를 읽은 사용자가 정한다. 이 기동은 "데스크탑에서 글로벌 설치"라는
// 의도에서만 동작하며, 일반 dependency 설치와 CI/비대화형 환경에서는 건너뛴다.
const env = process.env;
const isCI = Boolean(
  env.CI ||
  env.CONTINUOUS_INTEGRATION ||
  env.BUILD_ID ||
  env.GITHUB_ACTIONS,
);
// FLEET_CONSOLE_NO_AUTO_OPEN은 자동 열기를 끄려고 설정해 둔 사람들의 손에 이미 있다.
// 브라우저를 여는 동작은 사라졌지만, 그 뜻("설치가 알아서 뭔가 띄우지 않게 하라")은 그대로
// 받아 준다. 새 이름이 이 동작을 정확히 부른다.
const optedOut = Boolean(env.FLEET_CONSOLE_NO_AUTO_START || env.FLEET_CONSOLE_NO_AUTO_OPEN);
// npm 글로벌 설치만 대상으로 삼아 일반 dependency 설치의 부작용을 막는다.
const isGlobalInstall = env.npm_config_global === "true" || env.npm_config_location === "global";
const shouldAutoStart = !isCI && !optedOut && isGlobalInstall;

if (shouldAutoStart) {
  const cliPath = path.join(PKG_ROOT, "dist", "cli.mjs");
  if (existsSync(cliPath)) {
    // 편의 기능이므로 실패가 설치를 막지 않도록 best-effort로 실행한다(60초 안전 타임아웃).
    try {
      spawnSync(process.execPath, [cliPath], { stdio: "inherit", timeout: 60_000 });
    } catch {
      // 자동 기동 실패는 무시한다 — 설치 자체는 성공으로 둔다.
    }
  }
}

function findSpawnHelpers(dir) {
  const matches = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findSpawnHelpers(entryPath));
    } else if (entry.isFile() && isNodePtySpawnHelper(entryPath)) {
      matches.push(entryPath);
    }
  }
  return matches;
}

function isNodePtySpawnHelper(filePath) {
  const segments = filePath.split(path.sep);
  return (
    segments.at(-1) === "spawn-helper" &&
    segments.at(-3) === "prebuilds" &&
    segments.at(-2)?.startsWith("darwin-") === true &&
    segments.includes("node-pty")
  );
}

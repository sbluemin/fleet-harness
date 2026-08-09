// Agent CLI 가용성 탐지 서비스(서버 전용).
//
// 크로스플랫폼 정공법: 바이너리 해석은 core-agent의 resolvePathBinary(PATH/PATHEXT 탐색 +
// Windows `.cmd`/`.bat` shim을 `cmd.exe /d /s /c call`로 래핑)에 위임한다. 이렇게 하면 *nix의
// 실행 파일/심볼릭링크와 Windows의 npm `.cmd` shim을 동일한 SSoT로 처리해 `--version` 실행이
// 양 플랫폼에서 모두 성공한다. 해석 결과의 prefixArgs를 `--version` 앞에 붙여 호출하므로
// Windows shim 래핑이 버전 조회에도 그대로 적용된다. 표시 대상은 이 플러그인이 띄우는 바이너리(claude)다.

import { execFile } from "node:child_process";

import type { ResolvedBinary } from "@dotobokuri/core-process";
import { withHidden } from "@dotobokuri/core-process";

import type { AgentCliStatus } from "./agent-cli-types.js";
import { AGENT_CLI_COMMANDS, resolveAgentCliBinary, validateUserAgentCliPath, type AgentCliBinaryResolution, type AgentCliPathError } from "./agent-cli-paths.js";

export interface AgentCliDetectorDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly readUserPaths?: () => Promise<Readonly<Record<string, string>>>;
  readonly resolve?: (
    command: string,
    userPaths: Readonly<Record<string, string>>,
  ) => AgentCliBinaryResolution | ResolvedBinary | undefined;
  // 주어진 바이너리/인자로 프로세스를 실행해 stdout(또는 stderr)을 반환한다. 실패 시 throw.
  readonly runVersion: (bin: string, args: readonly string[]) => Promise<string>;
}

export interface AgentCliDetector {
  readonly detect: () => Promise<readonly AgentCliStatus[]>;
}

// cliCommand → 바이너리 표시명. provider 변형(zai/kimi/glm)이 아닌 바이너리 정체성을 담백하게 표기한다.
const BINARY_DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude Code",
};

// `--version` 실행 타임아웃(ms). 미설치/무응답이어도 설정 화면 로드를 막지 않도록 짧게 잡는다.
const VERSION_PROBE_TIMEOUT_MS = 5000;

// semver(예: 1.2.3) 추출용.
const SEMVER_PATTERN = /(\d+\.\d+\.\d+)/;

export function createAgentCliDetector(deps: AgentCliDetectorDeps): AgentCliDetector {
  return {
    detect: async () => {
      const commands = distinctBinaryCommands();
      const userPaths = await (deps.readUserPaths?.() ?? Promise.resolve({}));
      return Promise.all(commands.map((command) => detectOne(command, userPaths, deps)));
    },
  };
}

export function createDefaultAgentCliDetector(
  readUserPaths: () => Promise<Readonly<Record<string, string>>> = async () => ({}),
  env: NodeJS.ProcessEnv = process.env,
): AgentCliDetector {
  return createAgentCliDetector({
    env,
    readUserPaths,
    runVersion: (bin, args) => execFileVersion(bin, args),
  });
}

// 탐지 대상은 이 플러그인이 실제로 띄우는 바이너리다. 예전에는 ACP 백엔드 카탈로그를 순회해
// 같은 목록으로 좁혔지만, 그 카탈로그가 사라진 지금은 좁힐 대상이 곧 결과다.
function distinctBinaryCommands(): string[] {
  return [...new Set<string>(AGENT_CLI_COMMANDS)];
}

async function detectOne(
  command: string,
  userPaths: Readonly<Record<string, string>>,
  deps: AgentCliDetectorDeps,
): Promise<AgentCliStatus> {
  // legacy resolver의 undefined는 "미설치"라는 권위적 결과다. 새 기본 resolver로 폴백하면
  // 기존 테스트/호출자의 격리된 PATH 계약을 깨므로 resolver 존재 여부로 분기한다.
  const customResolution = deps.resolve?.(command, userPaths);
  const resolved = deps.resolve
    ? toResolvedBinary(customResolution)
    : resolveAgentCliBinary({ cliCommand: command, env: deps.env ?? process.env, userPaths }).resolved;
  const available = resolved !== undefined;
  let version: string | null = null;
  if (resolved) {
    version = await probeAgentCliVersion(resolved, deps.runVersion);
  }
  return {
    id: command,
    displayName: BINARY_DISPLAY_NAMES[command] ?? command,
    available,
    version,
  };
}

function toResolvedBinary(
  resolution: AgentCliBinaryResolution | ResolvedBinary | undefined,
): ResolvedBinary | undefined {
  if (!resolution) return undefined;
  return "resolved" in resolution ? resolution.resolved : resolution;
}

// 버전 추출은 실패해도 throw하지 않는다(가용성 표시는 유지). Token Boundary 하드룰에 따라
// `--version` 출력에는 설치 경로/사용자명이 섞일 수 있으므로, semver 패턴에 매칭된 값만 반환하고
// 매칭 실패 시 raw 출력을 흘리지 않고 null로 둔다.
export async function probeAgentCliVersion(
  resolved: ResolvedBinary,
  runVersion: AgentCliDetectorDeps["runVersion"] = execFileVersion,
): Promise<string | null> {
  try {
    const output = await runVersion(resolved.bin, [...resolved.prefixArgs, "--version"]);
    return output.match(SEMVER_PATTERN)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function validateAgentCliPathForSave(
  executablePath: string,
  env: NodeJS.ProcessEnv = process.env,
  runVersion: AgentCliDetectorDeps["runVersion"] = execFileVersion,
): Promise<{ readonly error: AgentCliPathError | null; readonly version: string | null }> {
  const resolution = validateUserAgentCliPath(executablePath, env);
  if (resolution.error || !resolution.resolved) {
    return { error: resolution.error ?? "path_not_found", version: null };
  }
  const version = await probeAgentCliVersion(resolution.resolved, runVersion);
  return version ? { error: null, version } : { error: "probe_failed", version: null };
}

function execFileVersion(bin: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      bin,
      [...args],
      withHidden({ encoding: "utf-8" as const, timeout: VERSION_PROBE_TIMEOUT_MS }),
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        // 일부 CLI는 버전을 stderr로 출력한다.
        resolve((stdout || stderr || "").trim());
      },
    );
  });
}

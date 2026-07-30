// Agent CLI 가용성 탐지 서비스(서버 전용).
//
// 크로스플랫폼 정공법: 바이너리 해석은 core-agent의 resolvePathBinary(PATH/PATHEXT 탐색 +
// Windows `.cmd`/`.bat` shim을 `cmd.exe /d /s /c call`로 래핑)에 위임한다. 이렇게 하면 *nix의
// 실행 파일/심볼릭링크와 Windows의 npm `.cmd` shim을 동일한 SSoT로 처리해 `--version` 실행이
// 양 플랫폼에서 모두 성공한다. 해석 결과의 prefixArgs를 `--version` 앞에 붙여 호출하므로
// Windows shim 래핑이 버전 조회에도 그대로 적용된다. 표시 대상은 CLI_BACKENDS를 cliCommand
// 기준으로 중복제거한 3개 바이너리(claude/codex/cursor-agent)다.

import { execFile } from "node:child_process";

import type { ResolvedBinary } from "@dotobokuri/core-agent";
import { withHidden } from "@dotobokuri/core-process";
import { CLI_BACKENDS } from "@dotobokuri/core-unified-agent";

import type { AgentCliStatus } from "./agent-cli-types.js";
import { resolveAgentCliBinary, validateUserAgentCliPath, type AgentCliBinaryResolution, type AgentCliPathError } from "./agent-cli-paths.js";

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
  codex: "Codex CLI",
  "cursor-agent": "Cursor Agent",
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

// CLI_BACKENDS를 선언 순서 그대로 cliCommand 기준 중복제거한다(claude/codex/cursor-agent).
function distinctBinaryCommands(): string[] {
  const seen = new Set<string>();
  const commands: string[] = [];
  for (const backend of Object.values(CLI_BACKENDS)) {
    if (!seen.has(backend.cliCommand)) {
      seen.add(backend.cliCommand);
      commands.push(backend.cliCommand);
    }
  }
  return commands;
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

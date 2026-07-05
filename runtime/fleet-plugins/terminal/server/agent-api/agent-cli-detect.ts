// Agent CLI 가용성 탐지 서비스(서버 전용).
//
// 크로스플랫폼 정공법: 바이너리 해석은 core-agent의 resolvePathBinary(PATH/PATHEXT 탐색 +
// Windows `.cmd`/`.bat` shim을 `cmd.exe /d /s /c call`로 래핑)에 위임한다. 이렇게 하면 *nix의
// 실행 파일/심볼릭링크와 Windows의 npm `.cmd` shim을 동일한 SSoT로 처리해 `--version` 실행이
// 양 플랫폼에서 모두 성공한다. 해석 결과의 prefixArgs를 `--version` 앞에 붙여 호출하므로
// Windows shim 래핑이 버전 조회에도 그대로 적용된다. 표시 대상은 CLI_BACKENDS를 cliCommand
// 기준으로 중복제거한 4개 바이너리(claude/codex/opencode/cursor-agent)다.

import { execFile } from "node:child_process";

import { resolvePathBinary, type ResolvedBinary } from "@dotobokuri/core-agent";
import { withHidden } from "@dotobokuri/core-process";
import { CLI_BACKENDS } from "@dotobokuri/core-unified-agent";

import type { AgentCliStatus } from "./agent-cli-types.js";

export interface AgentCliDetectorDeps {
  // PATH에서 바이너리를 해석한다. 미설치 시 undefined. (기본: resolvePathBinary + process.env)
  readonly resolve: (command: string) => ResolvedBinary | undefined;
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
  opencode: "OpenCode",
  "cursor-agent": "Cursor Agent",
};

// cliCommand → launch가 참조하는 바이너리 경로 override 환경변수(fleet-admiral resolveBinary와 동일).
// claude 계열은 CLAUDE_BIN, codex는 CODEX_BIN, cursor-agent는 CURSOR_AGENT_BIN을 쓴다. opencode는 PATH로만
// 해석한다. 이 매핑을 두지 않으면 PATH 밖 절대경로 override 사용자가 미설치로 오판돼 게이트(409)에 막힌다.
const OVERRIDE_ENV_BY_COMMAND: Record<string, string> = {
  claude: "CLAUDE_BIN",
  codex: "CODEX_BIN",
  "cursor-agent": "CURSOR_AGENT_BIN",
};

// `--version` 실행 타임아웃(ms). 미설치/무응답이어도 설정 화면 로드를 막지 않도록 짧게 잡는다.
const VERSION_PROBE_TIMEOUT_MS = 5000;

// semver(예: 1.2.3) 추출용.
const SEMVER_PATTERN = /(\d+\.\d+\.\d+)/;

export function createAgentCliDetector(deps: AgentCliDetectorDeps): AgentCliDetector {
  return {
    detect: async () => {
      const commands = distinctBinaryCommands();
      return Promise.all(commands.map((command) => detectOne(command, deps)));
    },
  };
}

export function createDefaultAgentCliDetector(): AgentCliDetector {
  return createAgentCliDetector({
    resolve: (command) => resolveCommandWithOverride(command, process.env),
    runVersion: (bin, args) => execFileVersion(bin, args),
  });
}

// launch의 resolveBinary와 동일한 우선순위(override env → PATH)로 바이너리를 해석한다. override가 설정됐지만
// 그 경로가 실재하지 않으면 undefined(미설치)로 본다 — launch도 동일 입력에서 실패하므로 게이트 판정이 일치한다.
function resolveCommandWithOverride(command: string, env: NodeJS.ProcessEnv): ResolvedBinary | undefined {
  const overrideName = OVERRIDE_ENV_BY_COMMAND[command];
  const override = overrideName ? env[overrideName] : undefined;
  if (override && override.trim().length > 0) {
    return resolvePathBinary(override, env);
  }
  return resolvePathBinary(command, env);
}

// CLI_BACKENDS를 선언 순서 그대로 cliCommand 기준 중복제거한다(claude/codex/opencode/cursor-agent).
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

async function detectOne(command: string, deps: AgentCliDetectorDeps): Promise<AgentCliStatus> {
  const resolved = deps.resolve(command);
  const available = resolved !== undefined;
  let version: string | null = null;
  if (resolved) {
    version = await probeVersionSafe(resolved, deps);
  }
  return {
    id: command,
    displayName: BINARY_DISPLAY_NAMES[command] ?? command,
    available,
    version,
  };
}

// 버전 추출은 실패해도 throw하지 않는다(가용성 표시는 유지). Token Boundary 하드룰에 따라
// `--version` 출력에는 설치 경로/사용자명이 섞일 수 있으므로, semver 패턴에 매칭된 값만 반환하고
// 매칭 실패 시 raw 출력을 흘리지 않고 null로 둔다.
async function probeVersionSafe(resolved: ResolvedBinary, deps: AgentCliDetectorDeps): Promise<string | null> {
  try {
    const output = await deps.runVersion(resolved.bin, [...resolved.prefixArgs, "--version"]);
    return output.match(SEMVER_PATTERN)?.[1] ?? null;
  } catch {
    return null;
  }
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

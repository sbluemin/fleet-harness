// Claude Code 내장 서브에이전트 로스터 탐침(서버 전용).
//
// 내장 목록은 하드코딩하지 않는다 — Claude Code는 버전과 실행 조건에 따라 내장 Agent를
// 더하고 빼며(실측 2.1.268: `claude`, `claude-code-guide`, `Explore`, `general-purpose`,
// `Plan`, `statusline-setup`; 진입점·환경 변수·정책에 따라 달라진다), 문서화된 열거 API는 없다. 유일하게
// 안정된 표면은 `--output-format stream-json`의 첫 줄인 `system/init` 메시지의 `agents` 배열이다.
// 그래서 설치된 CLI를 격리 환경에서 잠깐 띄워 그 첫 줄만 읽고 바로 죽인다.
//
// 격리의 이유: 사용자의 Claude 홈(`CLAUDE_CONFIG_DIR`)과 프로젝트 디렉터리를 읽으면 사용자
// 정의 Agent와 플러그인 Agent가 같은 배열에 섞여 내장을 가릴 수 없다. 빈 임시 홈과 빈 임시
// cwd에서는 배열이 곧 내장 로스터다. 자격증명도 싣지 않으므로(apiKeySource: none) 죽이기 전에
// 모델 호출이 새어 나가지 않는다 — init은 첫 API 호출보다 먼저, 약 1초 안에 도착한다.

import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { withHidden, type ResolvedBinary } from "@dotobokuri/core-process";

export interface ClaudeBuiltInAgentsSnapshot {
  /** 설치된 CLI가 로스터를 알려 줬는지. false면 `agents`는 비어 있고 `error`가 사유를 든다. */
  readonly available: boolean;
  readonly agents: readonly string[];
  /** init 메시지가 말한 Claude Code 버전. */
  readonly version: string | null;
  readonly error: "cli_not_found" | "probe_failed" | null;
}

export interface ClaudeBuiltInAgentProbeDeps {
  readonly resolveBinary: () => Promise<ResolvedBinary | undefined>;
  readonly env?: NodeJS.ProcessEnv;
  /** 탐침 실행기. 테스트가 CLI 없이 init 페이로드를 흉내 낼 때 바꾼다. */
  readonly runProbe?: (resolved: ResolvedBinary, env: NodeJS.ProcessEnv) => Promise<ClaudeInitPayload>;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

export interface ClaudeInitPayload {
  readonly agents: readonly string[];
  readonly version: string | null;
}

export interface ClaudeBuiltInAgentProbe {
  /** 캐시된 로스터를 돌려준다. `refresh`면 캐시를 버리고 다시 띄운다. */
  readonly read: (options?: { readonly refresh?: boolean }) => Promise<ClaudeBuiltInAgentsSnapshot>;
}

// init 도착 상한. 콜드 스타트에서도 1~2초면 오지만, 느린 디스크의 첫 실행을 위해 여유를 둔다.
const PROBE_TIMEOUT_MS = 15_000;
// 같은 바이너리를 다시 묻기 전 유지 시간. Claude Code 업데이트는 심볼릭링크 뒤에서 바뀌어
// 경로만으로는 알 수 없으므로, 설정 화면이 이 주기마다 새 로스터를 보게 한다.
const DEFAULT_TTL_MS = 5 * 60_000;

/** 탐침 환경에서 걷어내는 키 — 자격증명과 "이미 Claude 안에 있다"는 표식. */
const STRIPPED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
] as const;

export function createClaudeBuiltInAgentProbe(deps: ClaudeBuiltInAgentProbeDeps): ClaudeBuiltInAgentProbe {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const runProbe = deps.runProbe ?? spawnInitProbe;
  let cache: { readonly bin: string; readonly at: number; readonly snapshot: ClaudeBuiltInAgentsSnapshot } | null = null;
  let inflight: Promise<ClaudeBuiltInAgentsSnapshot> | null = null;

  const probe = async (): Promise<ClaudeBuiltInAgentsSnapshot> => {
    const resolved = await deps.resolveBinary();
    if (!resolved) {
      cache = null;
      return { available: false, agents: [], version: null, error: "cli_not_found" };
    }
    if (cache && cache.bin === resolved.bin && now() - cache.at < ttlMs) return cache.snapshot;
    let snapshot: ClaudeBuiltInAgentsSnapshot;
    try {
      const payload = await runProbe(resolved, deps.env ?? process.env);
      snapshot = { available: true, agents: payload.agents, version: payload.version, error: null };
    } catch {
      snapshot = { available: false, agents: [], version: null, error: "probe_failed" };
    }
    // 실패는 캐시하지 않는다 — 다음 열람이 다시 묻는다.
    cache = snapshot.available ? { bin: resolved.bin, at: now(), snapshot } : null;
    return snapshot;
  };

  return {
    read: async (options) => {
      if (options?.refresh) cache = null;
      if (inflight) return inflight;
      inflight = probe().finally(() => { inflight = null; });
      return inflight;
    },
  };
}

// 죽인 뒤 종료를 기다리는 상한. 트리 종료가 끝나야 임시 홈을 지울 수 있다.
const PROBE_EXIT_WAIT_MS = 3_000;

/** 첫 줄만 읽고 자식 트리를 죽인 뒤 종료를 기다린다. init이 아니거나 상한 안에 오지 않으면 throw. */
async function spawnInitProbe(resolved: ResolvedBinary, baseEnv: NodeJS.ProcessEnv): Promise<ClaudeInitPayload> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "fleet-claude-agents-"));
  const configDir = path.join(scratch, "config");
  const cwd = path.join(scratch, "cwd");
  try {
    await Promise.all([mkdir(configDir), mkdir(cwd)]);
    const env = buildProbeEnv(baseEnv, configDir);
    // POSIX에서는 자식을 자기 프로세스 그룹의 리더로 세워 그룹째 죽일 수 있게 한다. Windows의
    // npm `.cmd` shim은 cmd.exe 뒤에 실제 Claude가 서므로 `child.kill()`은 래퍼만 끊는다 —
    // 그쪽은 `taskkill /T`로 트리를 끊는다(ledger CLI와 같은 패턴).
    const spawnOptions: SpawnOptions = withHidden({
      cwd,
      env,
      stdio: ["ignore", "pipe", "ignore"],
      detached: process.platform !== "win32",
    });
    const child: ChildProcess = spawn(
      resolved.bin,
      [...resolved.prefixArgs, "-p", "ping", "--output-format", "stream-json", "--verbose", "--max-turns", "1"],
      spawnOptions,
    );
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    try {
      return await new Promise<ClaudeInitPayload>((resolve, reject) => {
        const stdout = child.stdout;
        if (!stdout) {
          reject(new Error("claude probe has no stdout"));
          return;
        }
        let settled = false;
        const finish = (outcome: { readonly payload: ClaudeInitPayload } | { readonly error: Error }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if ("payload" in outcome) resolve(outcome.payload);
          else reject(outcome.error);
        };
        const timer = setTimeout(() => finish({ error: new Error("claude init timed out") }), PROBE_TIMEOUT_MS);
        child.once("error", (error: Error) => finish({ error }));
        child.once("exit", (code: number | null) => finish({ error: new Error(`claude exited before init (code ${code ?? "null"})`) }));
        const lines = readline.createInterface({ input: stdout });
        lines.on("line", (line) => {
          const payload = parseInitLine(line);
          if (payload) finish({ payload });
        });
      });
    } finally {
      terminateProbeTree(child);
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, PROBE_EXIT_WAIT_MS))]);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 자식 트리 전체를 끊는다 — 래퍼 뒤의 실제 Claude까지. 이미 끝났으면 아무것도 하지 않는다. */
function terminateProbeTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], withHidden({ shell: false }), () => {});
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * 탐침이 자칭하는 진입점. Claude Code는 `-p`(print) 런치에서 진입점이 비어 있거나 `cli`이면
 * `sdk-cli`로 바꿔 적고, `sdk-*` 진입점에서는 `claude-code-guide` 같은 대화형 전용 내장
 * Agent를 로스터에서 뺀다(실측 2.1.268). 그러면 터미널로 여는 실제 세션에는 있는 Agent가
 * 설정 화면에서 사라진다. `cli`도 `sdk-*`도 아닌 값은 그대로 남으므로, 대화형 세션과 같은
 * 로스터를 받기 위해 Fleet 고유 값을 싣는다. Chat Mode(SDK 표면)는 어차피 이 Agent를
 * 갖지 않으니, 설정 화면의 목록은 터미널 세션 기준의 상위집합이다.
 */
const PROBE_ENTRYPOINT = "fleet-roster-probe";

function buildProbeEnv(baseEnv: NodeJS.ProcessEnv, configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of STRIPPED_ENV_KEYS) delete env[key];
  env.CLAUDE_CONFIG_DIR = configDir;
  env.CLAUDE_CODE_ENTRYPOINT = PROBE_ENTRYPOINT;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

/** `system/init` 줄이면 로스터를, 아니면 null. 첫 줄 앞에 경고가 섞여도 건너뛴다. */
export function parseInitLine(line: string): ClaudeInitPayload | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { readonly type?: unknown; readonly subtype?: unknown; readonly agents?: unknown; readonly claude_code_version?: unknown };
  if (record.type !== "system" || record.subtype !== "init") return null;
  const agents = Array.isArray(record.agents)
    ? record.agents.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  return {
    agents,
    version: typeof record.claude_code_version === "string" ? record.claude_code_version : null,
  };
}

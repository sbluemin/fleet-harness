import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { withHidden, withNodeSystemCa } from "@fleet-console/process";
import { CONSOLE_SERVE_EXIT_LOCK_HELD, identifyConsoleLockOwner, type ConsoleLockHealthEvidence, type ConsoleLockOwnerIdentity } from "@fleet-console/protocol/desktop";

import type { ConsoleLockPayload } from "../transport/console-contract-types.js";
import { describeDaemonStartFailure } from "../transport/failure-notice.js";
import { createConsoleFailureLog } from "./failure-log.js";
import { createConsoleHealthClient } from "./health.js";
import { createConsoleStalePolicy } from "./stale.js";
import {
  command,
  dim,
  option,
  paintFleetHelpBanner,
  resolveColorEnabled,
  section,
  stripAnsi,
} from "../../../cli/styles/tokens.js";
import { readFleetCliRelease } from "../../../cli/release.js";
import { createConsoleLock, describeOwnerlessLock, isConsoleLockHeldError, describeReclaimResult, describeRefusedLock, describeSlotQuiescenceCheck, type ConsoleLockReclaimResult } from "./lock.js";
import { createConsoleDataPaths, createConsolePaths } from "./paths.js";
import { createConsoleServer } from "./server.js";

export type ConsoleCliMode = "start" | "stop" | "restart" | "status" | "help";

export interface ConsoleDaemonProcess {
  readonly pid?: number;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
  unref(): void;
}

export type ConsoleDaemonSpawner = (
  execPath: string,
  args: readonly string[],
  options: { readonly detached: true; readonly env: NodeJS.ProcessEnv; readonly stdio: "ignore"; readonly windowsHide: true },
) => ConsoleDaemonProcess;

export interface ConsoleDaemonLifecycleDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly serverModulePath?: string;
  /**
   * 게시된 ./cli 소비자가 쓰던 legacy seam. 반환값이 없으므로 소유 프로세스 정리는 보장하지 못하지만,
   * 기존 injector가 깨지지 않도록 유지한다. 새 테스트와 런타임 구현은 spawnDaemon을 사용한다.
   */
  readonly spawnDetached?: (
    execPath: string,
    args: readonly string[],
    options: { readonly detached: true; readonly env: NodeJS.ProcessEnv; readonly stdio: "ignore"; readonly windowsHide: true },
  ) => void;
  readonly spawnDaemon?: ConsoleDaemonSpawner;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly startupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly cleanupGraceMs?: number;
  /** SIGTERM을 받은 Console이 정리를 마칠 때까지 stop이 기다리는 한도. 이를 넘기면 정체로 보고 정체를 다시 증명한 뒤 SIGKILL한다. */
  readonly shutdownTimeoutMs?: number;
  readonly health?: ReturnType<typeof createConsoleHealthClient>;
  /** 사용자에게 알릴 한 줄(대기 안내, 강제 종료 경고). 기본은 stderr다. */
  readonly report?: (message: string) => void;
}

/** stop의 결말. forced는 정리를 끝내지 못한 Console을 SIGKILL로 내렸다는 뜻이다 — 그 Console이 띄운 자식과 임시파일이 남을 수 있다. */
export type ConsoleStopResult =
  | { readonly forced: false }
  | { readonly forced: true; readonly shutdownTimeoutMs: number };

export interface StartFleetConsoleDeps {
  readonly lifecycle?: Pick<ReturnType<typeof createConsoleDaemonLifecycle>, "ensureDaemon" | "probe">;
}

export interface StartFleetConsoleResult {
  /** 사용자가 직접 열 주소. CLI는 화면을 대신 열지 않고 이것만 건넨다. */
  readonly url: string;
}

export interface ConsoleStatusDeps {
  readonly lifecycle?: Pick<ReturnType<typeof createConsoleDaemonLifecycle>, "probe">;
}

export interface ConsoleStopDeps {
  readonly lifecycle?: Pick<ReturnType<typeof createConsoleDaemonLifecycle>, "stop">;
}

export type ConsoleHookCommand =
  | { readonly command: "capture-session"; readonly provider: "claude" }
  | { readonly command: "turn-start" }
  | { readonly command: "turn-end" }
  | { readonly command: "workspace" }
  | { readonly command: "background-report" }
  | { readonly command: "background-spawn" }
  | { readonly command: "background-stop" }
  | { readonly command: "attention" }
  | { readonly command: "auto-name" }
  | { readonly command: "agent-call" };

export interface ConsoleRestartDeps {
  readonly lifecycle?: Pick<ReturnType<typeof createConsoleDaemonLifecycle>, "stop" | "ensureDaemon" | "probe">;
  readonly report?: (message: string) => void;
}

export interface BuildConsoleHelpTextOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly release?: string;
}

const FIXED_HOST = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 60_000;
const STARTUP_POLL_INTERVAL_MS = 100;
const CHILD_CLEANUP_GRACE_MS = 500;
// stop이 lock pid의 정체를 health로 확인하는 전체 예산. 정상 Console은 수 ms 안에 답한다.
const STOP_IDENTITY_TIMEOUT_MS = 5_000;
// lock 주소는 거절되는데 lock pid가 살아 있을 때 pid 종료나 lock 해제를 기다리는 한도. 종료 중인 Console은 listener를
// 먼저 닫고 정리를 마친 뒤 lock을 놓는다. 그 사이를 stale로 보면 살아 있는 Console 옆에 두 번째 Console이 뜬다.
const STOP_SETTLE_ATTEMPTS = 20;
const STOP_SETTLE_POLL_MS = 50;
// SIGTERM 뒤 Console이 정리를 마치고 lock을 스스로 놓기까지 기다리는 한도. 정상 정리 실측: 유휴 수십 ms, 열린 chat 턴 약 2s
// (SDK가 stdin을 닫고 2s 뒤 자식에 SIGTERM — chat이 여럿이어도 병렬이다), SIGTERM을 무시하는 자식이면 SDK의 SIGKILL까지 약 7s.
// 그 위에 plugin·MCP 정리와 느린 기계의 여유를 더했다. Desktop의 SHUTDOWN_SETTLE_MS와 같은 값이다. 이보다 짧으면 진행 중인
// 정리를 끊어 SDK 자식과 그 MCP 자식을 고아로, launch 임시파일을 잔재로 남긴다.
const STOP_SHUTDOWN_TIMEOUT_MS = 10_000;
// 정리가 이만큼 길어지면 사용자에게 기다리는 중이라고 한 번 알린다.
const STOP_SHUTDOWN_NOTICE_MS = 1_000;
const STOP_SIGKILL_EXIT_ATTEMPTS = 20;
// `ps -o lstart`는 초 단위로 내림한 값이다. Linux는 boot time 반올림으로 1초 더 어긋날 수 있다. 시작 시각이 정체 증명
// 시점보다 이 값 이상 앞서야 그 시각을 정체 표지로 쓴다.
const PROCESS_START_MARGIN_MS = 2_000;
// Console은 listen 뒤에 lock을 쓰므로 lock 작성자의 시작 시각은 항상 lock.startedAt보다 앞선다. lock pid의 시작 시각이
// startedAt보다 이 값 이상 늦으면 그 pid는 작성자가 죽은 뒤 재할당된 것이다. 1초는 lstart 내림과 Linux boot time 반올림을
// 덮는다. 나머지는 Linux에서 Console 시작 뒤 벽시계가 앞으로 step하면 그만큼 같은 Console의 lstart도 밀리는 경우를 덮는다.
// 크래시 뒤 재부팅이나 수 초 이상 지난 재할당은 이 한도를 넉넉히 넘는다.
const LOCK_AUTHOR_REPLACED_MARGIN_MS = 10_000;

type ConsoleDaemonChildFailure =
  | { readonly kind: "error"; readonly detail: string }
  | { readonly kind: "exit"; readonly detail: string };

interface ConsoleDaemonChildObservation {
  failure: ConsoleDaemonChildFailure | null;
  exited: boolean;
  readonly failurePromise: Promise<ConsoleDaemonChildFailure>;
  readonly exitPromise: Promise<void>;
}

// background-spawn/background-stop은 더 이상 렌더되지 않지만, 업그레이드 시점에 이미 살아 있는 세션의
// hooks.json이 여전히 그 이름으로 이 실행 파일을 호출한다(경로가 제자리 덮어써지므로 구 세션이 새 바이너리를 부른다).
// 이름을 지우면 in-flight 세션의 hook이 예외로 죽으므로 계속 받아주고, 본문도 퇴역 당시 형식을 그대로 보낸다.
const CONSOLE_HOOK_COMMANDS = new Set(["capture-session", "turn-start", "turn-end", "workspace", "background-report", "background-spawn", "background-stop", "attention", "auto-name", "agent-call"]);

export function parseConsoleCliMode(argv: readonly string[]): ConsoleCliMode {
  // 인자가 없으면 기본 동작은 start(서버를 보장하고 그 주소를 출력한다)다.
  if (argv.length === 0) return "start";
  const [first, ...rest] = argv;
  if (first === "--help" || first === "-h") return "help";

  let mode: ConsoleCliMode;
  if (first === "start") {
    mode = "start";
  } else if (first === "stop") {
    mode = "stop";
  } else if (first === "restart") {
    mode = "restart";
  } else if (first === "status") {
    mode = "status";
  } else {
    throw new Error(`Unknown fleet console command: ${first}\nRun 'fleet console --help' for usage.`);
  }

  for (const arg of rest) {
    if (arg === "--help" || arg === "-h") return "help";
    throw new Error(`Unknown fleet console option: ${arg}\nRun 'fleet console --help' for usage.`);
  }
  return mode;
}

export function parseConsoleHookCommand(argv: readonly string[]): ConsoleHookCommand {
  const [commandName, ...rest] = argv;
  if (!commandName || !CONSOLE_HOOK_COMMANDS.has(commandName)) {
    throw new Error("Unknown fleet-console hook command");
  }
  if (commandName === "turn-start" && rest.length === 0) return { command: "turn-start" };
  if (commandName === "turn-end" && rest.length === 0) return { command: "turn-end" };
  if (commandName === "workspace" && rest.length === 0) return { command: "workspace" };
  if (commandName === "background-report" && rest.length === 0) return { command: "background-report" };
  if (commandName === "background-spawn" && rest.length === 0) return { command: "background-spawn" };
  if (commandName === "background-stop" && rest.length === 0) return { command: "background-stop" };
  if (commandName === "attention" && rest.length === 0) return { command: "attention" };
  if (commandName === "auto-name" && rest.length === 0) return { command: "auto-name" };
  if (commandName === "agent-call" && rest.length === 0) return { command: "agent-call" };
  if (commandName === "capture-session" && rest.length === 1 && rest[0] === "claude") return { command: "capture-session", provider: rest[0] };
  throw new Error("Unknown fleet-console hook command");
}

export function buildConsoleHelpText(options: BuildConsoleHelpTextOptions = {}): string {
  const colorEnabled = resolveColorEnabled(options);
  const release = options.release ?? formatConsoleHelpRelease();
  const subtitle = `Fleet Console · ${release}`;
  const lines = [
    ...paintFleetHelpBanner(colorEnabled),
    dim(subtitle, colorEnabled),
    "",
    dim("Observe live output streams and console-owned terminal sessions.", colorEnabled),
    "",
    section("USAGE", colorEnabled),
    `  ${command("fleet console", colorEnabled)} ${dim("[start|stop|restart|status] [--help]", colorEnabled)}`,
    `  ${command("fleet-console", colorEnabled)} ${dim("[start|stop|restart|status] [--help]", colorEnabled)}`,
    "",
    section("COMMANDS", colorEnabled),
    `  ${command("start", colorEnabled)}   ${dim("Ensure the local Fleet Console server and print its address. (default)", colorEnabled)}`,
    `  ${command("stop", colorEnabled)}    ${dim("Stop the local Fleet Console server.", colorEnabled)}`,
    `  ${command("restart", colorEnabled)} ${dim("Restart the local Fleet Console server and print its address.", colorEnabled)}`,
    `  ${command("status", colorEnabled)}  ${dim("Show the local Fleet Console server status.", colorEnabled)}`,
    "",
    section("OPTIONS", colorEnabled),
    `  ${option("--help, -h", colorEnabled)}  ${dim("Show this help message and exit.", colorEnabled)}`,
    "",
    section("EXAMPLES", colorEnabled),
    `  ${command("fleet console", colorEnabled)}`,
    `  ${command("fleet console status", colorEnabled)}`,
    `  ${command("fleet console restart", colorEnabled)}`,
    `  ${command("fleet console stop", colorEnabled)}`,
    `  ${command("fleet-console", colorEnabled)} ${dim("(transitional)", colorEnabled)}`,
    "",
  ];
  const text = lines.join("\n");
  return colorEnabled ? text : stripAnsi(text);
}

function formatConsoleHelpRelease(): string {
  const release = readFleetCliRelease();
  return `${release.version} · ${release.channel}`;
}

export function createConsoleDaemonLifecycle(deps: ConsoleDaemonLifecycleDeps = {}) {
  const env = deps.env ?? process.env;
  // TLS 검사 프록시 환경 대응(issue #531): OS 신뢰 저장소를 기본 신뢰한다. opt-out은 FLEET_CONSOLE_NO_SYSTEM_CA=1.
  const childEnv = env.FLEET_CONSOLE_NO_SYSTEM_CA === "1" ? env : withNodeSystemCa(env);
  const execPath = deps.execPath ?? process.execPath;
  const serverModulePath = deps.serverModulePath ?? resolveDefaultServerModulePath();
  const spawnDaemon = deps.spawnDaemon ?? ((bin, args, options) => spawn(bin, [...args], options));
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => performance.now());
  const startupTimeoutMs = Math.max(0, deps.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, deps.pollIntervalMs ?? STARTUP_POLL_INTERVAL_MS);
  const cleanupGraceMs = Math.max(0, deps.cleanupGraceMs ?? CHILD_CLEANUP_GRACE_MS);
  const shutdownTimeoutMs = Math.max(0, deps.shutdownTimeoutMs ?? STOP_SHUTDOWN_TIMEOUT_MS);
  const report = deps.report ?? reportToStderr;
  const paths = createConsolePaths({ env });
  const lock = createConsoleLock({ report });
  const health = deps.health ?? createConsoleHealthClient();
  const stale = createConsoleStalePolicy();

  async function runServer(): Promise<void> {
    let recordFailure: (kind: string, error: unknown) => void = (kind, error) => {
      try { process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), kind, message: String(error), stack: null })}\n`); } catch { /* No diagnostic channel remains. */ }
    };
    try { recordFailure = createConsoleFailureLog(createConsoleDataPaths({ env }).dir); }
    catch { /* Diagnostics setup cannot prevent Console startup. */ }
    const onRejection = (error: unknown) => recordFailure("unhandledRejection", error);
    const onException = (error: Error) => {
      recordFailure("uncaughtException", error);
      process.exit(1);
    };
    // Only the Console serve process owns global policy; a failed registration must not block boot.
    try {
      process.on("unhandledRejection", onRejection);
      process.on("uncaughtException", onException);
    } catch (error) { recordFailure("handler_install_failed", error); }
    try {
      const server = createConsoleServer();
      let startupSettled = false;
      let settleStartup!: () => void;
      const startup = new Promise<void>((resolve) => { settleStartup = resolve; });
      let startupShutdownTimeout: ReturnType<typeof setTimeout> | undefined;
      // lock 공개 전부터 신호를 받되, 시작 작업과 정리를 겹치지 않는다 — 아직 쓰는 중인 writer의 lock을 먼저 풀면 안 된다.
      // 정리는 첫 SIGTERM·SIGINT에서 한 번만 시작하고, 정리가 끝날 때까지 뒤따르는 신호도 받는다.
      let stopping = false;
      let stopped!: () => void;
      const done = new Promise<void>((resolve) => { stopped = resolve; });
      const shutdown = () => {
        if (stopping) return;
        stopping = true;
        if (!startupSettled) {
          // 시작 자체가 멈춰도 SIGTERM을 무한히 붙잡지 않는다. 상한 뒤 남은 lock은 다음 Console의 ESRCH 회수에 맡긴다.
          startupShutdownTimeout = setTimeout(() => {
            recordFailure("startup_shutdown_timeout", new Error(`Console startup shutdown did not finish within ${shutdownTimeoutMs}ms`));
            process.exit(1);
          }, shutdownTimeoutMs);
        }
        void startup.then(() => server.stop()).catch((error) => {
          recordFailure("shutdown_failed", error);
          process.exitCode = 1;
        }).finally(stopped);
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
      try {
        try { await server.start(paths); }
        finally { startupSettled = true; settleStartup(); }
        await done;
      } finally {
        if (stopping) await done;
        if (startupShutdownTimeout !== undefined) clearTimeout(startupShutdownTimeout);
        process.removeListener("SIGTERM", shutdown);
        process.removeListener("SIGINT", shutdown);
      }
    } finally {
      process.removeListener("unhandledRejection", onRejection);
      process.removeListener("uncaughtException", onException);
    }
  }

  async function probe(timeoutMs?: number, signal?: AbortSignal) {
    const payload = readTrustedLock();
    const probeResult = await health.probe(payload, {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    });
    return { ...probeResult, buildStale: payload ? stale.isBuildStale(payload, serverModulePath) : false };
  }

  async function stop(): Promise<ConsoleStopResult> {
    const payload = readTrustedLock();
    if (!payload) return { forced: false };
    // 정체 증명(health 요청)보다 먼저 잰 벽시계 시각. 이보다 먼저 시작한 프로세스만 증명된 Console과 같은 프로세스일 수 있다.
    const identityProbedAt = Date.now();
    const owner = await identifyLockOwner(payload);
    if (owner === "unverified") {
      // 살아 있는 무언가가 lock을 붙잡고 있지만 lock token으로 정체를 증명하지 못했다(멈춘 Console이거나
      // 종료 중인 Console일 수 있다). 시그널은 무관한 프로세스를 죽일 수 있고, lock을 지우면 살아 있는
      // Console 옆에 두 번째 소유자가 생길 수 있으므로 둘 다 하지 않는다.
      throw lockOwnerUnverifiedError(payload);
    }
    if (owner === "verified") {
      assertCliCanControlDaemon(payload);
      const provenStart = await captureProvenProcessStart(payload.pid, identityProbedAt);
      signalLockProcess(payload.pid, "SIGTERM");
      // 정상 종료한 Console은 정리를 모두 마친 뒤에야 lock을 스스로 지운다. 그 정리가 끝나거나 한도를 넘을 때까지 기다린다.
      // 한도를 넘겨 lock이 남아 있으면 정리가 멈춘 것일 수도, Console이 lock을 남긴 채 죽고 pid가 재할당된 것일 수도 있다.
      // lock 파일이 그대로라는 사실은 증명이 아니므로 SIGKILL 직전에 정체를 다시 증명한다.
      if (!await waitForShutdown(payload) && await escalateStalledShutdown(payload, provenStart)) {
        await removeLockHeldBy(payload);
        return { forced: true, shutdownTimeoutMs };
      }
    }
    // 여기까지 온 lock은 pid가 끝났거나(ESRCH) 주인이 lock을 이미 놓은 것이다. 신호 없이
    // 같은 pid·token의 lock일 때만 지운다.
    await removeLockHeldBy(payload);
    return { forced: false };
  }

  /** SIGTERM을 보낸 Console이 끝나거나 lock을 놓을 때까지 기다린다. 한도 안에 둘 중 하나가 일어나면 참이다. */
  async function waitForShutdown(payload: ConsoleLockPayload): Promise<boolean> {
    const attempts = Math.ceil(shutdownTimeoutMs / STOP_SETTLE_POLL_MS);
    const noticeAttempt = Math.ceil(STOP_SHUTDOWN_NOTICE_MS / STOP_SETTLE_POLL_MS);
    for (let attempt = 0; ; attempt += 1) {
      // A lock that cannot be read is still held: only an exited pid or a lock that is gone or replaced ends the wait.
      if (!isLockProcessAlive(payload.pid) || isLockReleasedBy(payload)) return true;
      if (attempt >= attempts) return false;
      if (attempt === noticeAttempt) report("Waiting for Fleet Console to finish shutting down...");
      await sleep(STOP_SETTLE_POLL_MS);
    }
  }

  /**
   * SIGTERM 뒤에도 lock을 놓지 않은 pid를 SIGKILL로 정리한다. 그 pid는 SIGTERM 전에 health로 정체가 증명됐으므로,
   * 지금도 같은 프로세스라는 것만 보이면 된다. 증명 전에 시작한 프로세스의 시작 시각이 그대로면 같은 프로세스다 —
   * 그 사이 pid가 재할당됐다면 새 프로세스는 증명 뒤에 시작했으므로 시작 시각이 다르다. 시작 시각을 얻지 못하거나
   * 달라졌으면 health 정체 판별로 돌아간다. 어느 경우에도 살아 있는 pid의 lock만 지우고 성공으로 끝내지 않는다.
   * SIGKILL로 내렸으면 참, 그 전에 pid가 끝났거나 lock이 풀려 신호 없이 끝났으면 거짓이다.
   */
  async function escalateStalledShutdown(payload: ConsoleLockPayload, provenStart: number | null): Promise<boolean> {
    let proven = false;
    if (provenStart !== null) {
      // SIGKILL 직전 재관측: 시작 시각과 lock 소유를 다시 읽는다.
      const currentStart = await readProcessStartTime(payload.pid, env);
      if (currentStart === null && !isLockProcessAlive(payload.pid)) return false;
      proven = currentStart === provenStart && isLockStillHeldBy(payload);
    }
    if (!proven) {
      const survivor = await identifyLockOwner(payload);
      if (survivor === "unverified") throw lockOwnerUnverifiedError(payload);
      if (survivor === "absent") return false;
    }
    signalLockProcess(payload.pid, "SIGKILL");
    // 마지막 대기 뒤에도 한 번 더 확인한다. 그 사이 끝난 pid를 살아 있다고 보고 lock을 남기지 않는다.
    for (let attempt = 0; ; attempt += 1) {
      if (!isLockProcessAlive(payload.pid)) return true;
      if (attempt >= STOP_SIGKILL_EXIT_ATTEMPTS) break;
      await sleep(STOP_SETTLE_POLL_MS);
    }
    throw new Error(`Fleet Console pid ${payload.pid} did not exit after SIGKILL; ${paths.lockFile} was left in place.`);
  }

  /** 정체 증명 시각보다 충분히 앞서 시작한 프로세스의 시작 시각만 돌려준다. 그렇지 않으면 정체 표지로 쓰지 않는다. */
  async function captureProvenProcessStart(pid: number, provenAt: number): Promise<number | null> {
    const startedAt = await readProcessStartTime(pid, env);
    return startedAt !== null && startedAt + PROCESS_START_MARGIN_MS <= provenAt ? startedAt : null;
  }

  /** stop이 lock pid에 시그널을 보내도 되는지 판별한다. lock token을 인증한 health 응답만 정체 증명이다. */
  async function identifyLockOwner(payload: ConsoleLockPayload): Promise<ConsoleLockOwnerIdentity> {
    if (!isLockProcessAlive(payload.pid)) return "absent";
    // No Fleet Console writes a tokenless lock, and a live pid behind one cannot prove anything: never signal it or clear its lock.
    if (typeof payload.token !== "string" || payload.token.length === 0) return "unverified";
    const result = await health.probe(payload, { timeoutMs: STOP_IDENTITY_TIMEOUT_MS });
    const evidence: ConsoleLockHealthEvidence = result.healthy ? { kind: "answered", pid: result.health?.pid } : result.refused ? { kind: "refused" } : { kind: "unanswered" };
    // 거절된 lock 주소는 stale lock일 수도, listener를 닫고 정리 중이거나 그 도중 멈춘 Console일 수도 있다. pid가 lock을 쓴 뒤에
    // 시작한 프로세스면(크래시 뒤 pid 재할당) 작성자는 이미 끝났다. 그렇지 않으면 pid가 끝나거나 lock이 풀릴 때만 stale로 본다.
    // 한도 안에 둘 다 일어나지 않으면 정체를 증명하지 못한 것으로 다룬다.
    if (evidence.kind === "refused" && !await isLockAuthorReplaced(payload) && !await waitForRefusedOwnerToSettle(payload)) return "unverified";
    return identifyConsoleLockOwner({ lockPid: payload.pid, pidAlive: true, health: evidence });
  }

  /** lock pid의 현재 프로세스가 lock 작성 뒤에 시작했는가. 작성자가 끝났다는 사실은 되돌아가지 않으므로 이 증거는 낡지 않는다. */
  async function isLockAuthorReplaced(payload: ConsoleLockPayload): Promise<boolean> {
    if (!Number.isFinite(payload.startedAt)) return false;
    const startedAt = await readProcessStartTime(payload.pid, env);
    return startedAt !== null && startedAt > payload.startedAt + LOCK_AUTHOR_REPLACED_MARGIN_MS;
  }

  async function waitForRefusedOwnerToSettle(payload: ConsoleLockPayload): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      if (!isLockProcessAlive(payload.pid) || isLockReleasedBy(payload)) return true;
      if (attempt >= STOP_SETTLE_ATTEMPTS) return false;
      await sleep(STOP_SETTLE_POLL_MS);
    }
  }

  function lockOwnerUnverifiedError(payload: ConsoleLockPayload): Error {
    return new Error([
      `Fleet Console lock pid ${payload.pid} is alive but did not prove it owns ${paths.lockFile}, so it was not signalled.`,
      `If that process is a stuck Fleet Console, stop it (kill -TERM ${payload.pid}; Windows: Stop-Process -Id ${payload.pid}), then run fleet console start. A suspended process (state T in ps) ignores TERM until resumed: kill -CONT ${payload.pid} lets it finish shutting down, or kill -KILL ${payload.pid} ends it.`,
      `If it is not a Fleet Console, follow the check below and then delete ${paths.lockFile}.`,
      describeSlotQuiescenceCheck(paths.lockFile),
    ].join("\n"));
  }

  /** lock이 없어졌거나 다른 주인의 것으로 바뀌었다. 읽지 못하면 풀렸다고 보지 않는다. */
  function isLockReleasedBy(payload: ConsoleLockPayload): boolean {
    try {
      const current = lock.readLock(paths.lockFile);
      return current?.pid !== payload.pid || current.token !== payload.token;
    } catch {
      return false;
    }
  }

  /**
   * Clears the lock stop already judged, only while it is still that instance (same pid and token). The earlier checks
   * decide signalling and waiting; the deletion itself goes through the reclaim protocol, which requires ESRCH now.
   */
  async function removeLockHeldBy(payload: ConsoleLockPayload): Promise<void> {
    const observed = lock.observeLock(paths.lockFile);
    if (observed.kind === "absent") return;
    if (observed.kind === "refused") throw new Error(describeRefusedLock(paths.lockFile, observed.reason));
    if (observed.kind === "unknown") throw new Error(describeOwnerlessLock(paths.lockFile, observed.reason));
    const held = observed.instance.payload;
    if (held.pid !== payload.pid || held.token !== payload.token) return;
    const result = await lock.reclaimLock(paths.lockFile, observed.instance);
    if (result.kind === "removed" || result.kind === "gone") return;
    if (result.kind === "alive") throw lockOwnerUnverifiedError(payload);
    throw new Error(describeReclaimResult(paths.lockFile, result));
  }

  function isLockStillHeldBy(payload: ConsoleLockPayload): boolean {
    try {
      const current = lock.readLock(paths.lockFile);
      return current?.pid === payload.pid && current.token === payload.token;
    } catch {
      return false;
    }
  }

  function signalLockProcess(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
  }

  /**
   * Decides from the lock whether start may proceed; it never deletes. A trusted lock with a token keeps the probe → stop
   * flow. An untrusted or tokenless lock is refused while its pid lives, and left for the new Console to reclaim once its
   * pid is ESRCH. A lock without a readable owner, a symlink, or another user's lock is refused.
   */
  async function readLockForStart(): Promise<ConsoleLockPayload | null> {
    const observed = await lock.observeLockWithin(paths.lockFile);
    if (observed.kind === "absent") return null;
    if (observed.kind === "refused") throw new Error(describeRefusedLock(paths.lockFile, observed.reason));
    if (observed.kind === "unknown") throw new Error(describeOwnerlessLock(paths.lockFile, observed.reason));
    if (observed.untrusted === null) return observed.instance.payload;
    if (observed.alive) throw new Error(describeUntrustedLiveLock(observed.instance.pid, observed.untrusted));
    report(`Fleet Console lock ${paths.lockFile} belongs to pid ${observed.instance.pid}, which is no longer running; the new Console will reclaim it.`);
    return null;
  }

  function describeUntrustedLiveLock(pid: number, issue: string): string {
    return [
      `Fleet Console lock pid ${pid} is alive but its lock ${paths.lockFile} cannot be trusted (${issue}), so no second Console was started.`,
      `If that process is a Fleet Console, stop it (kill -TERM ${pid}; Windows: Stop-Process -Id ${pid}; or quit the Fleet desktop app that owns it), then start again — the lock of an exited Console is reclaimed automatically.`,
      `If it is not a Fleet Console, follow the check below and then delete ${paths.lockFile}.`,
      describeSlotQuiescenceCheck(paths.lockFile),
    ].join("\n");
  }

  async function ensureDaemon(): Promise<string> {
    let current = await readLockForStart();
    let probeResult = await health.probe(current);
    const startingDeadline = now() + startupTimeoutMs;
    // 다른 호스트가 이미 lock을 얻고 복원 중이면 건드리지 않는다. lock 교체도 대기 예산을 늘리지 않는다.
    while (current && probeResult.starting && isLockProcessAlive(current.pid)) {
      const remaining = startingDeadline - now();
      if (remaining <= 0) throw lockOwnerUnverifiedError(current);
      await sleep(Math.min(pollIntervalMs, remaining));
      current = await readLockForStart();
      probeResult = await health.probe(current, { timeoutMs: Math.max(0, startingDeadline - now()) });
      // 마지막 probe의 예산 소진을 기존 unhealthy→stop 경로로 바꾸지 않는다.
      if (!probeResult.healthy && now() >= startingDeadline && current && isLockProcessAlive(current.pid)) throw lockOwnerUnverifiedError(current);
    }
    const isBuildStale = current ? stale.isBuildStale(current, serverModulePath) : false;
    if (probeResult.healthy && current) {
      if (!isBuildStale) return current.endpoint;
      if (typeof probeResult.health?.workspaceCount === "number" && probeResult.health.workspaceCount > 0) return current.endpoint;
    }
    if (current) {
      const stopped = await stop();
      if (stopped.forced) report(describeForcedStop(stopped.shutdownTimeoutMs));
    }

    let child: ConsoleDaemonProcess | null;
    try {
      const spawnOptions = withHidden({ detached: true as const, env: childEnv, stdio: "ignore" as const });
      if (deps.spawnDaemon) {
        child = deps.spawnDaemon(execPath, [serverModulePath, "serve"], spawnOptions);
      } else if (deps.spawnDetached) {
        deps.spawnDetached(execPath, [serverModulePath, "serve"], spawnOptions);
        child = null;
      } else {
        child = spawnDaemon(execPath, [serverModulePath, "serve"], spawnOptions);
      }
    } catch (error) {
      throw new Error(describeDaemonStartFailure({
        spawnError: describeUnknownError(error),
        childError: null,
        readinessError: null,
        probeError: null,
        cleanupError: null,
        healthyEndpoint: null,
        dataDir: paths.dir,
        startupTimeoutMs,
      }));
    }

    const observation = child ? observeChild(child) : createUnobservedChild();
    const readinessController = new AbortController();
    void observation.failurePromise.then(() => readinessController.abort());
    const deadline = now() + startupTimeoutMs;
    let lastProbeError: string | null = null;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      child?.unref();
    };

    try {
      while (now() < deadline && !observation.failure) {
        const remainingBeforeSleep = deadline - now();
        const failure = await Promise.race([
          sleep(Math.min(pollIntervalMs, remainingBeforeSleep)).then(() => null),
          observation.failurePromise,
        ]);
        if (failure) break;
        const remaining = deadline - now();
        if (remaining <= 0) break;
        let next: Awaited<ReturnType<typeof probe>>;
        try {
          next = await probe(remaining, readinessController.signal);
        } catch (error) {
          // A read error while the child starts (a lock published in place on a volume without hard links can be briefly
          // empty, or a lock another start left for the child to reclaim is untrusted) must not remove that lock or kill
          // the child. Check again within the deadline.
          lastProbeError = describeUnknownError(error);
          continue;
        }
        if (next.healthy && next.lock) {
          if (observation.failure && next.lock.pid === child?.pid) break;
          if (child?.pid !== undefined && next.lock.pid === child.pid) {
            release();
            return next.lock.endpoint;
          }
          const cleanupError = await cleanupOwnedChild(child, observation);
          release();
          if (!cleanupError) return next.lock.endpoint;
          throw new Error(describeDaemonStartFailure({
            spawnError: null,
            childError: null,
            readinessError: null,
            probeError: null,
            cleanupError,
            healthyEndpoint: next.lock.endpoint,
            dataDir: paths.dir,
            startupTimeoutMs,
          }));
        }
        if (next.error) lastProbeError = next.error;
      }

      // 자식이 먼저 끝난 경우 남은 예산 안에서 concurrent healthy owner를 한 번 더 확인한다.
      const finalRemaining = deadline - now();
      let finalProbe: Awaited<ReturnType<typeof probe>> | null = null;
      if (finalRemaining > 0) {
        try {
          finalProbe = await probe(finalRemaining);
        } catch (error) {
          lastProbeError = describeUnknownError(error);
        }
      }
      if (finalProbe?.healthy && finalProbe.lock && finalProbe.lock.pid !== child?.pid) {
        const cleanupError = await cleanupOwnedChild(child, observation);
        release();
        if (!cleanupError) return finalProbe.lock.endpoint;
        throw new Error(describeDaemonStartFailure({
          spawnError: null,
          childError: null,
          readinessError: null,
          probeError: null,
          cleanupError,
          healthyEndpoint: finalProbe.lock.endpoint,
          dataDir: paths.dir,
          startupTimeoutMs,
        }));
      }
      if (finalProbe?.error) lastProbeError = finalProbe.error;

      const startupFailure = observation.failure;
      const cleanupError = await cleanupOwnedChild(child, observation);
      release();
      throw new Error(describeDaemonStartFailure({
        spawnError: startupFailure?.kind === "error" ? startupFailure.detail : null,
        childError: startupFailure?.kind === "exit" ? startupFailure.detail : null,
        readinessError: null,
        probeError: lastProbeError,
        cleanupError,
        healthyEndpoint: null,
        dataDir: paths.dir,
        startupTimeoutMs,
      }));
    } catch (error) {
      if (released) throw error;
      const startupFailure = observation.failure;
      readinessController.abort();
      let cleanupError: string | null;
      try {
        cleanupError = await cleanupOwnedChild(child, observation);
      } catch (cleanupFailure) {
        cleanupError = describeUnknownError(cleanupFailure);
      } finally {
        release();
      }
      throw new Error(describeDaemonStartFailure({
        spawnError: startupFailure?.kind === "error" ? startupFailure.detail : null,
        childError: startupFailure?.kind === "exit" ? startupFailure.detail : null,
        readinessError: describeUnknownError(error),
        probeError: lastProbeError,
        cleanupError,
        healthyEndpoint: null,
        dataDir: paths.dir,
        startupTimeoutMs,
      }));
    }
  }

  return { ensureDaemon, probe, runServer, stop };

  function observeChild(child: ConsoleDaemonProcess): ConsoleDaemonChildObservation {
    let resolveFailure!: (failure: ConsoleDaemonChildFailure) => void;
    let resolveExit!: () => void;
    const observation: ConsoleDaemonChildObservation = {
      failure: null,
      exited: false,
      failurePromise: new Promise<ConsoleDaemonChildFailure>((resolve) => { resolveFailure = resolve; }),
      exitPromise: new Promise<void>((resolve) => { resolveExit = resolve; }),
    };
    child.once("error", (error) => {
      if (observation.failure) return;
      const failure = { kind: "error", detail: describeUnknownError(error) } as const;
      observation.failure = failure;
      resolveFailure(failure);
    });
    child.once("exit", (code, signal) => {
      observation.exited = true;
      resolveExit();
      if (observation.failure) return;
      const detail = signal ? `exited after ${signal}` : `exited with status ${code ?? "unknown"}`;
      const failure = { kind: "exit", detail } as const;
      observation.failure = failure;
      resolveFailure(failure);
    });
    return observation;
  }

  function createUnobservedChild(): ConsoleDaemonChildObservation {
    return {
      failure: null,
      exited: false,
      failurePromise: new Promise<ConsoleDaemonChildFailure>(() => {}),
      exitPromise: new Promise<void>(() => {}),
    };
  }

  async function cleanupOwnedChild(child: ConsoleDaemonProcess | null, observation: ConsoleDaemonChildObservation): Promise<string | null> {
    if (!child) return null;
    const errors: string[] = [];
    if (child.pid === undefined && !observation.failure) {
      errors.push("the spawned process did not expose a pid");
    }
    if (child.pid !== undefined && !observation.exited) {
      try {
        child.kill("SIGTERM");
      } catch (error) {
        errors.push(`SIGTERM failed: ${describeUnknownError(error)}`);
      }
      await waitForChildExit(observation);
    }
    if (child.pid !== undefined && !observation.exited) {
      try {
        child.kill("SIGKILL");
      } catch (error) {
        errors.push(`SIGKILL failed: ${describeUnknownError(error)}`);
      }
      await waitForChildExit(observation);
    }
    if (child.pid !== undefined && observation.exited) {
      try {
        const leftover = await reclaimExitedChildLock(child.pid);
        if (leftover) errors.push(leftover);
      } catch (error) {
        errors.push(`owned lock cleanup failed: ${describeUnknownError(error)}`);
      }
    } else if (child.pid !== undefined) {
      errors.push("the spawned process did not exit after SIGKILL");
    }
    return errors.length > 0 ? errors.join("; ") : null;
  }

  /**
   * The child's exit only lets this cleanup start: by now its pid may name another live process that wrote a new lock.
   * The lock is removed only through the reclaim protocol (exact bytes, ESRCH now); otherwise it stays and is reported.
   */
  async function reclaimExitedChildLock(childPid: number): Promise<string | null> {
    const observed = lock.observeLock(paths.lockFile);
    if (observed.kind === "absent") return null;
    if (observed.kind !== "owner") return `the lock ${paths.lockFile} could not be judged (${observed.reason}); it was left in place`;
    if (observed.instance.pid !== childPid) return null;
    const result: ConsoleLockReclaimResult = await lock.reclaimLock(paths.lockFile, observed.instance);
    if (result.kind === "removed" || result.kind === "gone") return null;
    if (result.kind === "alive") return `the lock ${paths.lockFile} now names a running pid ${result.pid}; it was left in place`;
    return describeReclaimResult(paths.lockFile, result);
  }

  async function waitForChildExit(observation: ConsoleDaemonChildObservation): Promise<void> {
    if (observation.exited) return;
    if (!deps.sleep) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, cleanupGraceMs);
        void observation.exitPromise.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      return;
    }
    await Promise.race([
      observation.exitPromise,
      sleep(cleanupGraceMs),
    ]);
  }

  function readTrustedLock(): ConsoleLockPayload | null {
    const payload = lock.readLock(paths.lockFile);
    if (!payload) return null;
    lock.assertTrustedLock({
      dir: paths.dir,
      lockFile: paths.lockFile,
      payload,
      host: FIXED_HOST,
    });
    return payload;
  }
}

/**
 * 서버를 보장하고 그 주소를 돌려준다. 화면을 여는 것은 CLI의 일이 아니다 — 터미널에서
 * 주소를 읽은 사용자가 어느 브라우저로 갈지 스스로 정한다.
 */
export async function startFleetConsole(deps: StartFleetConsoleDeps = {}): Promise<StartFleetConsoleResult> {
  const lifecycle = deps.lifecycle ?? createConsoleDaemonLifecycle();
  await lifecycle.ensureDaemon();
  const status = await lifecycle.probe();
  if (!status.healthy || !status.lock) {
    throw new Error("Fleet Console server is not healthy after ensure");
  }
  return { url: `${status.lock.endpoint}console/` };
}

export async function runConsoleStatus(deps: ConsoleStatusDeps = {}): Promise<string> {
  const lifecycle = deps.lifecycle ?? createConsoleDaemonLifecycle();
  const status = await lifecycle.probe();
  if (!status.healthy || !status.lock) {
    const reason = status.error ? ` (${status.error})` : "";
    return `Fleet Console server: not running${reason}`;
  }
  const consoleUrl = `${status.lock.endpoint}console/`;
  const workspaceCount = typeof status.health?.workspaceCount === "number" ? status.health.workspaceCount : 0;
  const staleNote = status.buildStale ? " · build stale (restart recommended)" : "";
  const ownerNote = status.lock.owner?.kind === "desktop" ? " · owned by desktop" : "";
  return [
    `Fleet Console server: running (pid ${status.lock.pid})`,
    `  endpoint   ${status.lock.endpoint}`,
    `  console    ${consoleUrl}`,
    `  workspaces ${workspaceCount}${staleNote}${ownerNote}`,
  ].join("\n");
}

export async function runConsoleStop(deps: ConsoleStopDeps = {}): Promise<string> {
  const lifecycle = deps.lifecycle ?? createConsoleDaemonLifecycle();
  const result = await lifecycle.stop();
  // Console은 내려갔지만 정리를 끝내지 못했다. 성공으로 보고하면 남은 자식·임시파일이 숨는다 — 두 진입점 모두 오류를 stderr·exit 1로 낸다.
  if (result.forced) throw new Error(describeForcedStop(result.shutdownTimeoutMs));
  return "Fleet Console server stopped.";
}

function reportToStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function describeForcedStop(shutdownTimeoutMs: number): string {
  return `Fleet Console was force-stopped: it did not finish shutting down within ${Math.round(shutdownTimeoutMs / 1_000)}s of SIGTERM. `
    + "Agent processes and temporary files it started may remain; end any leftover agent processes before starting it again.";
}

export function assertCliCanControlDaemon(payload: ConsoleLockPayload): void {
  void payload;
}

export function isLockProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM은 살아있지만 권한이 없는 프로세스 — 보호 대상으로 취급한다. ESRCH만 죽은 것으로 본다.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const PS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * pid의 시작 시각(epoch ms, 초 단위 내림)을 읽는다. macOS·Linux는 `ps -o lstart`, Windows는 PowerShell `Get-Process`다.
 * 프로세스가 없거나 시작 시각을 읽을 수 없으면 null이다.
 * macOS의 µs 시작 시각은 sysctl kern.proc에만 있어 Node 표준 API로 읽을 수 없으므로 macOS·Linux 공통 형식인 ps를 쓴다.
 */
function readProcessStartTime(pid: number, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
  if (process.platform === "win32") return readWindowsProcessStartTime(pid, env);
  return new Promise((resolve) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], {
      // 증명의 전제다. LC_ALL=C는 파싱할 영문 날짜 형식을, TZ=UTC는 Date.UTC 해석을 보장한다. TZ가 빠지면 지역 시간대
      // 오프셋만큼 시작 시각이 어긋나 PROCESS_START_MARGIN_MS·LOCK_AUTHOR_REPLACED_MARGIN_MS가 무력화된다.
      env: { PATH: env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
      timeout: 2_000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(parsePsLstartUtc(String(stdout)));
    });
  });
}

/**
 * Windows 프로세스의 시작 시각을 PowerShell로 읽는다. Windows는 ps가 없고 Node도 시작 시각을 주지 않는다.
 * UTC epoch ms를 정수로 출력하게 해 지역 시간대·문화권 형식에 기대지 않는다. ps와 같은 정밀도로 맞추려고 초 단위로 내린다.
 * PowerShell은 SystemRoot 등 Windows 환경이 있어야 뜨므로 env를 그대로 넘긴다.
 */
function readWindowsProcessStartTime(pid: number, env: NodeJS.ProcessEnv): Promise<number | null> {
  const script = `[DateTimeOffset]::new((Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`;
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env,
      timeout: 10_000,
      windowsHide: true,
    }, (error, stdout) => {
      const millis = Number(String(stdout).trim());
      resolve(error || !Number.isSafeInteger(millis) || millis <= 0 ? null : Math.floor(millis / 1_000) * 1_000);
    });
  });
}

function parsePsLstartUtc(output: string): number | null {
  const match = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(output.trim());
  if (!match) return null;
  const month = PS_MONTHS.indexOf(match[1]!);
  if (month < 0) return null;
  return Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
}

export async function runConsoleRestart(deps: ConsoleRestartDeps = {}): Promise<StartFleetConsoleResult> {
  const lifecycle = deps.lifecycle ?? createConsoleDaemonLifecycle();
  // 기존 데몬을 정지한 뒤 새 데몬을 띄운다. 강제 종료였어도 목표(실행 중인 Console)는 이룰 수 있으므로 경고만 남긴다.
  const stopped = await lifecycle.stop();
  if (stopped.forced) (deps.report ?? reportToStderr)(describeForcedStop(stopped.shutdownTimeoutMs));
  return startFleetConsole({ lifecycle });
}

export async function main(): Promise<void> {
  if (process.argv[2] === "serve") {
    try {
      await createConsoleDaemonLifecycle().runServer();
    } catch (error) {
      if (!isConsoleLockHeldError(error)) throw error;
      // The lock's own text (who holds it, or how to recover by hand) is the whole diagnosis; the status tells a
      // supervisor that this start lost the lock rather than failed some other way. A detached serve has no stderr, so
      // the text also goes to the bounded failure log, where an update reads it. Only the file gets the JSON record:
      // stderr keeps the one human-readable message a supervising Desktop shows.
      try {
        createConsoleFailureLog(createConsoleDataPaths({ env: process.env }).dir, { echo: false })("lock_held", error);
      } catch {
        // A missing record must not hide the failure itself.
      }
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = CONSOLE_SERVE_EXIT_LOCK_HELD;
    }
    return;
  }
  if (process.argv[2] === "hook") {
    const hookCommand = parseConsoleHookCommand(process.argv.slice(3));
    if (hookCommand.command === "workspace") {
      const sessionId = process.env.FLEET_CONSOLE_WORKSPACE_SESSION_ID;
      const runId = process.env.FLEET_CONSOLE_WORKSPACE_RUN_ID;
      if (!sessionId || !runId) return;
      const observedAt = performance.timeOrigin;
      await postAgentHook(`/sessions/${encodeURIComponent(sessionId)}/workspace`, {
        runId, observedAt, input: await readStdinBestEffort(),
      }, process.env);
      return;
    }
    if (hookCommand.command === "turn-start" || hookCommand.command === "turn-end") {
      // 턴 상태 hook은 항상 무출력·exit 0 best-effort다(hook continuation과 block 출력 금지).
      // 턴 종료(Stop) payload에는 그 시점에 살아 있는 백그라운드 작업 목록도 실려 있다. 같은 POST로 넘겨
      // 서버가 두 축을 한 번에 반영하게 한다 — 따로 보내면 둘 사이의 찰나에 세션이 거짓 유휴로 보인다.
      if (hookCommand.command === "turn-start") {
        await postAgentHook(`/sessions/${readHookSessionId(process.env)}/turn`, { phase: "start", input: await readStdinBestEffort() }, process.env);
        return;
      }
      await postAgentHook(`/sessions/${readHookSessionId(process.env)}/turn`, { phase: "end", input: await readStdinBestEffort() }, process.env);
      return;
    }
    if (hookCommand.command === "background-report") {
      // 백그라운드 보고 hook도 무출력·exit 0 best-effort다. hook payload를 그대로 넘기고 해석은 서버가 한다.
      await postAgentHook(`/sessions/${readHookSessionId(process.env)}/background`, { input: await readStdinBestEffort() }, process.env);
      return;
    }
    if (hookCommand.command === "background-spawn" || hookCommand.command === "background-stop") {
      // 퇴역한 이름은 퇴역 당시의 본문 형식을 그대로 보낸다. 업그레이드는 활성 Operation이 있으면 구 데몬을
      // 그대로 두는데(ensureDaemon의 workspaceCount 보호), 그 서버는 {event}만 이해하므로 새 형식을 보내면
      // 400으로 떨어져 살아 있는 세션의 백그라운드 축이 통째로 죽는다. 새 서버는 이 본문을 무의견으로 받고,
      // 그 세션의 실제 보고는 같은 새 바이너리가 보내는 turn-end payload가 담당한다.
      await postAgentHook(`/sessions/${readHookSessionId(process.env)}/background`, { event: hookCommand.command === "background-spawn" ? "spawn" : "stop" }, process.env);
      return;
    }
    if (hookCommand.command === "attention") {
      // 입력 대기 알림 hook도 무출력·exit 0 best-effort다(claude block/추가 stdout 금지).
      await postAgentHook(`/sessions/${readHookSessionId(process.env)}/attention`, { input: await readStdinBestEffort() }, process.env);
      return;
    }
    if (hookCommand.command === "agent-call") {
      // 다른 hook과 달리 결정을 stdout으로 낸다. 침묵은 허용이고, 거절은 PreToolUse의 deny와 사유다.
      const decision = await decideAgentCall(process.env.FLEET_CONSOLE_AGENT_CALL_SESSION_ID, await readStdinBestEffort(), process.env);
      if (decision) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision } }));
      return;
    }
    if (hookCommand.command === "auto-name") {
      // 자동 작명 hook도 무출력·exit 0 best-effort다(stdin prompt를 읽어 서버로 전달만 한다).
      await postAgentHook(`/sessions/${readHookSessionId(process.env)}/auto-name`, { input: await readStdinBestEffort() }, process.env);
      return;
    }
    await postAgentHook(`/sessions/${readHookSessionId(process.env)}/capture`, { provider: hookCommand.provider, input: await readStdinBestEffort() }, process.env);
    return;
  }
  const mode = parseConsoleCliMode(process.argv.slice(2));
  await runConsolePublishedCommand(mode, { stdout: process.stdout, env: process.env });
}

// 두 published bin은 실행 순서와 결과 출력을 공유하되 각 진입점의 예외 경계는 유지한다.
export async function runConsolePublishedCommand(
  mode: ConsoleCliMode,
  io: { readonly stdout: { write(chunk: string): boolean; readonly isTTY?: boolean }; readonly env?: NodeJS.ProcessEnv },
): Promise<void> {
  if (mode === "help") {
    io.stdout.write(`${buildConsoleHelpText({ env: io.env, isTTY: io.stdout.isTTY })}\n`);
    return;
  }
  if (mode === "status") {
    io.stdout.write(`${await runConsoleStatus()}\n`);
    return;
  }
  if (mode === "stop") {
    io.stdout.write(`${await runConsoleStop()}\n`);
    return;
  }
  if (mode === "restart") {
    await runConsoleRestart();
    io.stdout.write(`${describeConsoleReady("Fleet Console restarted.")}\n${await runConsoleStatus()}\n`);
    return;
  }
  await startFleetConsole();
  io.stdout.write(`${describeConsoleReady("Fleet Console is ready.")}\n${await runConsoleStatus()}\n`);
}

/**
 * 화면을 대신 열지 않는 대신, 바로 뒤에 붙는 상태 출력의 `console` 줄이 사용자가 열 주소라는
 * 사실을 한 줄로 말해 둔다.
 */
function describeConsoleReady(headline: string): string {
  return `${headline} Open the console address below in your browser.`;
}

export function resolveDefaultServerModulePath(moduleUrl: string = import.meta.url): string {
  const builtPath = fileURLToPath(new URL("../dist/cli.mjs", moduleUrl));
  if (fs.existsSync(builtPath)) return builtPath;
  return fileURLToPath(moduleUrl);
}

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readHookSessionId(env: NodeJS.ProcessEnv): string {
  return encodeURIComponent(env.FLEET_CONSOLE_SESSION_ID ?? "");
}

async function postAgentHook(pathname: string, body: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const paths = createConsolePaths({ env });
    const lock = createConsoleLock().readLock(paths.lockFile);
    if (!lock) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    if (typeof timer.unref === "function") timer.unref();
    try {
      await fetch(`${lock.endpoint}api/v1/agent${pathname}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${lock.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // provider hook은 UI best-effort 신호라 실패해도 stdout/stderr와 exit code에 영향을 주지 않는다.
  }
}

/** Console에 닿지 못해 판단을 받지 못한 서브에이전트 호출의 거절 사유. 판단이 없을 때 서브에이전트를 띄우지 않는다. */
const AGENT_CALL_UNREACHABLE_REASON = "Subagents are not available in this Fleet Console session, and Fleet Console could not be reached to say how to delegate instead. Continue the work in this session.";
const AGENT_CALL_TIMEOUT_MS = 5_000;

/**
 * 서브에이전트 호출 하나를 Console에 묻고 거절 사유를 돌려준다. null은 허용이다.
 *
 * 이 세션의 식별자가 없으면 Console이 띄운 Operation이 아니므로 관여하지 않는다. 식별자가 있는데 Console이
 * 답하지 못하면(잠금 없음·시한 초과·오류 응답) 막는다 — 이 hook의 침묵은 곧 서브에이전트 실행이기 때문이다.
 */
export async function decideAgentCall(sessionId: string | undefined, input: string, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!sessionId) return null;
  if (!isAgentToolCall(input)) return null;
  try {
    const lock = createConsoleLock().readLock(createConsolePaths({ env }).lockFile);
    if (!lock) return AGENT_CALL_UNREACHABLE_REASON;
    const response = await fetchImpl(`${lock.endpoint}api/v1/agent/sessions/${encodeURIComponent(sessionId)}/agent-call`, {
      method: "POST",
      headers: { authorization: `Bearer ${lock.token}`, "content-type": "application/json" },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(AGENT_CALL_TIMEOUT_MS),
    });
    if (!response.ok) return AGENT_CALL_UNREACHABLE_REASON;
    const body = await response.json() as { readonly reason?: unknown };
    if (body.reason === null) return null;
    return typeof body.reason === "string" && body.reason.length > 0 ? body.reason : AGENT_CALL_UNREACHABLE_REASON;
  } catch {
    return AGENT_CALL_UNREACHABLE_REASON;
  }
}

/** 매처가 이미 거르지만, 다른 도구 이름이 이 hook에 닿아도 결정을 내지 않는다. 읽지 못한 입력은 서브에이전트 호출로 본다. */
function isAgentToolCall(input: string): boolean {
  try {
    const toolName = (JSON.parse(input) as { readonly tool_name?: unknown }).tool_name;
    return typeof toolName !== "string" || toolName === "Agent" || toolName === "Task";
  } catch {
    return true;
  }
}

function readStdinBestEffort(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(""), 500);
    if (typeof timer.unref === "function") timer.unref();
    process.stdin.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      finish("");
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      finish(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

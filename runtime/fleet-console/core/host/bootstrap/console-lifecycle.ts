import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { withHidden, withNodeSystemCa } from "@fleet-console/process";
import {
  captureProvenProcessStart,
  createConsoleHealthClient,
  isPidAlive,
  observeConsoleInstance,
  readConsoleExitRecord,
  readProcessStartTime,
  runStopLadder,
  writeConsoleExitRecord,
  type ConsoleInstanceObservation,
  type ConsoleProbeOptions,
  type ConsoleProbeResult,
} from "@fleet-console/lifecycle";
import {
  CONSOLE_EXIT_RECORD_VERSION,
  CONSOLE_SERVE_EXIT_LOCK_HELD,
  CONSOLE_START_POLL_MS,
  CONSOLE_START_TIMEOUT_MS,
  CONSOLE_STOP_DEADLINE_MS,
  EXTERNAL_ESCALATION_MS,
  PRELOCK_CHILD_GRACE_MS,
  PROCESS_TABLE_TIMEOUT_MS,
  type ConsoleExitOutcome,
} from "@fleet-console/protocol/lifecycle";

import type { ConsoleLockPayload } from "../transport/console-contract-types.js";
import { describeDaemonStartFailure } from "../transport/failure-notice.js";
import { createConsoleFailureLog } from "./failure-log.js";
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
import { createConsoleServeLifecycle } from "./serve-lifecycle.js";
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
  readonly health?: ConsoleLockHealthProbe;
  /** 사용자에게 알릴 한 줄(대기 안내, 강제 종료 경고). 기본은 stderr다. */
  readonly report?: (message: string) => void;
}

/** The token-authenticated health probe of a Console lock (`createConsoleHealthClient` from `@fleet-console/lifecycle`). */
export interface ConsoleLockHealthProbe {
  probe(lock: ConsoleLockPayload | null, options?: ConsoleProbeOptions): Promise<ConsoleProbeResult<ConsoleLockPayload>>;
}

/**
 * How a stop ended, from the stopped instance's exit record (docs/console-lifecycle-contract.md, "Exit record").
 * - not-running: no Console ran under the lock; at most an exited Console's lock was cleared.
 * - unrecorded: the Console exited without a record and cannot be blamed for it — it predates the contract, or Windows
 *   ended it on SIGTERM (TerminateProcess), where no shutdown runs.
 * - an exit outcome: what the instance recorded (`unknown` for an outcome this version does not know), or `external`
 *   when a contract Console vanished without a record, or `forced-external` when this stop escalated to SIGKILL.
 */
export interface ConsoleStopResult {
  readonly outcome: "not-running" | "unrecorded" | "unknown" | ConsoleExitOutcome;
  /** Leftover child processes the Console killed on its way out. */
  readonly killed: number;
}

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
  const startupTimeoutMs = Math.max(0, deps.startupTimeoutMs ?? CONSOLE_START_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, deps.pollIntervalMs ?? CONSOLE_START_POLL_MS);
  const report = deps.report ?? reportToStderr;
  const paths = createConsolePaths({ env });
  const lock = createConsoleLock({ report });
  const health: ConsoleLockHealthProbe = deps.health ?? createConsoleHealthClient();
  const stale = createConsoleStalePolicy();

  async function runServer(): Promise<void> {
    let recordFailure: (kind: string, error: unknown) => void = (kind, error) => {
      try { process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), kind, message: String(error), stack: null })}\n`); } catch { /* No diagnostic channel remains. */ }
    };
    try { recordFailure = createConsoleFailureLog(createConsoleDataPaths({ env }).dir); }
    catch { /* Diagnostics setup cannot prevent Console startup. */ }
    // One state owner for this instance (docs/console-lifecycle-contract.md §2). A signal, an accepted update, and the
    // server API all make the same stop request: the first arms the one deadline below, the shutdown runs once, and it
    // releases the lock only at its end.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let exitOutcome: { readonly outcome: ConsoleExitOutcome; readonly killed: number } | null = null;
    const lifecycle = createConsoleServeLifecycle({
      // From the first stop request until the process exits, whatever is still running: a stalled start, a cleanup stuck
      // with the lock, or a child that outlives the released lock. Leftover children are SIGKILLed first; a lock left
      // behind is reclaimed by the next Console once this pid is ESRCH.
      onStopRequested: () => {
        deadline = setTimeout(() => {
          let killed = 0;
          try { killed = killShutdownStragglers(env, recordFailure); }
          catch (error) { recordFailure("shutdown_process_table_unavailable", error); }
          const settled = lifecycle.isStartupSettled();
          recordFailure(settled ? "shutdown_timeout" : "startup_shutdown_timeout", new Error(`Console ${settled ? "shutdown" : "startup shutdown"} did not finish within ${CONSOLE_STOP_DEADLINE_MS}ms; SIGKILL sent to ${killed} leftover child process(es)`));
          exitOutcome = { outcome: "deadline", killed };
          process.exit(1);
        }, CONSOLE_STOP_DEADLINE_MS);
      },
      onShutdownFailed: (error) => {
        recordFailure("shutdown_failed", error);
        exitOutcome ??= { outcome: "failed", killed: 0 };
        process.exitCode = 1;
      },
      // From here only leftover handles (an SDK child still being reaped) keep the process alive. An unref'd deadline
      // fires only while something still does, so a clean exit is never delayed and a stuck one still ends.
      onReleased: () => deadline?.unref(),
    });
    // The serve process owns these handlers until it exits, not until runServer returns: after the lock is released the
    // process stays alive while the SDK reaps a child that ignored SIGTERM (its 5s SIGKILL timer runs inside this
    // process). A signal or crash that killed it there would take that timer along and orphan the child and its MCP
    // children. Signal listeners do not keep the event loop alive, so keeping them never delays the natural exit.
    const onRejection = (error: unknown) => recordFailure("unhandledRejection", error);
    const onException = (error: Error) => {
      recordFailure("uncaughtException", error);
      // Once shutdown has begun, leave the exit to the cleanup in progress or to the shutdown deadline. Exiting here
      // drops the SDK's reap timers and orphans the children it is still waiting on.
      exitOutcome = { outcome: "crash", killed: 0 };
      if (lifecycle.stopRequested()) {
        process.exitCode = 1;
        return;
      }
      process.exit(1);
    };
    // Only the Console serve process owns global policy; a failed registration must not block boot.
    try {
      process.on("unhandledRejection", onRejection);
      process.on("uncaughtException", onException);
    } catch (error) { recordFailure("handler_install_failed", error); }
    // The instance that held the lock says how it ended, beside that lock, as the process exits. A serve that never took
    // the lock writes nothing into a slot another Console owns.
    process.on("exit", (code) => {
      const instance = lifecycle.lockInstance();
      if (!instance) return;
      const ended = exitOutcome ?? { outcome: code === 0 ? "clean" : "failed", killed: 0 };
      try {
        writeConsoleExitRecord(paths.lockFile, { v: CONSOLE_EXIT_RECORD_VERSION, pid: instance.pid, lockStartedAt: instance.startedAt, outcome: ended.outcome, killed: ended.killed, at: Date.now() });
      } catch (error) { recordFailure("exit_record_failed", error); }
    });
    const server = createConsoleServer({ lifecycle });
    // Signals are accepted before the lock is published; a stop requested during startup waits for it to settle.
    const onSignal = () => { void lifecycle.requestStop("signal").catch(() => { /* Recorded by onShutdownFailed. */ }); };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    try {
      await server.start(paths);
    } catch (error) {
      // A start that failed after it took the lock ends this instance with an error; a lost lock never had an instance.
      if (lifecycle.lockInstance()) exitOutcome ??= { outcome: "failed", killed: 0 };
      if (lifecycle.stopRequested()) await lifecycle.whenStopped();
      throw error;
    }
    await lifecycle.whenStopped();
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
    if (!payload) return { outcome: "not-running", killed: 0 };
    // 정체 증명(health 요청)보다 먼저 잰 벽시계 시각. 이보다 먼저 시작한 프로세스만 증명된 Console과 같은 프로세스일 수 있다.
    const identityProbedAt = Date.now();
    const observed = await observe(payload);
    if (observed.state === "exited") {
      // lock만 남았다(pid가 끝났거나 lock을 쓴 뒤 재할당됐다). 신호 없이 같은 instance의 lock일 때만 회수 프로토콜로 지운다.
      await removeLockHeldBy(payload);
      return { outcome: "not-running", killed: 0 };
    }
    // 살아 있는 무언가가 lock을 붙잡고 있지만 lock token으로 정체를 증명하지 못했다. 신호는 무관한 프로세스를 죽일 수 있고,
    // lock을 지우면 살아 있는 Console 옆에 두 번째 소유자가 생길 수 있으므로 둘 다 하지 않는다.
    if (observed.state === "unverified") throw lockOwnerUnverifiedError(payload);
    if (observed.state === "starting") throw lockOwnerStartingError(payload);
    // ready만 이 stop이 정지를 요청한다. 이미 정지 중인(listener를 닫고 정리 중인) Console이나 lock을 놓고 자식을 거두는
    // Console에는 신호를 다시 보내지 않고 같은 예산 안에서 끝나기를 기다린다.
    const requester = observed.state === "ready";
    if (requester) assertCliCanControlDaemon(payload);
    const provenStart = requester ? await captureProvenProcessStart(payload.pid, identityProbedAt, env) : null;
    const ended = await runStopLadder({
      requester,
      isAlive: () => isPidAlive(payload.pid),
      isReleased: () => isLockReleasedBy(payload),
      reprove: () => reproveLockOwner(payload, provenStart),
      signal: (signal) => signalLockProcess(payload.pid, signal),
      onWaiting: () => report("Waiting for Fleet Console to finish shutting down..."),
      now,
      sleep,
    });
    const instance = { pid: payload.pid, lockStartedAt: payload.startedAt };
    if (ended === "held") throw lockOwnerStillStoppingError(payload);
    if (ended === "unproven") throw lockOwnerUnverifiedError(payload);
    if (ended === "released-alive") throw lockReleasedOwnerAliveError(payload);
    if (ended === "kill-failed") throw new Error(`Fleet Console pid ${payload.pid} did not exit after SIGKILL; ${paths.lockFile} was left in place.`);
    // 끝난 Console이 남긴 lock은 그 pid가 ESRCH인 지금 회수 프로토콜로 지운다.
    await removeLockHeldBy(payload);
    if (ended === "forced") {
      recordForcedExit(instance);
      return { outcome: "forced-external", killed: 0 };
    }
    const record = readConsoleExitRecord(paths.lockFile, instance);
    if (record) return { outcome: record.outcome, killed: record.killed };
    // 기록 없이 사라졌다. 계약을 아는 Console이면 밖에서 끝난 것이다. 계약 이전 Console이거나, Windows에서 SIGTERM이 곧
    // TerminateProcess라 정리가 돌지 않은 경우는 탓할 근거가 없으므로 지금까지처럼 정지로 본다.
    const unattributable = !reportsLifecycleWire(observed) || (requester && process.platform === "win32");
    return { outcome: unattributable ? "unrecorded" : "external", killed: 0 };
  }

  function observe(payload: ConsoleLockPayload): Promise<ConsoleInstanceObservation<ConsoleLockPayload>> {
    // readTrustedLock already passed the lock's trust checks; a tokenless lock stays untrusted inside the observation.
    return observeConsoleInstance({ lock: payload, trusted: true, isHeld: () => !isLockReleasedBy(payload), probe: (target, options) => health.probe(target, options), env });
  }

  /**
   * Right before SIGKILL: is the stalled pid still the Console proven before SIGTERM? A start time captured before that
   * proof that is unchanged, with the same lock still held, proves it — a reused pid starts after the proof. Otherwise a
   * fresh authenticated health answer must prove it again.
   */
  async function reproveLockOwner(payload: ConsoleLockPayload, provenStart: number | null): Promise<boolean> {
    if (provenStart !== null && await readProcessStartTime(payload.pid, env) === provenStart && isLockStillHeldBy(payload)) return true;
    return (await observe(payload)).identity === "verified";
  }

  /** This stop SIGKILLed the instance: nothing ran inside it to record how it ended, so the stop records it. */
  function recordForcedExit(instance: { readonly pid: number; readonly lockStartedAt: number }): void {
    try {
      writeConsoleExitRecord(paths.lockFile, { v: CONSOLE_EXIT_RECORD_VERSION, ...instance, outcome: "forced-external", killed: 0, at: Date.now() });
    } catch {
      // The record only informs later readers; the stop's own result already says it was forced.
    }
  }

  function describeStuckOwner(payload: ConsoleLockPayload, headline: string): Error {
    return new Error([
      headline,
      `If that process is a stuck Fleet Console, stop it (kill -TERM ${payload.pid}; Windows: Stop-Process -Id ${payload.pid}), then run fleet console start. A suspended process (state T in ps) ignores TERM until resumed: kill -CONT ${payload.pid} lets it finish shutting down, or kill -KILL ${payload.pid} ends it.`,
      `If it is not a Fleet Console, follow the check below and then delete ${paths.lockFile}.`,
      describeSlotQuiescenceCheck(paths.lockFile),
    ].join("\n"));
  }

  function lockOwnerUnverifiedError(payload: ConsoleLockPayload): Error {
    return describeStuckOwner(payload, `Fleet Console lock pid ${payload.pid} is alive but did not prove it owns ${paths.lockFile}, so it was not signalled.`);
  }

  function lockOwnerStillStoppingError(payload: ConsoleLockPayload): Error {
    return describeStuckOwner(payload, `Fleet Console lock pid ${payload.pid} no longer answers at the lock's address but still held ${paths.lockFile} ${Math.round(EXTERNAL_ESCALATION_MS / 1_000)}s later (a Console still shutting down, or another process), so it was not signalled.`);
  }

  function lockOwnerStartingError(payload: ConsoleLockPayload): Error {
    return new Error(`Fleet Console pid ${payload.pid} holds ${paths.lockFile} and is still starting, so it was not signalled. Run fleet console stop again once fleet console status shows it running.`);
  }

  function lockReleasedOwnerAliveError(payload: ConsoleLockPayload): Error {
    return new Error(`Fleet Console pid ${payload.pid} released its lock but was still running ${Math.round(EXTERNAL_ESCALATION_MS / 1_000)}s after the stop request, so it was not signalled. Its own shutdown deadline ends it; if it keeps running, stop it (kill -TERM ${payload.pid}; Windows: Stop-Process -Id ${payload.pid}).`);
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
    while (current && probeResult.starting && isPidAlive(current.pid)) {
      const remaining = startingDeadline - now();
      if (remaining <= 0) throw lockOwnerUnverifiedError(current);
      await sleep(Math.min(pollIntervalMs, remaining));
      current = await readLockForStart();
      probeResult = await health.probe(current, { timeoutMs: Math.max(0, startingDeadline - now()) });
      // 마지막 probe의 예산 소진을 기존 unhealthy→stop 경로로 바꾸지 않는다.
      if (!probeResult.healthy && now() >= startingDeadline && current && isPidAlive(current.pid)) throw lockOwnerUnverifiedError(current);
    }
    const isBuildStale = current ? stale.isBuildStale(current, serverModulePath) : false;
    if (probeResult.healthy && current) {
      if (!isBuildStale) return current.endpoint;
      if (typeof probeResult.health?.workspaceCount === "number" && probeResult.health.workspaceCount > 0) return current.endpoint;
    }
    if (current) {
      const unclean = describeUncleanStop(await stop());
      if (unclean) report(unclean);
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
      const pid = child.pid;
      if (childLockState(pid) === "held") {
        // A child that took the lock may be writing durable state: it gets the stop ladder and its own deadline, never a
        // SIGKILL right after SIGTERM. The unreaped child handle proves its identity, so the pid cannot have been reused.
        const ended = await runStopLadder({
          requester: true,
          isAlive: () => !observation.exited,
          isReleased: () => childLockState(pid) === "released",
          reprove: async () => !observation.exited,
          signal: (signal) => killOwnedChild(child, signal, errors),
          now,
          sleep,
        });
        if (ended === "released-alive") errors.push("the spawned Console released its lock but did not exit");
      } else {
        // Before the lock a child has written nothing, so a short grace is enough.
        killOwnedChild(child, "SIGTERM", errors);
        await waitForChildExit(observation);
        if (!observation.exited) {
          killOwnedChild(child, "SIGKILL", errors);
          await waitForChildExit(observation);
        }
      }
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

  function killOwnedChild(child: ConsoleDaemonProcess, signal: NodeJS.Signals, errors: string[]): void {
    try {
      child.kill(signal);
    } catch (error) {
      errors.push(`${signal} failed: ${describeUnknownError(error)}`);
    }
  }

  /** Whether the lock names `pid`. A lock that cannot be judged is neither held by it for sure nor released. */
  function childLockState(pid: number): "held" | "released" | "unknown" {
    const observed = lock.observeLock(paths.lockFile);
    if (observed.kind === "absent") return "released";
    if (observed.kind !== "owner") return "unknown";
    return observed.instance.pid === pid ? "held" : "released";
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
        const timer = setTimeout(resolve, PRELOCK_CHILD_GRACE_MS);
        void observation.exitPromise.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      return;
    }
    await Promise.race([
      observation.exitPromise,
      sleep(PRELOCK_CHILD_GRACE_MS),
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
  // Console은 내려갔지만 정리를 끝내지 못했다. 성공으로 보고하면 남은 자식·임시파일이 숨는다 — 두 진입점 모두 오류를 stderr·exit 1로 낸다.
  const unclean = describeUncleanStop(await lifecycle.stop());
  if (unclean) throw new Error(unclean);
  return "Fleet Console server stopped.";
}

function reportToStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

const LEFTOVER_ADVICE = "Agent processes and temporary files it started may remain; end any leftover agent processes before starting it again.";

/** What to tell a person about a stop that did not end in a clean shutdown, or null when it did. */
function describeUncleanStop(result: ConsoleStopResult): string | null {
  switch (result.outcome) {
    case "not-running":
    case "unrecorded":
    case "clean":
      return null;
    case "deadline":
      return `Fleet Console did not finish shutting down within ${Math.round(CONSOLE_STOP_DEADLINE_MS / 1_000)}s and ended itself`
        + (result.killed > 0 ? `, killing ${result.killed} leftover process(es) it had started.` : ".")
        + " Temporary files it started may remain.";
    case "crash":
      return `Fleet Console crashed on an unexpected error instead of shutting down cleanly; the Console failure log (errors.jsonl in its data directory) says why. ${LEFTOVER_ADVICE}`;
    case "failed":
      return `Fleet Console failed while starting or shutting down and ended with an error; the Console failure log (errors.jsonl in its data directory) says why. ${LEFTOVER_ADVICE}`;
    case "unknown":
      return `Fleet Console ended in a way this fleet version does not recognize, so it is not reported as cleanly stopped. ${LEFTOVER_ADVICE}`;
    case "external":
      return `Fleet Console ended without recording how: it was killed from outside or stopped responding. ${LEFTOVER_ADVICE}`;
    case "forced-external":
      return `Fleet Console was force-stopped: it did not finish shutting down within ${Math.round(EXTERNAL_ESCALATION_MS / 1_000)}s of SIGTERM. ${LEFTOVER_ADVICE}`;
  }
}

/** Whether the Console answered health with a lifecycle wire, so it writes an exit record when it ends. */
function reportsLifecycleWire(observed: ConsoleInstanceObservation<ConsoleLockPayload>): boolean {
  const wire = observed.probe?.health?.lifecycleWire;
  return typeof wire === "number" && wire >= 1;
}

export function assertCliCanControlDaemon(payload: ConsoleLockPayload): void {
  void payload;
}

/** One row of the process table: enough to walk this process's descendants and their process groups. */
export interface ConsoleProcessTableRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
}

/**
 * The processes the shutdown deadline may SIGKILL: descendants of `rootPid` that stay in its process group, deepest first.
 * A child that leads a group of its own was handed off on purpose (the detached update worker) or ends with its terminal
 * (a PTY session), so it and everything under it are left alone. The group itself is never signalled as a whole: a
 * Desktop sidecar shares Desktop's group. Without a row for `rootPid` nothing is selected.
 */
export function selectShutdownStragglers(rows: readonly ConsoleProcessTableRow[], rootPid: number, excludePids: readonly number[] = []): number[] {
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) return [];
  const children = new Map<number, ConsoleProcessTableRow[]>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
  }
  const excluded = new Set(excludePids);
  const seen = new Set<number>([rootPid]);
  const selected: Array<{ readonly pid: number; readonly depth: number }> = [];
  const visit = (pid: number, depth: number) => {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid) || child.pgid !== root.pgid) continue;
      seen.add(child.pid);
      if (!excluded.has(child.pid)) selected.push({ pid: child.pid, depth });
      visit(child.pid, depth + 1);
    }
  };
  visit(rootPid, 1);
  return selected.sort((left, right) => right.depth - left.depth).map((entry) => entry.pid);
}

/**
 * SIGKILLs this process's remaining descendants (see selectShutdownStragglers) before the shutdown deadline exits, so the
 * exit leaves no agent CLI or MCP child behind. POSIX only: Windows ends a Console without running its signal handlers.
 * Without a trustworthy process table nothing is signalled — an orphan is better than a signal to an unrelated process.
 * Runs synchronously, so a direct child cannot be reaped (and its pid reused) between the snapshot and its SIGKILL.
 */
function killShutdownStragglers(env: NodeJS.ProcessEnv, recordFailure: (kind: string, error: unknown) => void): number {
  if (process.platform === "win32") return 0;
  const listing = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], {
    env: { PATH: env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROCESS_TABLE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (listing.error || listing.status !== 0 || typeof listing.stdout !== "string") {
    recordFailure("shutdown_process_table_unavailable", listing.error ?? new Error(`ps exited with ${listing.status ?? listing.signal}`));
    return 0;
  }
  const rows: ConsoleProcessTableRow[] = [];
  for (const line of listing.stdout.split("\n")) {
    const fields = line.trim().split(/\s+/).map(Number);
    if (fields.length === 3 && fields.every((value) => Number.isSafeInteger(value) && value >= 0)) {
      rows.push({ pid: fields[0]!, ppid: fields[1]!, pgid: fields[2]! });
    }
  }
  // ps itself was this process's child and is already reaped; its pid must not be signalled.
  const targets = selectShutdownStragglers(rows, process.pid, listing.pid ? [listing.pid] : []);
  let killed = 0;
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGKILL");
      killed += 1;
    } catch {
      // Already gone.
    }
  }
  return killed;
}

export async function runConsoleRestart(deps: ConsoleRestartDeps = {}): Promise<StartFleetConsoleResult> {
  const lifecycle = deps.lifecycle ?? createConsoleDaemonLifecycle();
  // 기존 데몬을 정지한 뒤 새 데몬을 띄운다. 강제 종료였어도 목표(실행 중인 Console)는 이룰 수 있으므로 경고만 남긴다.
  const unclean = describeUncleanStop(await lifecycle.stop());
  if (unclean) (deps.report ?? reportToStderr)(unclean);
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

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { withHidden, withNodeSystemCa } from "@fleet-console/process";
import { identifyConsoleLockOwner, type ConsoleLockHealthEvidence, type ConsoleLockOwnerIdentity } from "@fleet-console/protocol/desktop";

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
import { createConsoleLock } from "./lock.js";
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
  readonly health?: ReturnType<typeof createConsoleHealthClient>;
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
const STOP_SIGTERM_GRACE_MS = 200;
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
  const paths = createConsolePaths({ env });
  const lock = createConsoleLock();
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
      await server.start(paths);
      await new Promise<void>((resolve) => {
        const shutdown = () => {
          void Promise.resolve().then(() => server.stop()).catch((error) => {
            recordFailure("shutdown_failed", error);
            process.exitCode = 1;
          }).finally(resolve);
        };
        process.once("SIGTERM", shutdown);
        process.once("SIGINT", shutdown);
      });
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

  async function stop(): Promise<void> {
    const payload = readTrustedLock();
    if (!payload) return;
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
      await sleep(STOP_SIGTERM_GRACE_MS);
      // 정상 종료한 Console은 lock을 스스로 지운다. lock이 남아 있으면 종료 지연일 수도, Console이 lock을 남긴 채 죽고
      // pid가 재할당된 것일 수도 있다. lock 파일이 그대로라는 사실은 증명이 아니므로 SIGKILL 직전에 정체를 다시 증명한다.
      if (isLockStillHeldBy(payload)) await escalateStalledShutdown(payload, provenStart);
    }
    // 여기까지 온 lock은 pid가 끝났거나(ESRCH, SIGKILL 뒤 종료 확인) 주인이 lock을 이미 놓은 것이다. 신호 없이
    // 같은 pid·token의 lock일 때만 지운다.
    removeLockHeldBy(payload);
  }

  /**
   * SIGTERM 뒤에도 lock을 놓지 않은 pid를 SIGKILL로 정리한다. 그 pid는 SIGTERM 전에 health로 정체가 증명됐으므로,
   * 지금도 같은 프로세스라는 것만 보이면 된다. 증명 전에 시작한 프로세스의 시작 시각이 그대로면 같은 프로세스다 —
   * 그 사이 pid가 재할당됐다면 새 프로세스는 증명 뒤에 시작했으므로 시작 시각이 다르다. 시작 시각을 얻지 못하거나
   * 달라졌으면 health 정체 판별로 돌아간다. 어느 경우에도 살아 있는 pid의 lock만 지우고 성공으로 끝내지 않는다.
   */
  async function escalateStalledShutdown(payload: ConsoleLockPayload, provenStart: number | null): Promise<void> {
    let proven = false;
    if (provenStart !== null) {
      // SIGKILL 직전 재관측: 시작 시각과 lock 소유를 다시 읽는다.
      const currentStart = await readProcessStartTime(payload.pid, env);
      if (currentStart === null && !isLockProcessAlive(payload.pid)) return;
      proven = currentStart === provenStart && isLockStillHeldBy(payload);
    }
    if (!proven) {
      const survivor = await identifyLockOwner(payload);
      if (survivor === "unverified") throw lockOwnerUnverifiedError(payload);
      if (survivor === "absent") return;
    }
    signalLockProcess(payload.pid, "SIGKILL");
    for (let attempt = 0; attempt < STOP_SIGKILL_EXIT_ATTEMPTS; attempt += 1) {
      if (!isLockProcessAlive(payload.pid)) return;
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
    // token 없는 lock은 어떤 Fleet Console도 쓰지 않는다 — 신뢰할 수 없는 lock처럼 파일만 폐기한다.
    if (typeof payload.token !== "string" || payload.token.length === 0) return "absent";
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
    return new Error(`Fleet Console lock pid ${payload.pid} is alive but did not prove it owns ${paths.lockFile}. If that process is a stuck Fleet Console, stop it; if it is not a Fleet Console, delete ${paths.lockFile}.`);
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

  function removeLockHeldBy(payload: ConsoleLockPayload): void {
    const current = lock.readLock(paths.lockFile);
    if (current?.pid !== payload.pid || current.token !== payload.token) return;
    lock.removeLock(paths.lockFile, payload.pid);
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

  async function ensureDaemon(): Promise<string> {
    const current = readTrustedLock({ cleanUntrusted: true });
    const probeResult = await health.probe(current);
    const isBuildStale = current ? stale.isBuildStale(current, serverModulePath) : false;
    if (probeResult.healthy && current) {
      if (!isBuildStale) return current.endpoint;
      if (typeof probeResult.health?.workspaceCount === "number" && probeResult.health.workspaceCount > 0) return current.endpoint;
    }
    if (current) await stop();

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
          // writeLock은 O_EXCL로 파일을 만든 뒤 JSON을 쓰므로 poll이 잠깐 빈/부분 lock을 볼 수 있다.
          // 시작 전 stale lock은 위의 cleanUntrusted probe가 이미 정리했다. 시작 중 read 오류는
          // 쓰고 있는 lock을 지우거나 child를 죽이지 말고 deadline 안에서 다시 확인한다.
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
        lock.removeLock(paths.lockFile, child.pid);
      } catch (error) {
        errors.push(`owned lock cleanup failed: ${describeUnknownError(error)}`);
      }
    } else if (child.pid !== undefined) {
      errors.push("the spawned process did not exit after SIGKILL");
    }
    return errors.length > 0 ? errors.join("; ") : null;
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

  function readTrustedLock(options: { readonly cleanUntrusted?: boolean } = {}): ConsoleLockPayload | null {
    try {
      const payload = lock.readLock(paths.lockFile);
      if (!payload) return null;
      lock.assertTrustedLock({
        dir: paths.dir,
        lockFile: paths.lockFile,
        payload,
        host: FIXED_HOST,
      });
      return payload;
    } catch (err) {
      if (!options.cleanUntrusted) throw err;
      // 신뢰할 수 없는 잠금은 프로세스를 종료하지 않고 파일만 폐기한다.
      lock.removeLock(paths.lockFile);
      return null;
    }
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
  await lifecycle.stop();
  return "Fleet Console server stopped.";
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
 * pid의 시작 시각(epoch ms, 초 단위 내림)을 `ps -o lstart`로 읽는다. 프로세스가 없거나 ps를 쓸 수 없는 플랫폼이면 null이다.
 * macOS의 µs 시작 시각은 sysctl kern.proc에만 있어 Node 표준 API로 읽을 수 없으므로 macOS·Linux 공통 형식인 ps를 쓴다.
 */
function readProcessStartTime(pid: number, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  if (process.platform === "win32" || !Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
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

function parsePsLstartUtc(output: string): number | null {
  const match = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(output.trim());
  if (!match) return null;
  const month = PS_MONTHS.indexOf(match[1]!);
  if (month < 0) return null;
  return Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
}

export async function runConsoleRestart(deps: ConsoleRestartDeps = {}): Promise<StartFleetConsoleResult> {
  const lifecycle = deps.lifecycle ?? createConsoleDaemonLifecycle();
  // 기존 데몬을 정지한 뒤 새 데몬을 띄운다.
  await lifecycle.stop();
  return startFleetConsole({ lifecycle });
}

export async function main(): Promise<void> {
  if (process.argv[2] === "serve") {
    await createConsoleDaemonLifecycle().runServer();
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

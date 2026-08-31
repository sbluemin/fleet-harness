import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { withHidden, withNodeSystemCa } from "@dotobokuri/core-process";

import type { ConsoleLockPayload } from "./console-contract-types.js";
import { openBrowser, type BrowserOpenResult, type OpenBrowserDeps } from "./browser.js";
import { describeConsoleLaunch, describeDaemonStartFailure } from "./failure-notice.js";
import { createConsoleHealthClient } from "./health.js";
import { createConsoleStalePolicy } from "./stale.js";
import {
  ASCII_FLEET_BANNER,
  FLEET_COMMAND,
  GRADIENT_COLORS,
  command,
  dim,
  option,
  paint,
  resolveColorEnabled,
  section,
  stripAnsi,
} from "../../cli/styles/tokens.js";
import { readFleetCliRelease } from "../../cli/release.js";
import { createConsoleLock } from "./lock.js";
import { createConsolePaths } from "./paths.js";
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

export interface OpenFleetConsoleDeps {
  readonly lifecycle?: Pick<ReturnType<typeof createConsoleDaemonLifecycle>, "ensureDaemon" | "probe">;
  readonly openBrowser?: (url: string, deps?: OpenBrowserDeps) => void | Promise<BrowserOpenResult>;
}

export interface OpenFleetConsoleResult {
  readonly url: string;
  /** 브라우저 실행기가 실제로 떴는지. 거짓이면 호출자가 주소를 사용자에게 직접 건네야 한다. */
  readonly browserOpened: boolean;
  readonly browserError?: string;
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
  | { readonly command: "background-report" }
  | { readonly command: "background-spawn" }
  | { readonly command: "background-stop" }
  | { readonly command: "attention" }
  | { readonly command: "auto-name" };

export interface ConsoleRestartDeps {
  readonly lifecycle?: Pick<ReturnType<typeof createConsoleDaemonLifecycle>, "stop" | "ensureDaemon" | "probe">;
  readonly openBrowser?: (url: string, deps?: OpenBrowserDeps) => void;
}

export interface BuildConsoleHelpTextOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly release?: string;
}

const FIXED_HOST = "127.0.0.1";
const HELP_BANNER_INDENT = "  ";
const STARTUP_TIMEOUT_MS = 60_000;
const STARTUP_POLL_INTERVAL_MS = 100;
const CHILD_CLEANUP_GRACE_MS = 500;

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
const CONSOLE_HOOK_COMMANDS = new Set(["capture-session", "turn-start", "turn-end", "background-report", "background-spawn", "background-stop", "attention", "auto-name"]);

export function parseConsoleCliMode(argv: readonly string[]): ConsoleCliMode {
  // 인자가 없으면 기본 동작은 start(서버 보장 + 브라우저 열기)다.
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
  if (commandName === "background-report" && rest.length === 0) return { command: "background-report" };
  if (commandName === "background-spawn" && rest.length === 0) return { command: "background-spawn" };
  if (commandName === "background-stop" && rest.length === 0) return { command: "background-stop" };
  if (commandName === "attention" && rest.length === 0) return { command: "attention" };
  if (commandName === "auto-name" && rest.length === 0) return { command: "auto-name" };
  if (commandName === "capture-session" && rest.length === 1 && rest[0] === "claude") return { command: "capture-session", provider: rest[0] };
  throw new Error("Unknown fleet-console hook command");
}

export function buildConsoleHelpText(options: BuildConsoleHelpTextOptions = {}): string {
  const colorEnabled = resolveColorEnabled(options);
  const release = options.release ?? formatConsoleHelpRelease();
  const subtitle = `Fleet Console · ${release}`;
  const lines = [
    ...ASCII_FLEET_BANNER.map(
      (line, index) => `${HELP_BANNER_INDENT}${paint(GRADIENT_COLORS[index] ?? FLEET_COMMAND, line, colorEnabled)}`,
    ),
    dim(subtitle, colorEnabled),
    "",
    dim("Observe live output streams and console-owned terminal sessions.", colorEnabled),
    "",
    section("USAGE", colorEnabled),
    `  ${command("fleet console", colorEnabled)} ${dim("[start|stop|restart|status] [--help]", colorEnabled)}`,
    `  ${command("fleet-console", colorEnabled)} ${dim("[start|stop|restart|status] [--help]", colorEnabled)}`,
    "",
    section("COMMANDS", colorEnabled),
    `  ${command("start", colorEnabled)}   ${dim("Ensure the local Fleet Console server, then open it in your browser. (default)", colorEnabled)}`,
    `  ${command("stop", colorEnabled)}    ${dim("Stop the local Fleet Console server.", colorEnabled)}`,
    `  ${command("restart", colorEnabled)} ${dim("Restart the local Fleet Console server, then open it in your browser.", colorEnabled)}`,
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
    const server = createConsoleServer();
    await server.start(paths);
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", () => { void server.stop().finally(resolve); });
      process.once("SIGINT", () => { void server.stop().finally(resolve); });
    });
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
    // 소유권 가드는 살아있는 desktop 프로세스에 시그널을 보내는 것만 막는다 —
    // sidecar가 락을 남기고 죽었을 때까지 막으면 stale lock을 CLI가 영영 정리할 수 없다.
    if (isLockProcessAlive(payload.pid)) assertCliCanControlDaemon(payload);
    try {
      process.kill(payload.pid, "SIGTERM");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
    await sleep(200);
    try {
      process.kill(payload.pid, 0);
      process.kill(payload.pid, "SIGKILL");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
    lock.removeLock(paths.lockFile, payload.pid);
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

export async function openFleetConsole(deps: OpenFleetConsoleDeps = {}): Promise<OpenFleetConsoleResult> {
  const lifecycle = deps.lifecycle ?? createConsoleDaemonLifecycle();
  await lifecycle.ensureDaemon();
  const status = await lifecycle.probe();
  if (!status.healthy || !status.lock) {
    throw new Error("Fleet Console server is not healthy after ensure");
  }
  const url = `${status.lock.endpoint}console/`;
  // 실행기가 뜨지 않아도 서버는 살아 있다 — 실패를 삼키는 대신 결과로 올려 호출자가
  // "열었다" 대신 주소를 건네게 한다.
  const browser = await (deps.openBrowser ?? openBrowser)(url);
  const result = browser ?? { opened: true };
  return result.opened ? { url, browserOpened: true } : { url, browserOpened: false, browserError: result.reason };
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

export async function runConsoleRestart(deps: ConsoleRestartDeps = {}): Promise<OpenFleetConsoleResult> {
  const lifecycle = deps.lifecycle ?? createConsoleDaemonLifecycle();
  // 기존 데몬을 정지한 뒤 새 데몬을 띄우고 브라우저를 연다.
  await lifecycle.stop();
  return openFleetConsole({ lifecycle, openBrowser: deps.openBrowser });
}

export async function main(): Promise<void> {
  if (process.argv[2] === "serve") {
    await createConsoleDaemonLifecycle().runServer();
    return;
  }
  if (process.argv[2] === "hook") {
    const hookCommand = parseConsoleHookCommand(process.argv.slice(3));
    if (hookCommand.command === "turn-start" || hookCommand.command === "turn-end") {
      // 턴 상태 hook은 항상 무출력·exit 0 best-effort다(hook continuation과 block 출력 금지).
      // 턴 종료(Stop) payload에는 그 시점에 살아 있는 백그라운드 작업 목록도 실려 있다. 같은 POST로 넘겨
      // 서버가 두 축을 한 번에 반영하게 한다 — 따로 보내면 둘 사이의 찰나에 세션이 거짓 유휴로 보인다.
      if (hookCommand.command === "turn-start") {
        await postAgentHook(`/sessions/${readHookSessionId(process.env)}/turn`, { phase: "start" }, process.env);
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
    if (hookCommand.command === "auto-name") {
      // 자동 작명 hook도 무출력·exit 0 best-effort다(stdin prompt를 읽어 서버로 전달만 한다).
      await postAgentHook(`/sessions/${readHookSessionId(process.env)}/auto-name`, { input: await readStdinBestEffort() }, process.env);
      return;
    }
    await postAgentHook(`/sessions/${readHookSessionId(process.env)}/capture`, { provider: hookCommand.provider, input: await readStdinBestEffort() }, process.env);
    return;
  }
  const mode = parseConsoleCliMode(process.argv.slice(2));
  if (mode === "help") {
    process.stdout.write(`${buildConsoleHelpText({ env: process.env, isTTY: process.stdout.isTTY })}\n`);
    return;
  }
  if (mode === "status") {
    process.stdout.write(`${await runConsoleStatus()}\n`);
    return;
  }
  if (mode === "stop") {
    process.stdout.write(`${await runConsoleStop()}\n`);
    return;
  }
  // 두 published bin은 같은 사실을 말해야 한다 — 이 진입점이 결과를 버리면 `fleet console`은
  // 주소를 건네는데 `fleet-console`은 열렸다고만 하는 모순이 남는다.
  if (mode === "restart") {
    const restarted = await runConsoleRestart();
    process.stdout.write(`${describeConsoleLaunch("Fleet Console restarted.", restarted)}\n${await runConsoleStatus()}\n`);
    return;
  }
  const opened = await openFleetConsole();
  process.stdout.write(`${describeConsoleLaunch("Fleet Console opened.", opened)}\n${await runConsoleStatus()}\n`);
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
      await fetch(`${lock.endpoint}plugins/terminal/agent${pathname}`, {
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

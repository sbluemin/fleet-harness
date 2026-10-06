import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  consoleLockInstanceState,
  createConsoleHealthClient,
  deliverConsoleStop,
  isPidAlive,
  observeConsoleInstance,
  observeConsoleLockFile,
  observeConsoleLockFileWithin,
  readConsoleEnding,
  reproveConsoleInstance,
  runStopLadder,
  startProvenStartCapture,
  writeConsoleExitRecord,
  type ConsoleInstanceObservation,
  type ConsoleLockFileObservation,
  type ConsoleLockFilePayload,
  type ConsoleProbeResult,
  type ConsoleStopLadderResult,
} from "@fleet-console/lifecycle";
import { isCompatibleDesktopOwner, type ConsoleOwnerMetadata } from "@fleet-console/protocol/desktop";
import {
  CONSOLE_EXIT_RECORD_VERSION,
  CONSOLE_SERVE_EXIT_LOCK_HELD,
  CONSOLE_START_POLL_MS,
  CONSOLE_START_TIMEOUT_MS,
  INTERACTIVE_PROBE_TIMEOUT_MS,
  KILL_CONFIRM_MS,
  PRELOCK_CHILD_GRACE_MS,
  STOP_POLL_MS,
  describeOwnerlessConsoleLock,
  describeRefusedConsoleLock,
  describeReplacedLockAuthor,
} from "@fleet-console/protocol/lifecycle";

export interface SidecarRuntime { readonly nodePath: string; readonly cliPath: string; readonly serviceRoot: string; readonly serviceVersion: string; }
/** The supervisor's time source. Every wait derives from the lifecycle contract's budgets; a test may advance it faster. */
export interface SidecarClock { now(): number; sleep(ms: number): Promise<void>; }
export interface SidecarSupervisorOptions {
  readonly nodePath?: string;
  readonly cliPath?: string;
  readonly serviceRoot?: string;
  readonly serviceVersion: string;
  readonly resolveRuntime?: () => Promise<SidecarRuntime>;
  readonly env: NodeJS.ProcessEnv;
  readonly lockFile: string;
  readonly ownerId: string;
  readonly clock?: SidecarClock;
  /**
   * Injectable for the Windows-only stop path (a test may prove it on another host). Defaults to the host platform;
   * the stop decision itself stays in the lifecycle contract's single rule.
   */
  readonly platform?: NodeJS.Platform;
  /**
   * Released runtimes only. A Console release that predates the lock reclaim protocol (see isPreReclaimConsoleVersion)
   * cannot clear the lock an exited Console left, so for that runtime alone this Desktop still clears it itself.
   * Development runtimes carry the repository's version, which says nothing about the code, so they never take this path.
   */
  readonly legacyLockCleanup?: boolean;
  readonly log: { info(message: string): void; error(message: string): void };
}

/** How a sidecar ended: its exit status and the outcome its exit record names (null when it left none). */
export interface SidecarEnding { readonly pid: number; readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly outcome: string | null; }

/** A startup failure with text for the user. `detail` is read when the failure is shown, after the sidecar's stderr is in. */
export class SidecarStartError extends Error {
  constructor(code: string, private readonly readDetail: () => string, readonly ending: SidecarEnding | null = null) { super(code); }
  get detail(): string { return this.readDetail(); }
}

/** What the supervisor saw about the process that holds the Console lock when it refused to adopt, start beside, or stop it. */
export interface SidecarLockDiagnostic {
  readonly pid: number;
  readonly lockFile: string;
  /** The lifecycle contract's observed state, or `untrusted` for a lock that failed the trust checks. */
  readonly observed: string;
  readonly reason: string;
}
export type SidecarLockConflictCode = "cli_daemon_requires_confirmation" | "console_lock_process_unverified" | "console_lock_foreign_process_unhealthy" | "console_lock_process_unhealthy";
/** The message stays the bare code the boot dialogs match on; the diagnostic carries the data behind it. */
export class SidecarLockConflictError extends Error {
  constructor(code: SidecarLockConflictCode, readonly diagnostic: SidecarLockDiagnostic) { super(code); }
}

interface LockPayload extends ConsoleLockFilePayload { readonly owner?: ConsoleOwnerMetadata; }
interface StoredLock { readonly bytes: Buffer; readonly lock: LockPayload; }
/** One reading of the lock through the contract's observer, plus this Desktop's adoption checks (version, owner). */
type LockRead =
  | { readonly kind: "absent" }
  | { readonly kind: "blocked"; readonly code: "console_lock_refused" | "console_lock_ownerless"; readonly detail: string }
  | { readonly kind: "untrusted"; readonly bytes: Buffer; readonly pid: number; readonly alive: boolean; readonly issue: string }
  | { readonly kind: "trusted"; readonly stored: StoredLock; readonly alive: boolean };
type SlotDecision = { readonly kind: "adopt"; readonly url: string } | { readonly kind: "ready" } | { readonly kind: "changed" };
/**
 * What a stop requested by this Desktop targets: the pid, the lock instance it published when known (an own child that
 * gave up before its lock was read has none), and the `lifecycleWire` and `stopRequest` its health reported, for
 * reading how it ended and for choosing the Windows stop path.
 */
interface StopTarget { readonly pid: number; readonly lock?: LockPayload; readonly lifecycleWire?: unknown; readonly stopRequest?: unknown; }

// Each pass either adopts, finds the slot ready, or ends a Console this Desktop owns; more passes mean the slot keeps changing.
const SLOT_PASSES = 4;
const STDERR_TAIL_CHARS = 4_000;
/** The newest Fleet Console release whose serve publishes its lock with O_EXCL alone and never reclaims a dead one. */
const LAST_PRE_RECLAIM_CONSOLE_VERSION = [1, 212, 0] as const;
const SYSTEM_CLOCK: SidecarClock = { now: () => performance.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

/**
 * Whether a Console version is certainly a release from before the lock reclaim protocol. Only a plain release version
 * (major.minor.patch) at or below the last such release counts. A prerelease, build metadata, an empty or unrecognized
 * version is not certain, and an uncertain runtime takes the reclaim path.
 */
export function isPreReclaimConsoleVersion(version: string): boolean {
  const match = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.exec(version);
  if (!match) return false;
  for (let index = 0; index < 3; index += 1) {
    const part = Number(match[index + 1]);
    const last = LAST_PRE_RECLAIM_CONSOLE_VERSION[index]!;
    if (part !== last) return part < last;
  }
  return true;
}

/**
 * Starts, adopts, and quits this Desktop's Console under the single lifecycle contract (docs/console-lifecycle-contract.md):
 * the lock and the instance are read through the contract's observer, every wait derives from its budgets, and a signal
 * goes only to a process whose identity is proven — an unreaped own child (E1), or an authenticated health answer with
 * its process start time (E3 + E4).
 */
export class SidecarSupervisor {
  private child: ChildProcess | null = null;
  /** The lock the current child published and the `lifecycleWire` and `stopRequest` it answered with, once seen. */
  private childLock: LockPayload | null = null;
  private childLifecycleWire: unknown = undefined;
  private childStopRequest: unknown = undefined;
  /** The own child this Desktop is stopping: its ending is reported once, by the stop that ends it, not by its exit handler. */
  private stoppingChild: ChildProcess | null = null;
  private serviceVersion: string;
  private readonly clock: SidecarClock;
  constructor(private readonly options: SidecarSupervisorOptions) {
    this.serviceVersion = options.serviceVersion;
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }
  /**
   * Adopts this Desktop's running Console or starts one. This Desktop never removes a Console lock: the Console it starts
   * reclaims a lock whose pid has exited, under Console's reclaim protocol.
   * 살아 있는 소유자는 아직 초기화·정리 중일 수 있으므로 lock이 없거나 pid가 끝났을 때만 시작한다.
   * 런타임 조달은 길어질 수 있어, 조달 뒤에도 slot을 다시 판정한다.
   */
  async startOrAdopt(): Promise<string> {
    let runtime: SidecarRuntime | null = null;
    for (let pass = 0; ; pass += 1) {
      const slot = await this.prepareSlot(runtime);
      if (slot.kind === "adopt") return slot.url;
      if (slot.kind === "ready" && runtime) break;
      if (pass + 1 >= SLOT_PASSES) throw new Error("console_lock_changed_before_start");
      runtime ??= await this.resolveRuntime();
    }
    return this.launch(runtime);
  }
  private async prepareSlot(runtime: SidecarRuntime | null): Promise<SlotDecision> {
    const read = await this.readLockSettled();
    if (read.kind === "absent") return { kind: "ready" };
    if (read.kind === "blocked") throw new SidecarStartError(read.code, () => read.detail);
    if (read.kind === "untrusted") {
      // No Console writes such a lock and its endpoint cannot be asked, so a live pid behind it proves nothing.
      if (read.alive) throw this.conflict("console_lock_process_unverified", read.pid, "untrusted", `the lock cannot be trusted (${read.issue})`);
      return this.leaveExitedLock(read.bytes, read.pid, runtime);
    }
    const { stored } = read;
    const { pid } = stored.lock;
    if (!read.alive) return this.leaveExitedLock(stored.bytes, pid, runtime);
    const owned = this.isOwned(stored.lock);
    if (this.isOwnLiveChild(pid)) {
      // This Desktop's unreaped child: its handle proves identity (E1), so it is adopted when it answers and ended otherwise.
      const own = await this.observe(stored.lock);
      if (owned && this.answersFor(own.probe, pid)) return { kind: "adopt", url: consoleUrl(stored.lock) };
      await this.stopRequested({ pid, lock: stored.lock, lifecycleWire: own.probe?.health?.lifecycleWire ?? this.childLifecycleWire, stopRequest: own.probe?.stopRequest ?? this.childStopRequest }, null);
      return { kind: "changed" };
    }
    let observed = await this.observe(stored.lock);
    // An instance still starting is waited for within the contract's start budget, never adopted or signalled meanwhile.
    const startDeadline = this.clock.now() + CONSOLE_START_TIMEOUT_MS;
    while (observed.state === "starting" && this.clock.now() < startDeadline) {
      await this.clock.sleep(CONSOLE_START_POLL_MS);
      observed = await this.observe(stored.lock);
    }
    if (observed.state === "exited") return this.leaveExitedLock(stored.bytes, pid, runtime);
    // Another program reused an ended Console's pid: a start-time comparison may block a start, never allow one, so no
    // serve starts beside it while that pid runs (the same verdict serve and the CLI reach). A lock problem, not a conflict.
    if (observed.state === "replaced") {
      const detail = describeReplacedLockAuthor(this.options.lockFile, pid);
      this.options.log.error(`console_lock_held: ${detail.split("\n")[0]}`);
      throw new SidecarStartError("console_lock_held", () => detail);
    }
    // The lock changed or went while it was observed: the next pass reads the slot again.
    if (observed.state === "releasing") return { kind: "changed" };
    if (observed.state === "stopping") {
      // A Console that closed its listener and still holds the lock is cleaning up shared state, whoever stops it: starting
      // another beside it would let two Consoles write the same data. Wait for it without a signal.
      const ended = await this.waitForOthersStop(stored);
      if (ended === "held") throw this.conflict("console_lock_process_unverified", pid, "stopping", "it closed its listener but kept the lock past the stop budget");
      return { kind: "changed" };
    }
    if (this.answersFor(observed.probe, pid)) {
      if (owned) return { kind: "adopt", url: consoleUrl(stored.lock) };
      // 시작 경로는 같은 Desktop 소유 sidecar만 채택한다. 외부 런타임 페어링은
      // Console handoff 이후 사용자가 네이티브 메뉴에서 명시적으로 요청할 때만 수행한다.
      throw this.conflict("cli_daemon_requires_confirmation", pid, observed.state, "another owner's Console answered as healthy");
    }
    // 타 소유의 살아 있는 잠금은 신호를 보내지 않고 별도 충돌로 종료한다.
    if (!owned) throw this.conflict("console_lock_foreign_process_unhealthy", pid, observed.state, "another owner's Console did not answer as healthy");
    // 살아 있는 lock pid가 정체를 증명하지 못했다(멈춘 이전 sidecar일 수도, pid를 물려받은 무관한 프로세스일 수도 있다).
    // 신호는 무관한 프로세스를 죽일 수 있고 lock을 지우면 살아 있는 Console 옆에 두 번째 소유자가 생기므로 둘 다 하지 않는다.
    throw this.conflict("console_lock_process_unverified", pid, observed.state, observed.state === "starting" ? "it kept starting past the start budget" : "it did not prove it is the Console");
  }
  /**
   * The lock's pid has exited. The Console about to start reclaims it, so it stays. Only a runtime that is certainly a
   * pre-reclaim release, which cannot reclaim it, gets the old same-contents removal.
   */
  private leaveExitedLock(bytes: Buffer, pid: number, runtime: SidecarRuntime | null): SlotDecision {
    if (runtime === null) return { kind: "ready" };
    if (this.options.legacyLockCleanup === true && isPreReclaimConsoleVersion(runtime.serviceVersion)) {
      this.removeLegacyStaleLock(bytes);
      this.options.log.info(`removed the lock left by exited pid ${pid}: Console ${runtime.serviceVersion} cannot reclaim it`);
      return { kind: "ready" };
    }
    this.options.log.info(`left the lock of exited pid ${pid} in place for the starting Console to reclaim`);
    return { kind: "ready" };
  }
  private async launch(runtime: SidecarRuntime): Promise<string> {
    let startupFailure: Error | null = null;
    let sidecarReady = false;
    let stderrTail = "";
    this.childLock = null;
    this.childLifecycleWire = undefined;
    this.childStopRequest = undefined;
    try {
      this.child = spawn(runtime.nodePath, [runtime.cliPath, "serve"], { cwd: path.dirname(path.dirname(runtime.cliPath)), env: this.options.env, stdio: ["ignore", "pipe", "pipe"], detached: false, windowsHide: true });
    } catch (error) {
      throw this.createSpawnFailure(error);
    }
    const child = this.child;
    child.stdout?.on("data", (chunk: Buffer) => this.options.log.info(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
      this.options.log.error(text);
    });
    const readStderrTail = () => stderrTail.trim();
    child.once("error", (error) => {
      const failure = sidecarReady ? new Error(`sidecar_runtime_error: ${error.message}`) : this.createSpawnFailure(error);
      if (!sidecarReady) startupFailure = failure;
      this.options.log.error(failure.message);
    });
    child.once("exit", (code, signal) => {
      const ending = this.readEnding(child, code, signal);
      if (this.child === child) this.child = null;
      const summary = `code=${code ?? "null"} signal=${signal ?? "null"}`;
      if (!sidecarReady && code === CONSOLE_SERVE_EXIT_LOCK_HELD) {
        // The Console did not take the lock and left it as it was; its stderr says who holds it or how to recover.
        startupFailure ??= new SidecarStartError("console_lock_held", readStderrTail, ending);
        this.options.log.error(`console_lock_held: the sidecar exited without taking ${this.options.lockFile} (${summary})`);
        return;
      }
      const failureCode = `${sidecarReady ? "sidecar_exited" : "sidecar_exited_before_ready"}: ${summary}`;
      const failure = sidecarReady ? new Error(failureCode) : new SidecarStartError(failureCode, readStderrTail, ending);
      if (!sidecarReady) startupFailure ??= failure;
      // A child this Desktop is stopping is reported by that stop, which reads its record after any forced-external write.
      if (this.stoppingChild === child) {
        this.options.log.info(`${failure.message} (stop requested)`);
        return;
      }
      // An unknown or missing record is never reported as a clean stop.
      this.options.log.error(`${failure.message} outcome=${ending?.outcome ?? "unrecorded"}`);
    });
    const deadline = this.clock.now() + CONSOLE_START_TIMEOUT_MS;
    try {
      for (;;) {
        if (startupFailure) throw startupFailure;
        if (this.clock.now() >= deadline) throw new Error("sidecar_readiness_timeout");
        await this.clock.sleep(CONSOLE_START_POLL_MS);
        if (startupFailure) throw startupFailure;
        // Until the new Console publishes, the lock can be absent, the exited Console's lock awaiting reclaim, or briefly
        // unreadable while it is published in place. None of that is a failure; the child's own exit is.
        const read = this.readLock();
        if (read.kind !== "trusted" || !read.alive) continue;
        const { lock } = read.stored;
        const own = lock.pid === child.pid;
        if (own) this.childLock = lock;
        const answer = await this.probe(lock);
        if (!this.answersFor(answer, lock.pid)) continue;
        if (own) this.childLifecycleWire = answer.health?.lifecycleWire;
        if (own) this.childStopRequest = answer.stopRequest;
        if (!this.isOwned(lock)) throw this.conflict("cli_daemon_requires_confirmation", lock.pid, "ready", "another owner's Console took the lock and answered as healthy");
        sidecarReady = true;
        return consoleUrl(lock);
      }
    } catch (error) {
      throw await this.failStartup(error);
    }
  }
  /**
   * Startup is giving up on its own child, which does not end with this process. A child that holds the lock may be
   * writing durable state, so it gets the stop ladder and its own deadline; one that has not taken the lock has written
   * nothing and gets only a short grace. The unreaped child handle proves its identity throughout.
   */
  private async failStartup(error: unknown): Promise<Error> {
    const failure = error instanceof Error ? error : new Error(String(error));
    const child = this.child;
    if (!child || child.pid === undefined || !this.isOwnLiveChild(child.pid)) return failure;
    const pid = child.pid;
    try {
      if (consoleLockInstanceState(this.options.lockFile, { pid }) === "held") {
        const read = this.readLock();
        const lock = read.kind === "trusted" && read.stored.lock.pid === pid ? read.stored.lock : this.childLock;
        // A starting child answers 503, which still carries the stop request advertisement: ask it through the route
        // when it does, so its cleanup runs instead of a signal ending it.
        const answer = lock ? await this.probe(lock) : null;
        await this.stopRequested({ pid, ...(lock ? { lock } : {}), lifecycleWire: answer?.health?.lifecycleWire ?? this.childLifecycleWire, stopRequest: answer?.stopRequest ?? this.childStopRequest }, null);
      } else {
        this.stoppingChild = child;
        signalPid(pid, "SIGTERM");
        if (!await this.waitUntil(() => !this.isOwnLiveChild(pid), PRELOCK_CHILD_GRACE_MS)) {
          signalPid(pid, "SIGKILL");
          await this.waitUntil(() => !this.isOwnLiveChild(pid), KILL_CONFIRM_MS);
        }
      }
    } catch (cleanupError) {
      this.options.log.error(`sidecar_cleanup_failed: pid ${pid}: ${this.describeError(cleanupError)}`);
    } finally {
      if (this.stoppingChild === child) this.stoppingChild = null;
    }
    return failure;
  }
  /** Quit. Never removes the lock: a lock left by an exited Console is reclaimed by the next Console that starts. */
  async stop(): Promise<void> {
    const read = this.readLock();
    if (read.kind !== "trusted") return;
    const { lock } = read.stored;
    if (!this.isOwned(lock)) return;
    const { pid } = lock;
    if (!read.alive) {
      this.options.log.info(`left the lock of exited pid ${pid} in place for the next Console to reclaim`);
      return;
    }
    // 재증명 실패나 강제 종료 실패는 기록하되 Quit 자체는 막지 않는다. lock 해제 뒤 잔존 구간에는 신호를 보내지 않는다.
    try {
      if (this.isOwnLiveChild(pid)) {
        await this.stopRequested({ pid, lock, lifecycleWire: this.childLifecycleWire, stopRequest: this.childStopRequest }, null);
        return;
      }
      // The wall-clock moment identity is about to be proven: only a process that started before it can be that Console.
      // The start-time proof starts now but is awaited only at escalation, so a slow reader never delays the request.
      const provenAt = Date.now();
      const observed = await this.observe(lock);
      if (observed.identity !== "verified") {
        // Unverified: a signal could hit an unrelated process. Stopping or releasing: someone else's stop is already under
        // way, and Quit has nothing to do after waiting for it, so it returns without a signal.
        this.options.log.error(`console_lock_process_${observed.state}: pid ${pid} holds ${this.options.lockFile}; left running without a signal`);
        return;
      }
      const capture = startProvenStartCapture(pid, provenAt, this.options.env);
      try {
        await this.stopRequested({ pid, lock, lifecycleWire: observed.probe?.health?.lifecycleWire, stopRequest: observed.probe?.stopRequest }, capture.provenStart);
      } finally {
        capture.abort();
      }
    } catch (error) {
      this.options.log.error(`console_lock_process_unhealthy: pid ${pid} could not be stopped; continuing Quit: ${this.describeError(error)}`);
    }
  }
  /**
   * The stop ladder for a Console this Desktop asks to stop (docs/console-lifecycle-contract.md, "Stop ladder"): one
   * SIGTERM, a wait of EXTERNAL_ESCALATION_MS for its exit or its lock's release, and SIGKILL only while the same lock is
   * still held and identity is proven again. A lock that cannot be read counts as held.
   */
  private async stopRequested(target: StopTarget, provenStart: number | null | Promise<number | null>): Promise<ConsoleStopLadderResult> {
    const { pid, lock } = target;
    const own = this.child !== null && this.child.pid === pid ? this.child : null;
    if (own) this.stoppingChild = own;
    try {
      return await this.runRequestedStop(target, provenStart);
    } finally {
      if (own && this.stoppingChild === own) this.stoppingChild = null;
    }
  }
  private async runRequestedStop(target: StopTarget, provenStart: number | null | Promise<number | null>): Promise<ConsoleStopLadderResult> {
    const { pid, lock } = target;
    const instance = { pid, ...(lock ? { token: lock.token } : {}) };
    // On Windows a Console that advertises the stop request route is asked through it, so its cleanup runs and its
    // exit record says clean; anywhere else this stop signals as before. The ladder starts after the POST ends, so
    // its clock never includes the request. Without a lock there is no token to ask with.
    const request = lock
      ? await deliverConsoleStop({
        lock: { pid, endpoint: lock.endpoint, token: lock.token },
        stopRequest: target.stopRequest,
        timeoutMs: INTERACTIVE_PROBE_TIMEOUT_MS,
        platform: this.options.platform ?? process.platform,
        observe: () => this.observe(lock).then((observation) => observation.state),
      })
      : "signal";
    const ended = await runStopLadder({
      request,
      isAlive: () => isPidAlive(pid),
      isReleased: () => consoleLockInstanceState(this.options.lockFile, instance) === "released",
      // An own child that gave up before its lock was read is proven only by its unreaped handle (E1).
      reprove: () => lock
        ? reproveConsoleInstance({ lockFile: this.options.lockFile, lock, provenStart, isOwnChild: () => this.isOwnLiveChild(pid), observe: (target) => this.observe(target) })
        : Promise.resolve(this.isOwnLiveChild(pid)),
      signal: (signal) => signalPid(pid, signal),
      now: () => this.clock.now(),
      sleep: (ms) => this.clock.sleep(ms),
    });
    const key = lock ? { pid, lockStartedAt: lock.startedAt } : null;
    // A Console that recorded its own ending (its deadline) as the SIGKILL landed keeps that record: it is the outcome.
    let forcedRecorded = ended === "forced";
    if (ended === "forced" && key) {
      try {
        forcedRecorded = writeConsoleExitRecord(this.options.lockFile, { v: CONSOLE_EXIT_RECORD_VERSION, ...key, outcome: "forced-external", killed: 0, at: Date.now() });
      } catch {
        // The record only informs later readers; this ladder's own result still says the stop was forced.
      }
    }
    const outcome = forcedRecorded
      ? "forced-external"
      : ended !== "exited" && ended !== "forced" ? null : key ? readConsoleEnding(this.options.lockFile, key, { lifecycleWire: target.lifecycleWire, terminatedByReader: request === "signal" }).outcome : "unrecorded";
    const line = `console_stop: pid ${pid} ${request} ${ended}${outcome === null ? "" : ` outcome=${outcome}`}`;
    // Only a recorded clean shutdown is reported as one; no record, an unknown one, or an external ending is not.
    if (outcome === "clean") this.options.log.info(line);
    else this.options.log.error(line);
    if (ended === "unproven") throw this.conflict("console_lock_process_unverified", pid, "unverified", "its identity could not be proven again before SIGKILL; no further signal sent");
    if (ended === "kill-failed") throw this.conflict("console_lock_process_unhealthy", pid, "stopping", "it outlived SIGKILL");
    return ended;
  }
  /** Someone else's stop, or a Console that stops itself: only waits, never signals, up to EXTERNAL_ESCALATION_MS. */
  private waitForOthersStop(stored: StoredLock): Promise<ConsoleStopLadderResult> {
    const { pid, token } = stored.lock;
    return runStopLadder({
      request: "none",
      isAlive: () => isPidAlive(pid),
      isReleased: () => consoleLockInstanceState(this.options.lockFile, { pid, token }) === "released",
      reprove: async () => false,
      signal: () => {},
      now: () => this.clock.now(),
      sleep: (ms) => this.clock.sleep(ms),
    });
  }
  private observe(lock: LockPayload): Promise<ConsoleInstanceObservation<LockPayload>> {
    const { pid, token } = lock;
    return observeConsoleInstance({
      lock,
      trusted: true,
      isHeld: () => consoleLockInstanceState(this.options.lockFile, { pid, token }) !== "released",
      probe: (lock, options) => createConsoleHealthClient().probe(lock, options),
      probeTimeoutMs: INTERACTIVE_PROBE_TIMEOUT_MS,
    });
  }
  private probe(lock: LockPayload) {
    return createConsoleHealthClient().probe(lock, { timeoutMs: INTERACTIVE_PROBE_TIMEOUT_MS });
  }
  /**
   * Whether the lock's own pid answered the authenticated health probe: the condition to adopt or report readiness.
   * Adoption sends no signal, so a Console reporting a newer lifecycle wire is still adopted when its owner is compatible.
   */
  private answersFor(probe: ConsoleProbeResult<LockPayload> | null, pid: number): boolean {
    return probe !== null && probe.healthy && probe.health?.pid === pid;
  }
  private isOwnLiveChild(pid: number): boolean {
    const child = this.child;
    return child !== null && child.pid === pid && child.exitCode === null && child.signalCode === null;
  }
  /** The child's exit status and how it ended (its exit record, or the contract's reading of none), once it is gone. */
  private readEnding(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): SidecarEnding | null {
    if (child.pid === undefined) return null;
    if (this.stoppingChild === child) return { pid: child.pid, code, signal, outcome: null };
    const lock = this.child === child && this.childLock?.pid === child.pid ? this.childLock : null;
    const outcome = lock === null
      ? null
      : readConsoleEnding(this.options.lockFile, { pid: child.pid, lockStartedAt: lock.startedAt }, { lifecycleWire: this.childLifecycleWire, terminatedByReader: false }).outcome;
    return { pid: child.pid, code, signal, outcome };
  }
  /** Reads the lock once. Sends no signal and asks no endpoint. Follows no symlink and reads no other user's lock. */
  private readLock(): LockRead {
    return this.toLockRead(observeConsoleLockFile<LockPayload>(this.options.lockFile));
  }
  /** Re-reads a lock without a readable owner for LOCK_OBSERVE_BUDGET_MS. Elapsed time is never evidence that its writer is gone. */
  private async readLockSettled(): Promise<LockRead> {
    return this.toLockRead(await observeConsoleLockFileWithin<LockPayload>(this.options.lockFile));
  }
  private toLockRead(observed: ConsoleLockFileObservation<LockPayload>): LockRead {
    const { lockFile } = this.options;
    if (observed.kind === "absent") return observed;
    if (observed.kind === "refused") return { kind: "blocked", code: "console_lock_refused", detail: describeRefusedConsoleLock(lockFile, observed.reason) };
    if (observed.kind === "unknown") return { kind: "blocked", code: "console_lock_ownerless", detail: describeOwnerlessConsoleLock(lockFile, observed.reason) };
    const { instance, alive } = observed;
    const issue = observed.untrusted ?? adoptionPolicyIssue(instance.payload);
    if (issue !== null) return { kind: "untrusted", bytes: instance.bytes, pid: instance.pid, alive, issue };
    return { kind: "trusted", stored: { bytes: instance.bytes, lock: instance.payload }, alive };
  }
  /**
   * Pre-reclaim runtimes only (leaveExitedLock): such a Console publishes with O_EXCL and never reclaims, so the lock an
   * exited Console left is cleared here, and only while it still has the same bytes. This removal takes no part in the
   * reclaim protocol; retire it when the oldest runtime Desktop starts includes that protocol.
   */
  private removeLegacyStaleLock(bytes: Buffer): void {
    const current = observeConsoleLockFile(this.options.lockFile);
    if (current.kind === "absent") return;
    if (current.kind !== "owner" || !current.instance.bytes.equals(bytes)) throw new Error("console_lock_changed_before_cleanup");
    try {
      fs.unlinkSync(this.options.lockFile);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return;
      throw new Error(`console_lock_cleanup_failed: ${this.describeError(error)}`);
    }
  }
  private async waitUntil(done: () => boolean, budgetMs: number): Promise<boolean> {
    const deadline = this.clock.now() + budgetMs;
    for (;;) {
      if (done()) return true;
      if (this.clock.now() >= deadline) return false;
      await this.clock.sleep(STOP_POLL_MS);
    }
  }
  private conflict(code: SidecarLockConflictCode, pid: number, observed: string, reason: string): SidecarLockConflictError {
    const diagnostic = { pid, lockFile: this.options.lockFile, observed, reason };
    this.options.log.error(`${code}: pid ${pid} holds ${this.options.lockFile} (${observed}): ${reason}`);
    return new SidecarLockConflictError(code, diagnostic);
  }
  private isOwned(lock: LockPayload): boolean { return isCompatibleDesktopOwner(lock.owner, lock.version, { id: this.options.ownerId, version: this.serviceVersion }); }
  private async resolveRuntime(): Promise<SidecarRuntime> {
    const runtime = this.options.resolveRuntime
      ? await this.options.resolveRuntime()
      : this.options.nodePath && this.options.cliPath && this.options.serviceRoot
        ? { nodePath: this.options.nodePath, cliPath: this.options.cliPath, serviceRoot: this.options.serviceRoot, serviceVersion: this.options.serviceVersion }
        : undefined;
    if (!runtime) throw new Error("sidecar_runtime_resolver_missing");
    this.serviceVersion = runtime.serviceVersion;
    return runtime;
  }
  private createSpawnFailure(error: unknown): Error { return new Error(`sidecar_spawn_failed: ${error instanceof Error ? error.message : String(error)}`); }
  private describeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
/** Only ESRCH means the target is already gone; any other failure to signal is reported. */
function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (errnoOf(error) !== "ESRCH") throw error;
  }
}
function consoleUrl(lock: LockPayload): string { return new URL("console/", lock.endpoint).toString(); }
function errnoOf(error: unknown): string | undefined { return (error as NodeJS.ErrnoException | null)?.code; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isConsoleOwnerMetadata(value: unknown): value is ConsoleOwnerMetadata { return isRecord(value) && (value.kind === "cli" || value.kind === "desktop") && typeof value.id === "string" && value.id.length > 0 && Number.isSafeInteger(value.protocolVersion); }
/** This Desktop's adoption checks on top of the contract's trust checks: a version to compare and a well-formed owner. */
function adoptionPolicyIssue(payload: LockPayload): string | null {
  if (typeof payload.version !== "string" || payload.version.length === 0) return "it has no version";
  if (payload.owner !== undefined && !isConsoleOwnerMetadata(payload.owner)) return "invalid owner";
  return null;
}

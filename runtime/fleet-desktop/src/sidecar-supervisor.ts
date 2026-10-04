import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  CONSOLE_SERVE_EXIT_LOCK_HELD,
  classifyConsoleLockContent,
  describeOwnerlessConsoleLock,
  describeRefusedConsoleLock,
  identifyConsoleLockOwner,
  isCompatibleDesktopOwner,
  type ConsoleLockHealthEvidence,
  type ConsoleLockOwnerIdentity,
  type ConsoleOwnerMetadata,
} from "@fleet-console/protocol/desktop";

export interface SidecarRuntime { readonly nodePath: string; readonly cliPath: string; readonly serviceRoot: string; readonly serviceVersion: string; }
export interface SidecarSupervisorOptions {
  readonly nodePath?: string;
  readonly cliPath?: string;
  readonly serviceRoot?: string;
  readonly serviceVersion: string;
  readonly resolveRuntime?: () => Promise<SidecarRuntime>;
  readonly env: NodeJS.ProcessEnv;
  readonly lockFile: string;
  readonly ownerId: string;
  /**
   * Released runtimes only. A Console release that predates the lock reclaim protocol (see isPreReclaimConsoleVersion)
   * cannot clear the lock an exited Console left, so for that runtime alone this Desktop still clears it itself.
   * Development runtimes carry the repository's version, which says nothing about the code, so they never take this path.
   */
  readonly legacyLockCleanup?: boolean;
  readonly log: { info(message: string): void; error(message: string): void };
}

/** A startup failure with text for the user. `detail` is read when the failure is shown, after the sidecar's stderr is in. */
export class SidecarStartError extends Error {
  constructor(code: string, private readonly readDetail: () => string) { super(code); }
  get detail(): string { return this.readDetail(); }
}

interface LockPayload { readonly pid: number; readonly endpoint: string; readonly token: string; readonly version: string; readonly owner?: ConsoleOwnerMetadata; }
interface StoredLock { readonly contents: string; readonly lock: LockPayload; }
/**
 * One reading of the lock, classified the way Console's own lock does. Only a lock with a readable pid has an owner whose
 * exit can be observed; a symlink or another user's lock is refused, and anything without a readable owner is kept.
 */
type LockObservation =
  | { readonly kind: "absent" }
  | { readonly kind: "blocked"; readonly code: "console_lock_refused" | "console_lock_ownerless"; readonly detail: string }
  | { readonly kind: "untrusted"; readonly contents: string; readonly pid: number; readonly issue: string }
  | { readonly kind: "trusted"; readonly stored: StoredLock };
interface MissingLockProbe { readonly kind: "missing"; }
interface BlockedLockProbe { readonly kind: "blocked"; readonly code: "console_lock_refused" | "console_lock_ownerless"; readonly detail: string; }
interface UntrustedLockProbe { readonly kind: "untrusted"; readonly contents: string; readonly pid: number; readonly issue: string; }
interface UnhealthyLockProbe { readonly kind: "unhealthy"; readonly stored: StoredLock; readonly health: ConsoleLockHealthEvidence; }
interface HealthyLockProbe { readonly kind: "healthy"; readonly stored: StoredLock; readonly url: string; readonly health: ConsoleLockHealthEvidence; }
type LockProbe = MissingLockProbe | BlockedLockProbe | UntrustedLockProbe | UnhealthyLockProbe | HealthyLockProbe;
type StartLockProbe = Exclude<LockProbe, UnhealthyLockProbe> | (UnhealthyLockProbe & { readonly lingering?: true });
type SlotDecision = { readonly kind: "adopt"; readonly url: string } | { readonly kind: "ready" } | { readonly kind: "changed" };
type TerminationOutcome = "exited" | "closing" | "unverified";

const STARTUP_ATTEMPTS = 40;
const STARTUP_DELAY_CAP_MS = 1_000;
const STOP_ATTEMPTS = 30;
const STOP_DELAY_MS = 100;
// 종료 중인 Console은 listener를 먼저 닫고 plugin·execution·MCP 정리를 마친 뒤에야 lock을 놓는다. 그 정리를 덮는 대기 한도.
const SHUTDOWN_SETTLE_MS = 10_000;
// Console's own lock re-reads an ownerless lock for the same budget: a lock published in place can be briefly empty.
const OWNERLESS_OBSERVE_MS = 2_000;
const OWNERLESS_REREAD_MS = 50;
// Each pass either adopts, finds the slot ready, or ends a Console this Desktop owns; more passes mean the slot keeps changing.
const SLOT_PASSES = 4;
const STDERR_TAIL_CHARS = 4_000;
/** The newest Fleet Console release whose serve publishes its lock with O_EXCL alone and never reclaims a dead one. */
const LAST_PRE_RECLAIM_CONSOLE_VERSION = [1, 212, 0] as const;

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

export class SidecarSupervisor {
  private child: ChildProcess | null = null;
  private serviceVersion: string;
  constructor(private readonly options: SidecarSupervisorOptions) { this.serviceVersion = options.serviceVersion; }
  /**
   * Adopts this Desktop's running Console or starts one. This Desktop never removes a Console lock: the Console it starts
   * reclaims a lock whose pid has exited, under Console's reclaim protocol. It starts one only when the lock is absent or
   * its pid has exited, because a starting Console touches shared state before it takes the lock. The slot is judged once
   * more after the runtime is resolved, since procurement can take long.
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
    const current = await this.probeForStart();
    if (current.kind === "missing") return { kind: "ready" };
    if (current.kind === "blocked") throw new SidecarStartError(current.code, () => current.detail);
    if (current.kind === "healthy") {
      if (this.isOwned(current.stored.lock)) return { kind: "adopt", url: current.url };
      // 시작 경로는 같은 Desktop 소유 sidecar만 채택한다. 외부 런타임 페어링은
      // Console handoff 이후 사용자가 네이티브 메뉴에서 명시적으로 요청할 때만 수행한다.
      throw new Error("cli_daemon_requires_confirmation");
    }
    if (current.kind === "untrusted") {
      // No Console writes such a lock and its endpoint cannot be asked, so a live pid behind it proves nothing.
      if (this.isProcessAlive(current.pid)) {
        this.options.log.error(`console_lock_process_unverified: pid ${current.pid} holds ${this.options.lockFile}, which cannot be trusted (${current.issue})`);
        throw new Error("console_lock_process_unverified");
      }
      return this.leaveExitedLock(current.contents, current.pid, runtime);
    }
    const { pid } = current.stored.lock;
    const identity = current.lingering ? "unverified" : this.identifyLockProcess(current);
    if (identity === "absent") {
      // A refused endpoint with a live pid can be a Console still cleaning up: only an exited pid frees the slot.
      if (this.isProcessAlive(pid)) {
        this.options.log.error(`console_lock_process_unverified: pid ${pid} holds ${this.options.lockFile} but did not prove it is the Console`);
        throw new Error("console_lock_process_unverified");
      }
      return this.leaveExitedLock(current.stored.contents, pid, runtime);
    }
    if (!this.isOwned(current.stored.lock)) {
      // 타 소유의 살아 있는 잠금은 신호를 보내지 않고 별도 충돌로 종료한다.
      throw new Error("console_lock_foreign_process_unhealthy");
    }
    if (identity === "unverified") {
      // 살아 있는 lock pid가 정체를 증명하지 못했다(멈춘 이전 sidecar일 수도, pid를 물려받은 무관한 프로세스일 수도 있다).
      // 신호는 무관한 프로세스를 죽일 수 있고 lock을 지우면 살아 있는 Console 옆에 두 번째 소유자가 생기므로 둘 다 하지 않는다.
      this.options.log.error(`console_lock_process_unverified: pid ${pid} holds ${this.options.lockFile} but did not prove it is the Console`);
      throw new Error("console_lock_process_unverified");
    }
    const outcome = await this.terminateVerifiedProcess(current.stored);
    if (outcome === "closing" && !await this.waitForExit(pid, SHUTDOWN_SETTLE_MS)) {
      this.options.log.error(`console_lock_process_unverified: pid ${pid} closed its listener after SIGTERM but did not exit; no second Console was started`);
      throw new Error("console_lock_process_unverified");
    }
    if (outcome === "unverified") throw new Error("console_lock_process_unverified");
    // The Console has exited. It released its lock itself, or the next pass finds a dead lock for the new Console to reclaim.
    return { kind: "changed" };
  }
  /**
   * The lock's pid has exited. The Console about to start reclaims it, so it stays. Only a runtime that is certainly a
   * pre-reclaim release, which cannot reclaim it, gets the old same-contents removal.
   */
  private leaveExitedLock(contents: string, pid: number, runtime: SidecarRuntime | null): SlotDecision {
    if (runtime === null) return { kind: "ready" };
    if (this.options.legacyLockCleanup === true && isPreReclaimConsoleVersion(runtime.serviceVersion)) {
      this.removeLegacyStaleLock(contents);
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
      if (this.child === child) this.child = null;
      const summary = `code=${code ?? "null"} signal=${signal ?? "null"}`;
      if (!sidecarReady && code === CONSOLE_SERVE_EXIT_LOCK_HELD) {
        // The Console did not take the lock and left it as it was; its stderr says who holds it or how to recover.
        startupFailure ??= new SidecarStartError("console_lock_held", readStderrTail);
        this.options.log.error(`console_lock_held: the sidecar exited without taking ${this.options.lockFile} (${summary})`);
        return;
      }
      const failureCode = `${sidecarReady ? "sidecar_exited" : "sidecar_exited_before_ready"}: ${summary}`;
      const failure = sidecarReady ? new Error(failureCode) : new SidecarStartError(failureCode, readStderrTail);
      if (!sidecarReady) startupFailure ??= failure;
      this.options.log.error(failure.message);
    });
    try {
      for (let attempt = 0; attempt < STARTUP_ATTEMPTS; attempt += 1) {
        if (startupFailure) throw startupFailure;
        await delay(Math.min(100 * (attempt + 1), STARTUP_DELAY_CAP_MS));
        if (startupFailure) throw startupFailure;
        // Until the new Console publishes, the lock can be absent, the exited Console's lock awaiting reclaim, or briefly
        // unreadable while it is published in place. None of that is a failure; the child's own exit is.
        const ready = await this.probe({ settleOwnerless: false });
        if (ready.kind === "healthy" && this.isOwned(ready.stored.lock)) {
          sidecarReady = true;
          return ready.url;
        }
        if (ready.kind === "healthy") throw new Error("cli_daemon_requires_confirmation");
      }
      throw new Error("sidecar_readiness_timeout");
    } catch (error) {
      throw this.failStartup(error);
    }
  }
  // startup 실패로 빠져나갈 때 스폰해 둔 child를 정리한다 — 부모가 죽어도 child는 자동 종료되지 않으므로
  // 여기서 시그널을 보내지 않으면 고아 sidecar와 잠금이 남아 다음 실행이 unhealthy-lock 경로에 갇힌다.
  private failStartup(error: unknown): Error {
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // 이미 종료된 프로세스 — 무시한다.
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }
  /** Quit. Never removes the lock: a lock left by an exited Console is reclaimed by the next Console that starts. */
  async stop(): Promise<void> {
    const current = await this.probe({ settleOwnerless: false });
    if (current.kind !== "healthy" && current.kind !== "unhealthy") return;
    if (!this.isOwned(current.stored.lock)) return;
    const { pid } = current.stored.lock;
    const identity = this.identifyLockProcess(current);
    if (identity === "unverified") {
      // Quit은 막지 않되 정체를 증명하지 못한 pid에는 신호를 보내지 않고, lock도 그대로 둔다.
      this.options.log.error(`console_lock_process_unverified: pid ${pid} holds ${this.options.lockFile} but did not prove it is the Console; left running`);
      return;
    }
    if (identity === "absent") {
      // listener만 닫고 정리 중인 Console일 수 있다. Quit은 기다리지 않되 살아 있는 pid의 lock은 보존한다.
      if (this.isProcessAlive(pid)) {
        this.options.log.error(`console_lock_process_unverified: pid ${pid} holds ${this.options.lockFile} but did not prove it is the Console; left running`);
        return;
      }
      this.options.log.info(`left the lock of exited pid ${pid} in place for the next Console to reclaim`);
      return;
    }
    // 정체가 확인된 sidecar는 health에 답하지 못해도(멈춘 자기 sidecar) Quit이 남겨서는 안 된다. 다만 채택한 sidecar가
    // SIGTERM 뒤 정체를 다시 증명하지 못하면 승격하지 않고 남긴다(terminateVerifiedProcess가 기록한다). Quit은 막지 않는다.
    // 리스너를 닫고 정리 중인 Console(closing)은 스스로 끝나며 lock도 직접 놓는다. Quit은 그것을 기다리지 않는다.
    await this.terminateVerifiedProcess(current.stored);
  }
  private async probe(options: { readonly settleOwnerless: boolean }): Promise<LockProbe> {
    const observed = options.settleOwnerless ? await this.observeLockSettled() : this.observeLock();
    if (observed.kind === "absent") return { kind: "missing" };
    if (observed.kind === "blocked" || observed.kind === "untrusted") return observed;
    const { stored } = observed;
    const health = await this.probeHealth(stored);
    if (health.kind !== "answered") return { kind: "unhealthy", stored, health };
    return { kind: "healthy", stored, url: new URL("console/", stored.lock.endpoint).toString(), health };
  }
  /**
   * 시작 경로의 probe. 연결은 거절되는데 lock pid가 살아 있으면 종료 정리 중인 Console일 수 있다 — 그 Console은 아직 공유
   * 상태를 정리하는 중이고 lock은 끝에서야 놓으므로, 지금 새 Console을 띄우면 두 Console이 같은 데이터를 동시에 만진다.
   * 그래서 pid가 끝나거나 lock이 바뀌거나 사라질 때까지 기다렸다가 다시 묻는다. 신호는 보내지 않는다.
   * 한도 뒤에도 거절·생존이 그대로면 lingering으로 표시해 unverified로 다룬다(lock 유지, 충돌로 종료). 그 대가로, 크래시 뒤
   * pid가 오래 사는 무관한 프로세스에 재할당되고 lock 주소에서 아무도 듣지 않는 경우에도 lock을 자동으로 치우지 않고
   * 충돌로 멈춘다. pid가 실제로 죽은 일반 크래시의 lock은 기다림 없이 새 Console의 회수에 맡긴다.
   */
  private async probeForStart(): Promise<StartLockProbe> {
    let current = await this.probe({ settleOwnerless: true });
    const deadline = Date.now() + SHUTDOWN_SETTLE_MS;
    while (current.kind === "unhealthy" && current.health.kind === "refused" && !this.isOwnLiveChild(current.stored.lock.pid) && this.isProcessAlive(current.stored.lock.pid)) {
      if (Date.now() >= deadline) return { ...current, lingering: true };
      await delay(STOP_DELAY_MS);
      if (this.isProcessAlive(current.stored.lock.pid) && this.isLockUnchanged(current.stored)) continue;
      current = await this.probe({ settleOwnerless: true });
    }
    return current;
  }
  private isLockUnchanged(stored: StoredLock): boolean {
    const observed = this.observeLock();
    return observed.kind === "trusted" && observed.stored.contents === stored.contents;
  }
  // lock이 적은 endpoint와 token으로 health를 묻는다. 정상 응답(2xx)만 answered이며, 그 본문의 pid가 정체 증거다.
  private async probeHealth(stored: StoredLock): Promise<ConsoleLockHealthEvidence> {
    const endpoint = new URL(stored.lock.endpoint);
    let response: Response | null = null;
    for (let attempt = 0; response === null; attempt += 1) {
      try {
        response = await fetch(new URL("api/v1/health", endpoint), { headers: { Authorization: `Bearer ${stored.lock.token}` }, signal: AbortSignal.timeout(1000) });
      } catch (error) {
        // 연결 거절은 그 주소에서 아무도 듣지 않는다는 확정 신호다. 시간 초과는 무언가 살아 있을 수 있다.
        // 재사용된 keep-alive 소켓의 끊김은 한 번만 새 연결로 다시 물어 최신 증거를 얻는다.
        const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
        if (code === "ECONNREFUSED") return { kind: "refused" };
        if (attempt === 0 && (code === "ECONNRESET" || code === "UND_ERR_SOCKET")) continue;
        return { kind: "unanswered" };
      }
    }
    if (!response.ok) return { kind: "unanswered" };
    // 본문을 읽지 못하면 정체 증명이 없을 뿐 채택 판단(2xx)은 그대로다.
    const pid = await response.json().then((body: unknown) => isRecord(body) ? body.pid : undefined, () => undefined);
    return { kind: "answered", pid };
  }
  /**
   * lock pid에 신호를 보내도 되는지 판별한다. 근거는 둘뿐이다. 이 Desktop이 직접 spawn해 아직 수거되지 않은 child이거나
   * (수거 전 pid는 OS가 재할당하지 않는다), lock token을 인증한 health가 같은 pid를 답한 경우다.
   */
  private identifyLockProcess(probe: UnhealthyLockProbe | HealthyLockProbe): ConsoleLockOwnerIdentity {
    const { pid } = probe.stored.lock;
    if (this.isOwnLiveChild(pid)) return "verified";
    return identifyConsoleLockOwner({ lockPid: pid, pidAlive: this.isProcessAlive(pid), health: probe.health });
  }
  private isOwnLiveChild(pid: number): boolean {
    const child = this.child;
    return child !== null && child.pid === pid && child.exitCode === null && child.signalCode === null;
  }
  /** Reads the lock once. Sends no signal and asks no endpoint. Follows no symlink and reads no other user's lock. */
  private observeLock(): LockObservation {
    const { lockFile } = this.options;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(lockFile);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return { kind: "absent" };
      return this.ownerless(`unreadable: ${errnoOf(error) ?? "error"}`);
    }
    if (stat.isSymbolicLink()) return this.refused("it is a symbolic link");
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null) {
      if (stat.uid !== uid) return this.refused(`it is owned by uid ${stat.uid}`);
      let dirUid: number;
      try {
        dirUid = fs.statSync(path.dirname(lockFile)).uid;
      } catch (error) {
        return this.ownerless(`unreadable directory: ${errnoOf(error) ?? "error"}`);
      }
      if (dirUid !== uid) return this.refused(`its directory is owned by uid ${dirUid}`);
    }
    if (!stat.isFile()) return this.ownerless("not a regular file");
    let contents: string;
    try {
      contents = fs.readFileSync(lockFile, "utf8");
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return { kind: "absent" };
      return this.ownerless(`unreadable: ${errnoOf(error) ?? "error"}`);
    }
    const content = classifyConsoleLockContent(contents);
    if (content.kind === "ownerless") return this.ownerless(content.reason);
    const trusted = readTrustedPayload(content.payload);
    if (typeof trusted === "string") return { kind: "untrusted", contents, pid: content.pid, issue: trusted };
    return { kind: "trusted", stored: { contents, lock: trusted } };
  }
  /** Re-reads an ownerless lock until the budget ends. Elapsed time is never evidence that its writer is gone. */
  private async observeLockSettled(): Promise<LockObservation> {
    const deadline = Date.now() + OWNERLESS_OBSERVE_MS;
    for (;;) {
      const observed = this.observeLock();
      if (observed.kind !== "blocked" || observed.code !== "console_lock_ownerless" || Date.now() >= deadline) return observed;
      await delay(OWNERLESS_REREAD_MS);
    }
  }
  private ownerless(reason: string): LockObservation {
    return { kind: "blocked", code: "console_lock_ownerless", detail: describeOwnerlessConsoleLock(this.options.lockFile, reason) };
  }
  private refused(reason: string): LockObservation {
    return { kind: "blocked", code: "console_lock_refused", detail: describeRefusedConsoleLock(this.options.lockFile, reason) };
  }
  /**
   * Pre-reclaim runtimes only (leaveExitedLock): such a Console publishes with O_EXCL and never reclaims, so the lock an
   * exited Console left is cleared here, and only while it still has the same contents. This removal takes no part in the
   * reclaim protocol; retire it when the oldest runtime Desktop starts includes that protocol.
   */
  private removeLegacyStaleLock(contents: string): void {
    const current = this.observeLock();
    if (current.kind === "absent") return;
    const currentContents = current.kind === "trusted" ? current.stored.contents : current.kind === "untrusted" ? current.contents : null;
    if (currentContents !== contents) throw new Error("console_lock_changed_before_cleanup");
    try {
      fs.unlinkSync(this.options.lockFile);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return;
      throw new Error(`console_lock_cleanup_failed: ${this.describeError(error)}`);
    }
  }
  /**
   * 정체가 확인된 pid를 SIGTERM→(대기)→SIGKILL로 종료한다. exited는 pid가 끝났다(ESRCH)는 뜻이다. closing은 채택한
   * sidecar가 SIGTERM 뒤 listener를 닫았지만 아직 살아 있다는 뜻이다 — 정리를 마치고 lock을 스스로 놓는 중이므로 신호를
   * 더 보내지 않는다. unverified는 정체를 다시 증명하지 못한 프로세스가 살아 남았다는 뜻이다.
   * 대기 중 그 프로세스가 lock을 남긴 채 죽고 pid가 무관한 프로세스에 재할당될 수 있으므로, SIGKILL 직전에 처음 판별과 같은
   * 수준으로 정체를 다시 증명한다. lock 파일이 그대로라는 사실은 증명이 아니다. 아직 수거되지 않은 자기 child는 그대로 승격하고,
   * 채택한 sidecar는 lock token health가 같은 pid를 다시 답할 때만 승격한다. 그 대가로 채택한 sidecar가 SIGTERM 뒤 멈춰
   * health에도 답하지 못하면 SIGKILL하지 않고 남긴다.
   */
  private async terminateVerifiedProcess(stored: StoredLock): Promise<TerminationOutcome> {
    const { pid } = stored.lock;
    await this.signal(pid, "SIGTERM");
    if (await this.waitForExit(pid, STOP_ATTEMPTS * STOP_DELAY_MS)) return "exited";
    if (!this.isOwnLiveChild(pid)) {
      const pidAlive = this.isProcessAlive(pid);
      const identity = identifyConsoleLockOwner({ lockPid: pid, pidAlive, health: await this.probeHealth(stored) });
      if (identity === "absent") return pidAlive && this.isProcessAlive(pid) ? "closing" : "exited";
      if (identity === "unverified") {
        this.options.log.error(`console_lock_process_unverified: pid ${pid} outlived SIGTERM but did not prove it is still the Console; not escalating to SIGKILL`);
        return "unverified";
      }
    }
    await this.signal(pid, "SIGKILL");
    if (await this.waitForExit(pid, STOP_ATTEMPTS * STOP_DELAY_MS)) return "exited";
    throw new Error("console_lock_process_unhealthy");
  }
  private async waitForExit(pid: number, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (!this.isProcessAlive(pid)) return true;
      if (Date.now() >= deadline) return false;
      await delay(STOP_DELAY_MS);
    }
  }
  /** Only ESRCH means the process is gone. A live pid, EPERM, and any undecidable error all count as alive. */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return errnoOf(error) !== "ESRCH";
    }
  }
  private async signal(pid: number, signal: NodeJS.Signals): Promise<void> {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (errnoOf(error) === "ESRCH") return;
      throw error;
    }
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
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function errnoOf(error: unknown): string | undefined { return (error as NodeJS.ErrnoException | null)?.code; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isConsoleOwnerMetadata(value: unknown): value is ConsoleOwnerMetadata { return isRecord(value) && (value.kind === "cli" || value.kind === "desktop") && typeof value.id === "string" && value.id.length > 0 && Number.isSafeInteger(value.protocolVersion); }
/** The fields this Desktop needs to ask and adopt a lock's Console. Returns the first problem when the lock cannot be trusted. */
function readTrustedPayload(payload: Readonly<Record<string, unknown>>): LockPayload | string {
  const { pid, endpoint: endpointValue, token, version, owner } = payload;
  if (typeof pid !== "number") return "invalid pid";
  if (typeof token !== "string" || token.length === 0) return "it has no token";
  if (typeof version !== "string" || version.length === 0) return "it has no version";
  if (owner !== undefined && !isConsoleOwnerMetadata(owner)) return "invalid owner";
  if (typeof endpointValue !== "string") return "invalid endpoint";
  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    return "invalid endpoint";
  }
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) return "invalid endpoint";
  return { pid, endpoint: endpointValue, token, version, owner: owner as ConsoleOwnerMetadata | undefined };
}

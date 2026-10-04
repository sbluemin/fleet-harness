import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { identifyConsoleLockOwner, isCompatibleDesktopOwner, type ConsoleLockHealthEvidence, type ConsoleLockOwnerIdentity, type ConsoleOwnerMetadata } from "@fleet-console/protocol/desktop";

export interface SidecarRuntime { readonly nodePath: string; readonly cliPath: string; readonly serviceRoot: string; readonly serviceVersion: string; }
export interface SidecarSupervisorOptions { readonly nodePath?: string; readonly cliPath?: string; readonly serviceRoot?: string; readonly serviceVersion: string; readonly resolveRuntime?: () => Promise<SidecarRuntime>; readonly env: NodeJS.ProcessEnv; readonly lockFile: string; readonly ownerId: string; readonly log: { info(message: string): void; error(message: string): void }; }
interface LockPayload { readonly pid: number; readonly endpoint: string; readonly token: string; readonly version: string; readonly owner?: ConsoleOwnerMetadata; }
interface StoredLock { readonly contents: string; readonly lock: LockPayload; }
interface MissingLockProbe { readonly kind: "missing"; }
interface UnhealthyLockProbe { readonly kind: "unhealthy"; readonly stored: StoredLock; readonly health: ConsoleLockHealthEvidence; }
interface HealthyLockProbe { readonly kind: "healthy"; readonly stored: StoredLock; readonly url: string; readonly health: ConsoleLockHealthEvidence; }
type LockProbe = MissingLockProbe | UnhealthyLockProbe | HealthyLockProbe;
type StartLockProbe = MissingLockProbe | HealthyLockProbe | (UnhealthyLockProbe & { readonly lingering?: true });

const STARTUP_ATTEMPTS = 40;
const STARTUP_DELAY_CAP_MS = 1_000;
const STOP_ATTEMPTS = 30;
const STOP_DELAY_MS = 100;
// 종료 중인 Console은 listener를 먼저 닫고 plugin·execution·MCP 정리를 마친 뒤에야 lock을 놓는다. 그 정리를 덮는 대기 한도.
const SHUTDOWN_SETTLE_MS = 10_000;

export class SidecarSupervisor {
  private child: ChildProcess | null = null;
  private serviceVersion: string;
  constructor(private readonly options: SidecarSupervisorOptions) { this.serviceVersion = options.serviceVersion; }
  async startOrAdopt(): Promise<string> {
    const current = await this.probeForStart();
    if (current.kind === "healthy") {
      if (this.isOwned(current.stored.lock)) return current.url;
      // 시작 경로는 같은 Desktop 소유 sidecar만 채택한다. 외부 런타임 페어링은
      // Console handoff 이후 사용자가 네이티브 메뉴에서 명시적으로 요청할 때만 수행한다.
      throw new Error("cli_daemon_requires_confirmation");
    }
    if (current.kind === "unhealthy") {
      const identity = current.lingering ? "unverified" : this.identifyLockProcess(current);
      if (identity === "absent") {
        this.removeStaleLock(current.stored);
      } else if (!this.isOwned(current.stored.lock)) {
        // 타 소유의 살아 있는 잠금은 신호를 보내지 않고 별도 충돌로 종료한다.
        throw new Error("console_lock_foreign_process_unhealthy");
      } else if (identity === "unverified") {
        // 살아 있는 lock pid가 정체를 증명하지 못했다(멈춘 이전 sidecar일 수도, pid를 물려받은 무관한 프로세스일 수도 있다).
        // 신호는 무관한 프로세스를 죽일 수 있고 lock을 지우면 살아 있는 Console 옆에 두 번째 소유자가 생기므로 둘 다 하지 않는다.
        this.options.log.error(`console_lock_process_unverified: pid ${current.stored.lock.pid} holds ${this.options.lockFile} but did not prove it is the Console`);
        throw new Error("console_lock_process_unverified");
      } else {
        if (!await this.terminateVerifiedProcess(current.stored)) throw new Error("console_lock_process_unverified");
        this.removeLockAfterOwnedTermination(current.stored);
      }
    }
    const runtime = await this.resolveRuntime();
    let startupFailure: Error | null = null;
    let sidecarReady = false;
    try {
      this.child = spawn(runtime.nodePath, [runtime.cliPath, "serve"], { cwd: path.dirname(path.dirname(runtime.cliPath)), env: this.options.env, stdio: ["ignore", "pipe", "pipe"], detached: false, windowsHide: true });
    } catch (error) {
      throw this.createSpawnFailure(error);
    }
    const child = this.child;
    child.stdout?.on("data", (chunk: Buffer) => this.options.log.info(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => this.options.log.error(chunk.toString("utf8")));
    child.once("error", (error) => {
      const failure = sidecarReady ? new Error(`sidecar_runtime_error: ${error.message}`) : this.createSpawnFailure(error);
      if (!sidecarReady) startupFailure = failure;
      this.options.log.error(failure.message);
    });
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      const failure = new Error(`${sidecarReady ? "sidecar_exited" : "sidecar_exited_before_ready"}: code=${code ?? "null"} signal=${signal ?? "null"}`);
      if (!sidecarReady) startupFailure ??= failure;
      this.options.log.error(failure.message);
    });
    for (let attempt = 0; attempt < STARTUP_ATTEMPTS; attempt += 1) {
      if (startupFailure) throw this.failStartup(startupFailure);
      await delay(Math.min(100 * (attempt + 1), STARTUP_DELAY_CAP_MS));
      if (startupFailure) throw this.failStartup(startupFailure);
      const ready = await this.probe();
      if (ready.kind === "healthy" && this.isOwned(ready.stored.lock)) {
        sidecarReady = true;
        return ready.url;
      }
      if (ready.kind === "healthy") throw this.failStartup(new Error("cli_daemon_requires_confirmation"));
    }
    throw this.failStartup(new Error("sidecar_readiness_timeout"));
  }
  // startup 실패로 빠져나갈 때 스폰해 둔 child를 정리한다 — 부모가 죽어도 child는 자동 종료되지 않으므로
  // 여기서 시그널을 보내지 않으면 고아 sidecar와 잠금이 남아 다음 실행이 unhealthy-lock 경로에 갇힌다.
  private failStartup(error: Error): Error {
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // 이미 종료된 프로세스 — 무시한다.
      }
    }
    return error;
  }
  async stop(): Promise<void> {
    const current = await this.probe();
    if (current.kind === "missing" || !this.isOwned(current.stored.lock)) return;
    const identity = this.identifyLockProcess(current);
    if (identity === "unverified") {
      // Quit은 막지 않되 정체를 증명하지 못한 pid에는 신호를 보내지 않고, lock도 그대로 둔다.
      this.options.log.error(`console_lock_process_unverified: pid ${current.stored.lock.pid} holds ${this.options.lockFile} but did not prove it is the Console; left running`);
      return;
    }
    if (identity === "absent") {
      try {
        this.removeStaleLock(current.stored);
      } catch (error) {
        this.options.log.error(`stale console lock left in place: ${this.describeError(error)}`);
      }
      return;
    }
    // 정체가 확인된 sidecar는 health에 답하지 못해도(멈춘 자기 sidecar) Quit이 남겨서는 안 된다. 다만 채택한 sidecar가
    // SIGTERM 뒤 정체를 다시 증명하지 못하면 승격하지 않고 남긴다(terminateVerifiedProcess가 기록한다). Quit은 막지 않는다.
    await this.terminateVerifiedProcess(current.stored);
  }
  private async probe(): Promise<LockProbe> {
    const stored = this.readLock();
    if (!stored) return { kind: "missing" };
    const health = await this.probeHealth(stored);
    if (health.kind !== "answered") return { kind: "unhealthy", stored, health };
    return { kind: "healthy", stored, url: new URL("console/", stored.lock.endpoint).toString(), health };
  }
  /**
   * 시작 경로의 probe. 연결은 거절되는데 lock pid가 살아 있으면 종료 정리 중인 Console일 수 있다 — 그 Console은 아직 공유
   * 상태를 정리하는 중이고 lock은 끝에서야 놓으므로, 여기서 lock을 지우고 새 Console을 띄우면 두 Console이 같은 데이터를
   * 동시에 만진다. 그래서 pid가 끝나거나 lock이 바뀌거나 사라질 때까지 기다렸다가 다시 묻는다. 신호는 보내지 않는다.
   * 한도 뒤에도 거절·생존이 그대로면 lingering으로 표시해 unverified로 다룬다(lock 유지, 충돌로 종료). 그 대가로, 크래시 뒤
   * pid가 오래 사는 무관한 프로세스에 재할당되고 lock 주소에서 아무도 듣지 않는 경우에도 이제는 lock을 자동으로 치우지 않고
   * 충돌로 멈춘다. pid가 실제로 죽은 일반 크래시의 stale lock은 기다림 없이 그대로 자동 정리된다.
   */
  private async probeForStart(): Promise<StartLockProbe> {
    let current = await this.probe();
    const deadline = Date.now() + SHUTDOWN_SETTLE_MS;
    while (current.kind === "unhealthy" && current.health.kind === "refused" && !this.isOwnLiveChild(current.stored.lock.pid) && this.isProcessAlive(current.stored.lock.pid)) {
      if (Date.now() >= deadline) return { ...current, lingering: true };
      await delay(STOP_DELAY_MS);
      if (this.isProcessAlive(current.stored.lock.pid) && this.isLockUnchanged(current.stored)) continue;
      current = await this.probe();
    }
    return current;
  }
  private isLockUnchanged(stored: StoredLock): boolean {
    try {
      return this.readLock()?.contents === stored.contents;
    } catch {
      return false;
    }
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
  private readLock(): StoredLock | null {
    let contents: string;
    try {
      contents = fs.readFileSync(this.options.lockFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`console_lock_read_failed: ${this.describeError(error)}`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(contents);
    } catch {
      throw new Error("console_lock_malformed: invalid_json");
    }
    return { contents, lock: this.validateLockPayload(payload) };
  }
  private validateLockPayload(payload: unknown): LockPayload {
    if (!isRecord(payload)) throw new Error("console_lock_malformed: invalid_payload");
    const { pid, endpoint: endpointValue, token, version, owner } = payload;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof endpointValue !== "string" || typeof token !== "string" || token.length === 0 || typeof version !== "string" || version.length === 0 || (owner !== undefined && !isConsoleOwnerMetadata(owner))) throw new Error("console_lock_malformed: invalid_payload");
    let endpoint: URL;
    try {
      endpoint = new URL(endpointValue);
    } catch {
      throw new Error("console_lock_malformed: invalid_endpoint");
    }
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new Error("console_lock_malformed: invalid_endpoint");
    return { pid, endpoint: endpointValue, token, version, owner };
  }
  // 소유 종료 직후의 잠금 정리 — sidecar가 SIGTERM을 정상 처리하며 스스로 지운 잠금(부재)은 회수 성공이다.
  // 내용이 바뀐 잠금만 타 프로세스의 인수로 보고 중단한다.
  private removeLockAfterOwnedTermination(stored: StoredLock): void {
    const current = this.readLock();
    if (!current) return;
    if (current.contents !== stored.contents) throw new Error("console_lock_changed_before_cleanup");
    try {
      fs.unlinkSync(this.options.lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`console_lock_cleanup_failed: ${this.describeError(error)}`);
    }
  }
  // 정체 판별이 "absent"인 lock — pid가 죽었거나 lock 주소에서 아무도 듣지 않는다. 신호 없이 같은 내용일 때만 파일을 치운다.
  private removeStaleLock(stored: StoredLock): void {
    const current = this.readLock();
    if (!current) return;
    if (current.contents !== stored.contents) throw new Error("console_lock_changed_before_cleanup");
    try {
      fs.unlinkSync(this.options.lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`console_lock_cleanup_failed: ${this.describeError(error)}`);
    }
  }
  /**
   * 정체가 확인된 pid를 SIGTERM→(대기)→SIGKILL로 종료한다. 돌려주는 값은 lock을 치워도 되는지다 — pid가 끝났거나
   * lock 주소에서 더는 아무도 듣지 않으면(absent) 참, 정체를 증명하지 못한 프로세스가 살아 남았으면 거짓이다.
   * 대기 중 그 프로세스가 lock을 남긴 채 죽고 pid가 무관한 프로세스에 재할당될 수 있으므로, SIGKILL 직전에 처음 판별과 같은
   * 수준으로 정체를 다시 증명한다. lock 파일이 그대로라는 사실은 증명이 아니다. 아직 수거되지 않은 자기 child는 그대로 승격하고,
   * 채택한 sidecar는 lock token health가 같은 pid를 다시 답할 때만 승격한다. 그 대가로 채택한 sidecar가 SIGTERM 뒤 멈춰
   * health에도 답하지 못하면 SIGKILL하지 않고 남긴다.
   */
  private async terminateVerifiedProcess(stored: StoredLock): Promise<boolean> {
    const { pid } = stored.lock;
    await this.signal(pid, "SIGTERM");
    for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt += 1) {
      if (!this.isProcessAlive(pid)) return true;
      await delay(STOP_DELAY_MS);
    }
    if (!this.isOwnLiveChild(pid)) {
      const identity = identifyConsoleLockOwner({ lockPid: pid, pidAlive: this.isProcessAlive(pid), health: await this.probeHealth(stored) });
      if (identity === "absent") return true;
      if (identity === "unverified") {
        this.options.log.error(`console_lock_process_unverified: pid ${pid} outlived SIGTERM but did not prove it is still the Console; not escalating to SIGKILL`);
        return false;
      }
    }
    await this.signal(pid, "SIGKILL");
    for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt += 1) {
      if (!this.isProcessAlive(pid)) return true;
      await delay(STOP_DELAY_MS);
    }
    throw new Error("console_lock_process_unhealthy");
  }
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  private async signal(pid: number, signal: NodeJS.Signals): Promise<void> {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
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
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isConsoleOwnerMetadata(value: unknown): value is ConsoleOwnerMetadata { return isRecord(value) && (value.kind === "cli" || value.kind === "desktop") && typeof value.id === "string" && value.id.length > 0 && Number.isSafeInteger(value.protocolVersion); }

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { isCompatibleDesktopOwner, type ConsoleOwnerMetadata } from "@fleet-console/desktop-protocol";

import { verifyPairingOrigin } from "./runtime-pairing.js";

export interface SidecarRuntime { readonly nodePath: string; readonly cliPath: string; readonly serviceRoot: string; readonly serviceVersion: string; }
export interface SidecarSupervisorOptions { readonly nodePath?: string; readonly cliPath?: string; readonly serviceRoot?: string; readonly serviceVersion: string; readonly resolveRuntime?: () => Promise<SidecarRuntime>; readonly env: NodeJS.ProcessEnv; readonly lockFile: string; readonly ownerId: string; readonly log: { info(message: string): void; error(message: string): void }; }
interface LockPayload { readonly pid: number; readonly endpoint: string; readonly token: string; readonly version: string; readonly owner?: ConsoleOwnerMetadata; }
interface StoredLock { readonly contents: string; readonly lock: LockPayload; }
interface MissingLockProbe { readonly kind: "missing"; }
interface UnhealthyLockProbe { readonly kind: "unhealthy"; readonly stored: StoredLock; }
interface HealthyLockProbe { readonly kind: "healthy"; readonly stored: StoredLock; readonly url: string; }
type LockProbe = MissingLockProbe | UnhealthyLockProbe | HealthyLockProbe;

const STARTUP_ATTEMPTS = 40;
const STARTUP_DELAY_CAP_MS = 1_000;
const STOP_ATTEMPTS = 30;
const STOP_DELAY_MS = 100;

export class SidecarSupervisor {
  private child: ChildProcess | null = null;
  private foreignLockContents: string | null = null;
  private serviceVersion: string;
  constructor(private readonly options: SidecarSupervisorOptions) { this.serviceVersion = options.serviceVersion; }
  async startOrAdopt(): Promise<string> {
    const current = await this.probe();
    if (current.kind === "healthy") {
      if (this.isOwned(current.stored.lock)) return current.url;
      // 외부 Console은 채택 전에 managed runtime을 해석한다. 최초 소유 판정은
      // 고정해 resolver가 버전을 바꿔도 외부 프로세스를 소유로 재분류하지 않는다.
      this.foreignLockContents = current.stored.contents;
      await this.resolveRuntime();
      // 정상 canonical Console은 수명주기 충돌이 아닌 peer runtime이다.
      // identity 검증은 정확한 Console handoff를 보장하고, 이 supervisor는
      // 이를 점유하지 않으며 stop()도 소유한 프로세스에만 동작한다.
      try {
        const verified = await verifyPairingOrigin(new URL(current.url).origin);
        return verified.consoleUrl;
      } catch (error) {
        // The process is healthy but cannot prove the frozen pairing identity.
        // It remains a foreign process: do not claim or signal it.
        throw new Error("console_pairing_identity_unavailable", { cause: error });
      }
    }
    if (current.kind === "unhealthy") {
      if (current.stored.contents === this.foreignLockContents) throw new Error("console_lock_foreign_process_unhealthy");
      if (this.isProcessAlive(current.stored.lock.pid)) {
        // 자기 소유(desktop owner 일치) sidecar는 unhealthy여도 안전하게 회수한다 —
        // 타 소유의 살아 있는 잠금은 신호를 보내지 않고 별도 충돌로 종료한다.
        if (!this.isOwned(current.stored.lock)) throw new Error("console_lock_foreign_process_unhealthy");
        await this.terminateOwnedProcess(current.stored.lock.pid);
        this.removeLockAfterOwnedTermination(current.stored);
      } else {
        this.removeProvenDeadLock(current.stored);
      }
    }
    const runtime = await this.resolveRuntime();
    let startupFailure: Error | null = null;
    let sidecarReady = false;
    try {
      this.child = spawn(runtime.nodePath, [runtime.cliPath, "serve"], { cwd: path.dirname(path.dirname(runtime.cliPath)), env: this.options.env, stdio: ["ignore", "ignore", "pipe"], detached: false, windowsHide: true });
    } catch (error) {
      throw this.createSpawnFailure(error);
    }
    const child = this.child;
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
      if (ready.kind === "healthy") throw this.failStartup(new Error("console_lock_foreign_process_appeared"));
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
    if (current.kind === "missing" || current.stored.contents === this.foreignLockContents || !this.isOwned(current.stored.lock)) return;
    if (current.kind === "unhealthy") {
      // 소유한 sidecar가 health에 답하지 못해도 Quit이 프로세스를 남겨서는 안 된다 —
      // 살아 있으면 start 경로와 동일한 소유 종료 절차로 정리한다(죽은 잠금 정리는 start가 담당).
      if (this.isProcessAlive(current.stored.lock.pid)) await this.terminateOwnedProcess(current.stored.lock.pid);
      return;
    }
    // SIGTERM 직후 health가 먼저 내려가고 프로세스만 남는 경우가 있어(정리 지연),
    // health 재검사 대신 pid 생존 기반의 소유 종료 절차로 SIGKILL 승격까지 보장한다.
    await this.terminateOwnedProcess(current.stored.lock.pid);
  }
  private async probe(): Promise<LockProbe> {
    const stored = this.readLock();
    if (!stored) return { kind: "missing" };
    try {
      const endpoint = new URL(stored.lock.endpoint);
      const response = await fetch(new URL("api/v1/health", endpoint), { headers: { Authorization: `Bearer ${stored.lock.token}` }, signal: AbortSignal.timeout(1000) });
      if (!response.ok) return { kind: "unhealthy", stored };
      return { kind: "healthy", stored, url: new URL("console/", endpoint).toString() };
    } catch { return { kind: "unhealthy", stored }; }
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
  private removeProvenDeadLock(stored: StoredLock): void {
    if (this.isProcessAlive(stored.lock.pid)) throw new Error("console_lock_process_unhealthy");
    const current = this.readLock();
    if (!current || current.contents !== stored.contents) throw new Error("console_lock_changed_before_cleanup");
    try {
      fs.unlinkSync(this.options.lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`console_lock_cleanup_failed: ${this.describeError(error)}`);
    }
  }
  // 소유가 확인된 pid를 SIGTERM→(대기)→SIGKILL로 종료하고, 끝내 살아 있으면 기존 하드 스톱으로 승격한다.
  private async terminateOwnedProcess(pid: number): Promise<void> {
    await this.signal(pid, "SIGTERM");
    for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt += 1) {
      if (!this.isProcessAlive(pid)) return;
      await delay(STOP_DELAY_MS);
    }
    await this.signal(pid, "SIGKILL");
    for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt += 1) {
      if (!this.isProcessAlive(pid)) return;
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

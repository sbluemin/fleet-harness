import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { isRecord, permissionHolderName, type ComputerUsePlatform } from "./platform.js";
import { callPlatform, COMPUTER_USE_PLATFORM_VERSION, prepareClipboardLease } from "./platform-helper.js";
import { REMOTE_PREVIEW_MAX_BYTES, REMOTE_PREVIEW_MAX_WIDTH } from "../shared/remote-preview.js";
import type { ChildProcess } from "node:child_process";

export interface Frame { x: number; y: number; w: number; h: number }
export interface HelperWindow {
  pid: number; windowId: number; processStartedAt: number; startedAtSource?: "launchDate" | "kernel";
  app: string; bundleId: string; bundlePath: string; title: string; frame: Frame;
  front: boolean; hidden: boolean; minimized: boolean; onCurrentSpace: boolean;
  engine: "appkit" | "webkit" | "chromium" | "electron" | "catalyst";
}
export interface HelperElement {
  ref: string; depth: number; role: string; label?: string;
  value?: string | number | boolean; valueMore?: number; moreOutside?: number; actions?: string[];
  settable?: boolean; editable?: boolean; focused?: boolean; enabled?: boolean; selected?: boolean;
}
export interface HelperImage { mime: string; data: string; width: number; height: number }
export type SnapshotWindow = Pick<HelperWindow, "pid" | "windowId" | "processStartedAt" | "title" | "frame">;
/** viewOnly: 다른 스페이스의 창이라 AX 요소 없이 화면 캡처만 담겼다. */
export interface HelperSnapshot { window: SnapshotWindow; elements: HelperElement[]; omitted: number; complete: boolean; image?: HelperImage; viewOnly?: boolean }
export interface HelperWindows { windows: HelperWindow[]; installed?: { name: string; path: string; bundleId: string }[] }
export interface HelperAction {
  sent: boolean; via?: "ax" | "event" | "event+focus" | "vm";
  observation: "changes" | "none" | "unobservable" | "timeout";
  verified?: string; changes: { op: string; element: HelperElement }[];
  changesMore?: number; windowsChanged?: { op: string; window: HelperWindow }[]; notes: string[];
}
export interface HelperVerify { status: "satisfied" | "unsatisfied" | "unknown"; index?: number; expected?: unknown; actual?: unknown; reason?: string; waitedMs: number }
export interface HelperHello {
  protocol: 1; helperVersion: number | string; os: string;
  permissions: { accessibility: boolean; screenRecording: boolean };
  /** retryable: 사람의 포인터·앱 전환이나 헬퍼의 일시 활성화처럼 다시 점검하면 통과할 수 있는 실패다. */
  selfCheck: HelperSelfCheck;
  /** TCC가 권한을 판정하는 앱의 표시 이름. 헬퍼 자신이 아니라 헬퍼를 띄운 앱이다. */
  permissionHolder?: string;
  /** 그 앱이 이 Console의 조상이라 종료하면 지금 세션도 끝나는지. 헬퍼가 확인했을 때만 true다. */
  permissionHolderHostsSession?: boolean;
}
export interface HelperSelfCheck { ok: boolean; reason?: string; ms: number; retryable?: boolean }
/** requested는 지금 macOS에 물은 권한, deferred는 손쉬운 사용이 켜지면 헬퍼가 이어서 물을 권한(화면 기록)이다. */
export interface HelperPermissionRequest { requested?: ("accessibility" | "screenRecording")[]; deferred?: ("accessibility" | "screenRecording")[]; permissions?: { accessibility: boolean; screenRecording: boolean } }
export interface HelperFocus { editable: boolean; focusedRef?: string; role?: string }
interface Replies { focus: HelperFocus; hello: HelperHello; recheck: HelperSelfCheck; windows: HelperWindows; snapshot: HelperSnapshot; act: HelperAction; verify: HelperVerify; cursor: object; requestPermissions: HelperPermissionRequest; shutdown: object }
export class FleetHelperError extends Error {
  constructor(readonly code: string, readonly uncertain = false, readonly details?: Record<string, unknown>) { super(code); }
}
interface Runtime {
  childEnv(): NodeJS.ProcessEnv;
  spawnProcess(request: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }): ChildProcess;
}

export function createFleetComputerUsePlatform(runtime: Runtime, config: {
  readonly supported: boolean;
  readonly command?: string;
  readonly platformVersion?: string;
}): ComputerUsePlatform {
  const executable = config.supported && config.command && isAbsolute(config.command) &&
    config.platformVersion === String(COMPUTER_USE_PLATFORM_VERSION) ? config.command : undefined;
  const spawn = (args: readonly string[]) => {
    if (!executable) throw new FleetHelperError("helper_missing");
    return runtime.spawnProcess({ command: executable, args, env: runtime.childEnv() });
  };
  let legacyWindowState = false;
  return {
    supported: () => config.supported,
    async inspectInstallation() {
      if (!executable) return false;
      try { await access(executable, constants.X_OK); return (await stat(executable)).isFile(); } catch { return false; }
    },
    createClient: () => {
      if (!executable) throw new FleetHelperError("helper_missing");
      return new FleetHelperClient(runtime, executable);
    },
    async readPermissions() {
      const result = await callPlatform(spawn, "readPermissions", {}, 3000);
      if (typeof result?.accessibility !== "boolean" || typeof result.screenRecording !== "boolean") return null;
      const holder = permissionHolderName(result.holder);
      return { accessibility: result.accessibility, screenRecording: result.screenRecording, ...(holder ? { holder } : {}) };
    },
    async windowState({ pid, windowId, processStartedAt }) {
      const params = { pid, windowId, processStartedAt };
      if (!legacyWindowState) {
        const result = await callPlatform(spawn, "windowState", params, 3000, undefined, {
          onUnsupported: () => { legacyWindowState = true; },
        });
        if ((result?.identity === "matches" || result?.identity === "mismatch") && typeof result.onscreen === "boolean") {
          return { identity: result.identity, onscreen: result.onscreen };
        }
        if (!legacyWindowState) return { identity: "unknown", onscreen: false };
      }
      // Console과 Desktop 헬퍼의 업데이트 시점이 다르면 기존 판정을 유지한다.
      const result = await callPlatform(spawn, "verifyWindowIdentity", params, 3000);
      const identity = result?.identity === "matches" || result?.identity === "mismatch" ? result.identity : "unknown";
      return { identity, onscreen: identity === "matches" };
    },
    async captureStill({ pid, windowId, processStartedAt }, signal) {
      const maxEncoded = 4 * Math.ceil(REMOTE_PREVIEW_MAX_BYTES / 3);
      // Foundation JSON은 base64의 /를 이스케이프할 수 있다.
      const result = await callPlatform(spawn, "captureStill", { pid, windowId, processStartedAt }, 4500, signal, { maxReplyBytes: maxEncoded * 2 + 512 });
      if (result?.mime !== "image/jpeg" || typeof result.data !== "string" || result.data.length > maxEncoded ||
          typeof result.width !== "number" || !Number.isInteger(result.width) || result.width < 1 || result.width > REMOTE_PREVIEW_MAX_WIDTH ||
          typeof result.height !== "number" || !Number.isInteger(result.height) || result.height < 1) return null;
      const bytes = Buffer.from(result.data, "base64");
      return bytes.length <= REMOTE_PREVIEW_MAX_BYTES && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? bytes : null;
    },
    async resolveApp(target, signal) {
      const result = await callPlatform(spawn, "resolveApp", { target }, 3000, signal);
      if (typeof result?.app === "string" && isAbsolute(result.app)) return { app: result.app };
      const error = result?.error;
      if (error === "exact_target_required" || error === "unambiguous_target_required" || error === "installed_target_required") return { error };
      throw new FleetHelperError("computer_use_open_failed");
    },
    async openApp(app, signal, activate) {
      const result = await callPlatform(spawn, "openApp", { app, activate }, 12_000, signal);
      if (typeof result?.requestDispatched !== "boolean" || typeof result.windowReady !== "boolean") {
        // A missing reply is not evidence that LaunchServices did not receive the request.
        return { requestDispatched: true, windowReady: false, error: "computer_use_open_failed" };
      }
      return { requestDispatched: result.requestDispatched, windowReady: result.windowReady,
        ...(result.error === undefined ? {} : { error: "computer_use_open_failed" }) };
    },
    async openPrivacySettings(permissions) {
      return (await callPlatform(spawn, "openPrivacySettings", { permissions }, 4000))?.opened === true;
    },
    preparePaste: (payload, signal) => prepareClipboardLease(spawn, payload, signal),
  };
}

const REQUEST_TIMEOUT = 15_000;
const MAX_LINE = 48 * 1024 * 1024;
type Pending = { resolve: (value: object) => void; reject: (error: FleetHelperError) => void; timer: ReturnType<typeof setTimeout>; input: boolean };

export class FleetHelperClient {
  private readonly child;
  private readonly pending = new Map<number, Pending>();
  private readonly exited: Promise<void>;
  private closed = false;
  private stopping?: Promise<boolean>;
  private nextId = 0;
  private buffer = "";
  hello: HelperHello | null = null;

  constructor(runtime: Runtime, command: string, private readonly timeoutMs = REQUEST_TIMEOUT) {
    const child = this.child = runtime.spawnProcess({ command, args: [], env: runtime.childEnv() });
    this.exited = new Promise((resolve) => {
      child.once("close", () => { this.disconnect(); resolve(); });
    });
    child.on("error", () => this.disconnect());
    child.stdin?.on("error", () => this.disconnect());
    child.stdout?.on("error", () => this.disconnect());
    child.stderr?.resume();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => this.receive(data));
  }

  get live() { return !this.closed && !this.stopping; }

  async start(): Promise<HelperHello> {
    const hello = await this.send("hello", {});
    if (hello.protocol !== 1 || typeof hello.selfCheck?.ok !== "boolean" || typeof hello.permissions?.accessibility !== "boolean" || typeof hello.permissions?.screenRecording !== "boolean") throw new FleetHelperError("internal");
    const { permissionHolder, permissionHolderHostsSession, ...rest } = hello;
    const holder = permissionHolderName(permissionHolder);
    return this.hello = { ...rest, ...(holder ? { permissionHolder: holder } : {}), ...(holder && permissionHolderHostsSession === true ? { permissionHolderHostsSession: true } : {}) };
  }

  request<K extends Exclude<keyof Replies, "shutdown" | "hello" | "recheck">>(method: K, params: object): Promise<Replies[K]> {
    if (method === "act" || method === "focus") return this.ensureInputAllowed().then(() => this.send(method, params));
    return this.send(method, params);
  }

  /**
   * 시작 자체 점검이 일시 사유로 실패했으면 입력 전에 헬퍼에 다시 점검하게 한다. 실패를 헬퍼 수명 내내 고정하면
   * 사람이 점검 순간 마우스를 움직였다는 이유만으로 모든 입력이 막혔다(dbdbe742).
   */
  async ensureInputAllowed(): Promise<void> {
    const check = this.hello?.selfCheck;
    if (this.hello && check && !check.ok && check.retryable === true) {
      const next = await this.send("recheck", {});
      if (typeof next?.ok === "boolean") this.hello = { ...this.hello, selfCheck: next };
    }
    this.assertInputAllowed();
  }

  assertInputAllowed(): void {
    if (!this.hello) throw new FleetHelperError("internal");
    const missing = (["accessibility", "screenRecording"] as const).filter((key) => !this.hello!.permissions[key]);
    if (missing.length) throw new FleetHelperError("permission_required", false, { missing, ...(this.hello.permissionHolder ? { holder: this.hello.permissionHolder } : {}), ...(this.hello.permissionHolderHostsSession ? { holderHostsSession: true } : {}) });
    if (!this.hello.selfCheck.ok) throw new FleetHelperError("self_check_failed", false, this.hello.selfCheck.reason ? { reason: this.hello.selfCheck.reason } : undefined);
  }

  stop(): Promise<boolean> {
    if (this.stopping) return this.stopping;
    void this.send("shutdown", {}, 1000).then(() => this.child.stdin?.end(), () => undefined);
    this.stopping = new Promise<boolean>((resolve) => {
      let forced = false;
      let kill: ReturnType<typeof setTimeout> | undefined;
      const term = setTimeout(() => {
        forced = true;
        this.child.stdin?.end();
        this.child.kill("SIGTERM");
        this.disconnect();
        kill = setTimeout(() => this.child.kill("SIGKILL"), 250);
      }, 1000);
      void this.exited.then(() => {
        clearTimeout(term);
        clearTimeout(kill);
        resolve(!forced);
      });
    });
    return this.stopping;
  }

  private disconnect() {
    this.closed = true;
    this.buffer = "";
    for (const [id, wait] of this.pending) {
      this.pending.delete(id);
      clearTimeout(wait.timer);
      wait.reject(new FleetHelperError(wait.input ? "timeout" : "internal", wait.input));
    }
  }

  private send<K extends keyof Replies>(method: K, params: object, timeout = this.timeoutMs): Promise<Replies[K]> {
    const stdin = this.child.stdin;
    if (this.closed || this.stopping || !stdin?.writable) return Promise.reject(new FleetHelperError("internal"));
    const id = ++this.nextId;
    const input = method === "act";
    return new Promise<Replies[K]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new FleetHelperError("timeout", input));
      }, timeout);
      this.pending.set(id, { resolve: (value) => resolve(value as Replies[K]), reject, timer, input });
      stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => { if (error) this.disconnect(); });
    });
  }

  private receive(data: string) {
    if (this.closed) return;
    this.buffer += data;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      if (newline > MAX_LINE) { this.disconnect(); return; }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { this.disconnect(); return; }
      if (!isRecord(msg)) { this.disconnect(); return; }
      if (typeof msg.event === "string") continue;
      if (typeof msg.id !== "number") { this.disconnect(); return; }
      const wait = this.pending.get(msg.id);
      if (!wait) continue;
      this.pending.delete(msg.id);
      clearTimeout(wait.timer);
      if (msg.ok === true && isRecord(msg.result)) wait.resolve(msg.result);
      else if (msg.ok === false && isRecord(msg.error) && typeof msg.error.code === "string") {
        const code = /^[a-z][a-z_]{0,63}$/u.test(msg.error.code) ? msg.error.code : "internal";
        wait.reject(new FleetHelperError(code, wait.input && msg.error.dispatch !== "not_sent", isRecord(msg.error.details) ? msg.error.details : undefined));
      } else wait.reject(new FleetHelperError(wait.input ? "timeout" : "internal", wait.input));
    }
    if (this.buffer.length > MAX_LINE) this.disconnect();
  }
}

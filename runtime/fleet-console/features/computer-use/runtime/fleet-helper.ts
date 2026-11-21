import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { isRecord, type ComputerUseRuntimeDependencies } from "./platform.js";

export interface Frame { x: number; y: number; w: number; h: number }
export interface HelperWindow {
  pid: number; windowId: number; processStartedAt: number;
  app: string; bundleId: string; bundlePath: string; title: string; frame: Frame;
  front: boolean; hidden: boolean; minimized: boolean; onCurrentSpace: boolean;
  engine: "appkit" | "webkit" | "chromium" | "electron" | "catalyst";
}
export interface HelperElement {
  ref: string; depth: number; role: string; label?: string;
  value?: string | number | boolean; valueMore?: number; actions?: string[];
  settable?: boolean; editable?: boolean; focused?: boolean; enabled?: boolean; selected?: boolean;
}
export interface HelperImage { mime: string; data: string; width: number; height: number }
export type SnapshotWindow = Pick<HelperWindow, "pid" | "windowId" | "processStartedAt" | "title" | "frame">;
export interface HelperSnapshot { window: SnapshotWindow; elements: HelperElement[]; omitted: number; omittedOutside?: number; complete: boolean; image?: HelperImage }
export interface HelperWindows { windows: HelperWindow[]; installed?: { name: string; path: string; bundleId: string }[] }
export interface HelperAction {
  sent: boolean; via?: "ax" | "event" | "event+focus";
  observation: "changes" | "none" | "unobservable" | "timeout";
  verified?: string; changes: { op: string; element: HelperElement }[];
  changesMore?: number; windowsChanged?: { op: string; window: HelperWindow }[]; notes: string[];
}
export interface HelperVerify { status: "satisfied" | "unsatisfied" | "unknown"; index?: number; expected?: unknown; actual?: unknown; reason?: string; waitedMs: number }
export interface HelperHello {
  protocol: 1; helperVersion: number | string; os: string;
  permissions: { accessibility: boolean; screenRecording: boolean };
  selfCheck: { ok: boolean; reason?: string; ms: number };
}
export interface HelperFocus { editable: boolean; focusedRef?: string; role?: string }
interface Replies { focus: HelperFocus; hello: HelperHello; windows: HelperWindows; snapshot: HelperSnapshot; act: HelperAction; verify: HelperVerify; cursor: object; shutdown: object }
export class FleetHelperError extends Error {
  constructor(readonly code: string, readonly uncertain = false, readonly details?: Record<string, unknown>) { super(code); }
}
type Runtime = Pick<ComputerUseRuntimeDependencies, "childEnv" | "spawnProcess">;

export function createFleetComputerUsePlatform(runtime: Runtime, command: string | undefined, platform = process.platform) {
  const executable = command && isAbsolute(command) ? command : undefined;
  return {
    supported: () => platform === "darwin",
    async inspectInstallation() {
      if (!executable || platform !== "darwin") return false;
      try { await access(executable, constants.X_OK); return (await stat(executable)).isFile(); } catch { return false; }
    },
    createClient: () => {
      if (!executable) throw new FleetHelperError("helper_missing");
      return new FleetHelperClient(runtime, executable);
    },
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
    return this.hello = hello;
  }

  request<K extends Exclude<keyof Replies, "shutdown" | "hello">>(method: K, params: object): Promise<Replies[K]> {
    if (method === "act" || method === "focus") {
      try { this.assertInputAllowed(); } catch (error) { return Promise.reject(error); }
    }
    return this.send(method, params);
  }

  assertInputAllowed(): void {
    if (!this.hello) throw new FleetHelperError("internal");
    const missing = (["accessibility", "screenRecording"] as const).filter((key) => !this.hello!.permissions[key]);
    if (missing.length) throw new FleetHelperError("permission_required", false, { missing });
    if (!this.hello.selfCheck.ok) throw new FleetHelperError("self_check_failed");
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

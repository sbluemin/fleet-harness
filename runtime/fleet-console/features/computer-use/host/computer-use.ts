import { marked } from "marked";
import type { AgentToolSpec } from "@fleet-console/agent-runtime/tools";
import { FleetHelperError, type FleetHelperClient, type Frame, type HelperElement, type HelperWindow, type SnapshotWindow } from "../runtime/fleet-helper.js";
import type { ClipboardLease, ClipboardRestoration, ComputerUseCaptureFailure, ComputerUsePermissions, ComputerUsePlatform, ComputerUseResult, ComputerUseWindowIdentity, ComputerUseWindowState } from "../runtime/platform.js";
import { COMPUTER_USE_PERMISSIONS, type ComputerUseOs, type ComputerUsePermission, type ComputerUseSettingsStatus } from "../shared/status.js";
import { computerUseTools, computerUseToolsFor } from "./computer-use-tools.js";
import { dragPoint, InvalidComputerUseParameters, isElementId, parseDeviceInput, type Action, type ActionArgs, type DeviceTool, type OpenArgs, type Point, type StateArgs, type VerifyArgs } from "./computer-use-input.js";
import { gateResult, nativeRole, offeredAction, renderAction, renderApps, renderError, renderOpen, renderSessionEnd, renderSessionStatus, renderState, renderVerify, windowLine } from "./computer-use-render.js";

const IDLE_TIMEOUT_MS = 5 * 60_000;
/** 같은 권한의 macOS 요청 창은 이 간격 안에서 한 번만 띄운다. 에이전트가 거듭 호출해도 창이 쌓이지 않게 한다. */
const PERMISSION_REQUEST_INTERVAL_MS = 5 * 60_000;
/** 이번 호출에서 Fleet이 요청 창을 띄웠는지("requested"), 간격 안이라 건너뛰었는지("recent"). 모르면 없음. */
export type PermissionRequestOutcome = "requested" | "recent";
const ACTION_NAMES = new Set<string>(computerUseTools[3].inputSchema.properties.action.enum);
interface Caller { actor?: string; canDeliver?: () => boolean }
type IssuedElement = Pick<HelperElement, "role" | "actions" | "settable">;
interface KnownWindow { id: string; identity: string; issued: Map<string, IssuedElement>; closed: boolean }
interface View { id: string; frame: Frame; width: number; height: number }
interface DeviceOutput { result: ComputerUseResult; code: string }
export interface ComputerUseRecentCall { tool: DeviceTool; action?: Action; code: string }

type DeliveryFailure = "timeout" | null;
export interface ComputerUseStatus {
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly installation: "unchecked" | "available" | "missing" | "unsupported";
  readonly warning: string | null;
  readonly state: "off" | "idle" | "starting" | "ready" | "running" | "stopping";
  readonly activeTool: string | null;
  readonly elapsedMs: number;
  readonly stage: string | null;
  readonly apps: readonly string[];
  readonly cleanupStatus: "not_requested" | "not_needed" | "notified" | "failed";
  readonly threadReleaseStatus: "not_requested" | "not_needed";
  readonly cleanupFailure: DeliveryFailure;
  readonly captureStopped: "unverified";
  readonly error: string | null;
  readonly lastCall: { readonly tool: string; readonly outcome: string; readonly elapsedMs: number; readonly error: string | null } | null;
}

export interface ComputerUseDiagnostic {
  tool: string;
  scope: "model_output";
  phase: "end";
  elapsedMs: number;
  outcome: "error" | "returned" | "unknown";
  error?: string;
  textChars: number;
  imageCount: number;
  imageBytes: number;
}

const identityOf = (w: SnapshotWindow) => `${w.pid}:${w.windowId}:${w.processStartedAt}`;
const sameFrame = (a: Frame, b: Frame) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1;
const address = (w: SnapshotWindow) => ({ pid: w.pid, windowId: w.windowId, processStartedAt: w.processStartedAt });
// 최소화·숨김 창은 앞으로 올리지 않고 읽고 조작한다(헬퍼가 타이핑·키·드래그만 거절한다). 다른 스페이스의 창은 화면 캡처로 보기만 한다(dbdbe742).
const availableReason = (w: HelperWindow, viewOnly: boolean) => !w.onCurrentSpace && !w.hidden && !w.minimized && !viewOnly ? "other_space" : undefined;
const unavailable = (reason?: string) => new FleetHelperError("window_unavailable", false, { reason });
const withOk = (result: ComputerUseResult): DeviceOutput => ({ result, code: "ok" });
const pointInView = (point: Point, view: View) => point.x >= 0 && point.y >= 0 && point.x < view.width && point.y < view.height;

export class ComputerUseService {
  private client: FleetHelperClient | null = null;
  private owner: string | null = null;
  private lifetime: AbortController | null = null;
  private captureIsUnavailable = false;
  private captureFailure: ComputerUseCaptureFailure | null = null;
  private busy = false;
  private state: ComputerUseStatus["state"] = "idle";
  private installation: ComputerUseStatus["installation"] = "unchecked";
  private cleanupStatus: ComputerUseStatus["cleanupStatus"] = "not_requested";
  private cleanupFailure: DeliveryFailure = null;
  private lastCall: ComputerUseStatus["lastCall"] = null;
  private activeTool: string | null = null;
  private startedAt: number | null = null;
  private stage: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;
  /** `stop()`이 불릴 때마다 오른다. 요청 도중에 멈췄으면 그 요청의 헬퍼를 넘겨받지 않는다. */
  private stops = 0;
  private clipboardCleanup: Promise<ClipboardRestoration | undefined> | null = null;
  private windowSequence = 0;
  private viewSequence = 0;
  private readonly windows = new Map<string, KnownWindow>();
  private readonly liveWindows = new Map<string, KnownWindow>();
  private readonly apps = new Set<string>();
  private readonly views = new Map<string, Map<string, View>>();
  private selfCheckFailed = false;
  private failedSelfCheck(client: FleetHelperClient, hello = client.hello) {
    return Boolean(hello && !hello.selfCheck.ok && hello.selfCheck.reason !== "permission_required");
  }
  private permissionsRead: { at: number; result: Promise<ComputerUsePermissions | null> } | null = null;
  private readonly permissionRequestedAt = new Map<ComputerUsePermission, number>();
  private readonly recent = new Map<string, ComputerUseRecentCall[]>();

  constructor(private readonly deps: {
    readonly enabled: () => boolean;
    readonly platform: ComputerUsePlatform;
    /** 문구·도구 설명을 고르는 호스트 OS. 없으면 macOS. */
    readonly os?: ComputerUseOs;
    readonly diagnostic?: (event: ComputerUseDiagnostic) => void;
    readonly onFailure?: (kind: string, error: unknown) => void;
    readonly onCaptureTarget?: (target: (ComputerUseWindowIdentity & { owner: string }) | null) => void;
    readonly onActiveOwnerChange?: (owner: string | null) => void;
  }) {}

  private get os(): ComputerUseOs { return this.deps.os ?? "darwin"; }

  status(): ComputerUseStatus {
    const supported = this.deps.platform.supported();
    const enabled = supported && this.deps.enabled();
    const failed = this.cleanupStatus === "failed";
    return {
      enabled, supported, installation: this.installation,
      warning: failed ? "computer_use_cleanup_unconfirmed" : null,
      state: enabled ? this.state : "off", activeTool: this.activeTool,
      elapsedMs: this.startedAt === null ? 0 : Math.max(0, Date.now() - this.startedAt), stage: this.stage,
      apps: [...this.apps], cleanupStatus: this.cleanupStatus, threadReleaseStatus: "not_needed", cleanupFailure: this.cleanupFailure,
      captureStopped: "unverified", error: failed ? "computer_use_cleanup_failed" : this.lastCall?.error ?? null, lastCall: this.lastCall,
    };
  }

  async inspectInstallation(): Promise<ComputerUseStatus["installation"]> {
    if (!this.deps.platform.supported()) return this.installation = "unsupported";
    return this.installation = await this.deps.platform.inspectInstallation() ? "available" : "missing";
  }
  async readStatus(): Promise<ComputerUseSettingsStatus> {
    const helperAvailable = await this.inspectInstallation() === "available";
    const { enabled, supported } = this.status();
    const hello = this.helperInfo();
    let permissions: ComputerUsePermissions | null = null;
    if (helperAvailable) {
      const now = Date.now();
      if (!this.permissionsRead || now - this.permissionsRead.at >= 5000) {
        this.permissionsRead = { at: now, result: this.deps.platform.readPermissions() };
      }
      permissions = (await this.permissionsRead.result) ?? (hello ? { ...hello.permissions, ...(hello.permissionHolder ? { holder: hello.permissionHolder } : {}) } : null);
    }
    const missingPermissions = permissions ? COMPUTER_USE_PERMISSIONS.filter((permission) => !permissions[permission]) : null;
    const permissionHolder = permissions?.holder ?? hello?.permissionHolder ?? null;
    return { enabled, supported, helperAvailable, missingPermissions, permissionHolder, selfCheckFailed: enabled && helperAvailable && this.selfCheckFailed, ...(this.os === "win32" ? { os: this.os } : {}) };
  }
  async captureWindowState(target: ComputerUseWindowIdentity): Promise<ComputerUseWindowState> {
    return this.deps.enabled() ? this.deps.platform.windowState(target) : { identity: "mismatch", onscreen: false };
  }

  async captureStill(target: ComputerUseWindowIdentity, signal: AbortSignal): Promise<Buffer | null> {
    return this.deps.enabled() && this.activeOwner() !== null ? this.deps.platform.captureStill(target, signal) : null;
  }

  activeOwner(): string | null { return this.state === "stopping" ? null : this.owner; }
  captureUnavailableOwner(): string | null { return this.captureIsUnavailable ? this.activeOwner() : null; }
  captureUnavailableReason(): ComputerUseCaptureFailure | null { return this.captureUnavailableOwner() === null ? null : this.captureFailure; }
  release(owner: string): void { if (this.owner === owner) this.stopDetached(); }
  releaseWhere(predicate: (owner: string) => boolean): void { if (this.owner !== null && predicate(this.owner)) this.stopDetached(); }
  stopDetached(): void { void this.stop().catch((error) => this.reportFailure("computer_use_stop_failed", error)); }
  recentCalls(actor: string): readonly ComputerUseRecentCall[] { return [...(this.recent.get(actor) ?? [])]; }
  waitForRelease(): Promise<void> { return this.stopping ?? Promise.resolve(); }
  rememberSessionEnd(actor: string): void { this.remember(actor, { tool: "computer_session", code: "ok" }); }
  private remember(actor: string, call: ComputerUseRecentCall): void {
    this.recent.set(actor, [...this.recentCalls(actor).slice(-4), call]);
  }
  helperInfo() { return this.client?.hello ?? null; }
  forgetViews(actor: string): void { this.views.delete(actor); }
  forgetRecent(actor: string): void { this.recent.delete(actor); }

  private reportFailure(kind: string, error: unknown): void {
    try { this.deps.onFailure?.(kind, error); } catch { /* 진단 실패가 정리를 막지 않는다. */ }
  }
  private publishCapture(window?: SnapshotWindow, failure?: ComputerUseCaptureFailure): void {
    this.captureIsUnavailable = !window && failure !== undefined;
    this.captureFailure = failure ?? null;
    try {
      this.deps.onCaptureTarget?.(window && this.owner ? { ...address(window), title: window.title, owner: this.owner } : null);
    } catch (error) { this.reportFailure("computer_use_capture_publish_failed", error); }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stops++;
    this.state = "stopping";
    this.lifetime?.abort();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.publishCapture();
    this.apps.clear();
    this.resetReferences();
    const client = this.client;
    const clipboardCleanup = this.clipboardCleanup;
    this.client = null;
    this.stopping = Promise.resolve().then(async () => {
      try {
        const [helperStopped, restored] = await Promise.all([client?.stop() ?? true, clipboardCleanup]);
        const clean = helperStopped && restored !== "failed";
        this.cleanupStatus = !client && !clipboardCleanup ? "not_needed" : clean ? "notified" : "failed";
        this.cleanupFailure = clean ? null : "timeout";
        if (!clean) this.reportFailure("computer_use_stop_failed", new Error("timeout"));
      } catch (error) {
        this.cleanupStatus = "failed";
        this.cleanupFailure = "timeout";
        this.reportFailure("computer_use_stop_failed", error);
      } finally {
        this.owner = null;
        this.lifetime = null;
        this.state = "idle";
        this.stopping = null;
      }
    });
    this.deps.onActiveOwnerChange?.(null);
    return this.stopping;
  }

  specs(): (AgentToolSpec & { id: DeviceTool })[] {
    return computerUseToolsFor(this.os).map(({ name, description, inputSchema }) => ({
      id: name, tag: name, title: name, promptSnippet: "", whenToUse: [], whenNotToUse: [], usageGuidelines: [], description, parameters: inputSchema,
      execute: (args, context) => this.execute(name, args, context.sessionLabel, context.signal),
    }));
  }

  async execute(tool: DeviceTool, input: unknown, owner?: string, signal?: AbortSignal, caller?: Caller): Promise<ComputerUseResult> {
    const start = Date.now();
    const actor = caller?.actor ?? owner;
    let action: Action | undefined;
    if (typeof input === "object" && input !== null && "action" in input && typeof input.action === "string" && ACTION_NAMES.has(input.action)) action = input.action as Action;
    const { result, code } = await this.run(tool, input, owner, signal, caller);
    if (actor && caller?.canDeliver?.() !== false && !signal?.aborted) {
      this.remember(actor, { tool, ...(action ? { action } : {}), code });
    }
    try {
      const elapsedMs = Date.now() - start;
      const textChars = result.content.reduce((n, block) => n + (block.type === "text" && typeof block.text === "string" ? block.text.length : 0), 0);
      const imageCount = result.content.filter((block) => block.type === "image").length;
      const imageBytes = result.content.reduce((n, block) => n + (block.type === "image" && typeof block.data === "string" ? Buffer.byteLength(block.data, "base64") : 0), 0);
      this.deps.diagnostic?.({ tool, scope: "model_output", phase: "end", elapsedMs, outcome: code === "dispatch_unknown" || code === "effect_unknown" ? "unknown" : result.isError ? "error" : "returned", ...(result.isError ? { error: code } : {}), textChars, imageCount, imageBytes });
    } catch { /* 모델 반환 실패나 입력 재전송으로 이어지지 않는다. */ }
    return result;
  }

  private async run(tool: DeviceTool, input: unknown, owner?: string, signal?: AbortSignal, caller?: Caller): Promise<DeviceOutput> {
    const reject = (code: string, hint?: string) => ({ result: gateResult(code, hint), code });
    if (!this.deps.platform.supported()) return reject("computer_use_platform_unsupported");
    if (!this.deps.enabled()) return reject("computer_use_disabled");
    if (!owner || signal?.aborted) return reject("computer_use_session_unavailable");
    let args;
    try { args = parseDeviceInput(tool, input, this.os); }
    catch (cause) {
      const error = cause instanceof FleetHelperError ? cause : new FleetHelperError("invalid_params");
      let action: ActionArgs | undefined;
      if (tool === "computer_action" && input && typeof input === "object" && "action" in input && typeof input.action === "string" && ACTION_NAMES.has(input.action)) {
        action = { action: input.action as Action, window: "window", reason: "" };
        if ("window" in input && typeof input.window === "string" && /^w[0-9]+$/u.test(input.window)) action.window = input.window;
        if ("target" in input && typeof input.target === "string" && isElementId(input.target)) action.target = input.target;
      }
      return { result: renderError(error, action, undefined, this.os), code: `not_sent:${error.code}` };
    }
    if (tool === "computer_session") {
      if ((args as { op: string }).op === "status") return withOk(renderSessionStatus(true, this.client?.live ? this.client.hello : null, this.activeTool ?? "idle"));
      if (this.owner && this.owner !== owner) return reject("computer_use_foreign_session");
      await this.stop();
      return withOk(renderSessionEnd(true));
    }
    if (this.busy || this.stopping || (this.owner && this.owner !== owner)) return reject("computer_use_busy", "Another session owns Computer Use. Stop it in Settings before switching.");
    this.busy = true;
    this.activeTool = tool;
    this.startedAt = Date.now();
    this.stage = "installation";
    this.cleanupStatus = "not_requested";
    this.cleanupFailure = null;
    this.lifetime ??= new AbortController();
    const lifetime = this.lifetime;
    const onAbort = () => this.stopDetached();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.owner) {
      this.owner = owner;
      this.deps.onActiveOwnerChange?.(owner);
    }
    let output: DeviceOutput | undefined;
    let clipboard: ClipboardRestoration | undefined;
    let sent = false;
    let permissionRequest: PermissionRequestOutcome | undefined;
    try {
      this.assertActive(lifetime);
      const client = await this.startHelper(lifetime);
      this.assertActive(lifetime);
      permissionRequest = await this.requestMissingPermissions(client);
      this.assertActive(lifetime);
      this.state = "running";
      this.stage = "helper_request";
      const actor = caller?.actor ?? owner;
      switch (tool) {
        case "computer_apps": output = withOk(await this.list(client, (args as { query?: string }).query, lifetime)); break;
        case "computer_open": output = await this.open(args as OpenArgs, lifetime); break;
        case "computer_state": output = withOk(await this.observe(client, args as StateArgs, actor, lifetime, caller)); break;
        case "computer_action": {
          const action = args as ActionArgs;
          const work = this.act(client, action, actor, lifetime, (value) => { clipboard = value; }, () => { sent = true; });
          if (action.action === "paste") this.clipboardCleanup = work.then(() => clipboard, () => clipboard);
          try { output = await work; }
          finally { this.clipboardCleanup = null; }
          break;
        }
        case "computer_verify": output = await this.verify(client, args as VerifyArgs, lifetime); break;
      }
      this.assertActive(lifetime);
      return output!;
    } catch (cause) {
      if (lifetime.signal.aborted || signal?.aborted) return output = reject("computer_use_stopped");
      let error = cause instanceof FleetHelperError ? cause : new FleetHelperError("internal", sent);
      if (error.code === "permission_required" && permissionRequest) error = new FleetHelperError(error.code, error.uncertain, { ...error.details, request: permissionRequest });
      if (tool === "computer_state" || tool === "computer_action" || tool === "computer_verify") {
        if (error.code === "window_unavailable") this.publishCapture();
        else if (error.code === "permission_required" && Array.isArray(error.details?.missing) && error.details.missing.includes("accessibility")) this.publishCapture(undefined, "accessibility_permission_required");
      }
      const code = error.uncertain ? "dispatch_unknown" : tool === "computer_action" ? `not_sent:${error.code}` : error.code;
      return output = { result: renderError(error, tool === "computer_action" ? args as ActionArgs : undefined, clipboard, this.os), code };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.lastCall = { tool, outcome: output?.result.isError ? "error" : "returned", elapsedMs: Math.max(0, Date.now() - this.startedAt!), error: output?.result.isError ? output.code : null };
      this.busy = false;
      this.activeTool = null;
      this.startedAt = null;
      this.stage = null;
      if (!lifetime.signal.aborted) {
        this.state = this.client?.live ? "ready" : "idle";
        this.idleTimer = setTimeout(() => this.stopDetached(), IDLE_TIMEOUT_MS);
        this.idleTimer.unref();
      }
    }
  }

  private assertActive(lifetime: AbortController) {
    if (lifetime.signal.aborted || !this.deps.enabled()) throw new FleetHelperError("computer_use_stopped");
  }

  private async startHelper(lifetime: AbortController) {
    if (this.client?.live && !(await this.permissionsGrantedSince(this.client))) return this.client;
    const old = this.client;
    if (old) {
      await old.stop();
      this.assertActive(lifetime);
      this.resetReferences();
    }
    this.state = "starting";
    if (await this.inspectInstallation() !== "available") throw new FleetHelperError("helper_missing");
    this.assertActive(lifetime);
    this.stage = "hello";
    const client = this.client = this.deps.platform.createClient();
    try {
      const hello = await client.start();
      if (this.client === client) this.selfCheckFailed = this.failedSelfCheck(client, hello);
    }
    catch (error) { await client.stop(); if (this.client === client) this.client = null; throw error; }
    return client;
  }

  /**
   * hello의 권한과 자가 점검은 그 헬퍼 프로세스가 사는 동안 고정이다. 시작 때 빠졌던 권한을 사용자가
   * 준 뒤에는 헬퍼를 새로 띄워야 새 hello가 그 권한으로 판정된다. 화면 기록 허용은 이미 떠 있는
   * 프로세스에 반영되지 않을 수 있으므로 다시 읽기보다 재시작한다.
   */
  private duePermissions(missing: readonly ComputerUsePermission[], now: number) {
    return missing.filter((permission) => now - (this.permissionRequestedAt.get(permission) ?? -Infinity) >= PERMISSION_REQUEST_INTERVAL_MS);
  }

  /**
   * 빠진 권한을 헬퍼 한 번의 요청으로 macOS에 묻는다. 헬퍼의 판정 대상(헬퍼를 띄운 앱) 이름으로 요청 창이 뜨고 목록에 오른다.
   * 손쉬운 사용이 아직 없으면 헬퍼는 화면 기록을 미뤄 두었다가 손쉬운 사용이 켜지는 즉시 묻는다(손쉬운 사용 창이 떠 있는 동안의
   * 화면 기록 요청은 macOS가 창 없이 버렸다). 헬퍼가 실제로 물은 권한만 간격 기록에 넣는다. 미룬 화면 기록은 기록하지 않으므로,
   * 사람이 손쉬운 사용을 거부했거나 헬퍼가 그사이 내려가도 다음 호출이 다시 이어 건다.
   */
  private async sendPermissionRequests(client: FleetHelperClient, due: readonly ComputerUsePermission[], now: number) {
    const reply = await client.request("requestPermissions", { permissions: [...due] });
    const requested = due.filter((permission) => reply.requested?.includes(permission));
    const deferred = due.filter((permission) => reply.deferred?.includes(permission));
    for (const permission of requested) this.permissionRequestedAt.set(permission, now);
    return { requested, deferred };
  }

  /**
   * 컴퓨터유즈가 처음 필요해질 때 빠진 권한을 묻는다. 둘 다 빠졌으면 손쉬운 사용 창이 먼저 뜨고, 사람이 켜는 즉시 화면 기록 창이
   * 이어서 뜬다. 요청 창과 시스템 설정 목록에는 헬퍼를 띄운 앱(TCC 판정 대상)이 올라가므로 사람이 + 로 앱을 찾아 넣지 않아도 된다.
   * 허용 뒤 다음 호출에서 permissionsGrantedSince가 헬퍼를 새로 띄운다. 이번 호출이 새로 보낸 것이 없고 간격 안에 물은 권한이
   * 있으면(화면 기록이 손쉬운 사용을 기다리는 중 포함) "recent"다.
   */
  private async requestMissingPermissions(client: FleetHelperClient, now = Date.now()): Promise<PermissionRequestOutcome | undefined> {
    const granted = client.hello?.permissions;
    if (!granted) return undefined;
    const missing = COMPUTER_USE_PERMISSIONS.filter((permission) => !granted[permission]);
    if (!missing.length) return undefined;
    const due = this.duePermissions(missing, now);
    const recent = due.length < missing.length ? "recent" : undefined;
    if (!due.length) return recent;
    try { return (await this.sendPermissionRequests(client, due, now)).requested.length ? "requested" : recent; }
    catch (error) { this.reportFailure("computer_use_permission_request_failed", error); return undefined; }
  }

  /**
   * 설정 화면의 "권한 요청". 간격 안에 이미 물었으면 macOS가 창을 다시 띄우지 않을 수 있으므로(한 번 거절된 요청은 다시 묻지 않는다)
   * 그때는 해당 시스템 설정 화면을 연다. 헬퍼가 떠 있지 않으면 새로 띄워 요청한다. 화면 기록을 미뤘으면 그 헬퍼를 에이전트 헬퍼로
   * 넘겨 감시가 살아 있게 하고, 아니면 바로 내린다.
   */
  async requestPermissions(): Promise<{ requested: ComputerUsePermission[] } | { opened: boolean } | null> {
    const { supported, helperAvailable, missingPermissions } = await this.readStatus();
    if (!supported || !helperAvailable || !missingPermissions?.length) return null;
    const now = Date.now();
    const due = this.duePermissions(missingPermissions, now);
    if (!due.length) return { opened: await this.deps.platform.openPrivacySettings(missingPermissions) };
    const live = this.client?.live ? this.client : null;
    const client = live ?? this.deps.platform.createClient();
    const stops = this.stops;
    let requested: ComputerUsePermission[];
    let kept = false;
    try {
      if (!live) await client.start();
      let deferred: ComputerUsePermission[];
      ({ requested, deferred } = await this.sendPermissionRequests(client, due, now));
      kept = !live && deferred.length > 0 && stops === this.stops && this.keepPermissionHelper(client);
    } finally {
      if (!live && !kept) await client.stop();
    }
    return requested.length ? { requested } : { opened: await this.deps.platform.openPrivacySettings(missingPermissions) };
  }

  /**
   * 화면 기록을 미룬 요청 헬퍼를 에이전트 헬퍼 자리에 둔다. 그 헬퍼의 감시가 손쉬운 사용이 켜지는 즉시 화면 기록을 묻는다(에이전트 첫
   * 사용과 같다). 소유자 없이 유휴 타이머만 걸므로, 에이전트가 쓰지 않으면 감시 기한(5분)과 같은 때 `stop()`으로 내려간다. 그사이
   * 에이전트가 시작하면 이 헬퍼를 이어 쓰고, 다시 누르면 새 헬퍼를 띄우지 않고 이 헬퍼로 묻는다. 에이전트 호출이 진행 중이거나
   * 자리에 다른 헬퍼(내려가는 중 포함)가 있거나 정지 중이면 넘기지 않는다. 요청 도중 멈췄으면 호출자가 넘기지 않는다. 넘기지 않으면
   * 호출자가 내리고, 예전처럼 다음 누름이 다시 묻는다.
   */
  private keepPermissionHelper(client: FleetHelperClient): boolean {
    if (this.client || this.busy || this.stopping || !client.live) return false;
    this.client = client;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stopDetached(), IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
    return true;
  }

  private async permissionsGrantedSince(client: FleetHelperClient): Promise<boolean> {
    const started = client.hello?.permissions;
    if (!started || COMPUTER_USE_PERMISSIONS.every((permission) => started[permission])) return false;
    const now = await this.deps.platform.readPermissions();
    return now !== null && COMPUTER_USE_PERMISSIONS.some((permission) => !started[permission] && now[permission]);
  }

  private resetReferences() {
    this.windows.clear();
    this.liveWindows.clear();
    this.views.clear();
  }

  private registerWindow(w: HelperWindow): KnownWindow {
    const identity = identityOf(w);
    let known = this.liveWindows.get(identity);
    if (!known) {
      known = { id: `w${++this.windowSequence}`, identity, issued: new Map(), closed: false };
      this.liveWindows.set(identity, known);
      this.windows.set(known.id, known);
    }
    return known;
  }
  private closeWindow(known: KnownWindow) {
    this.liveWindows.delete(known.identity);
    known.closed = true;
    known.issued.clear();
    for (const views of this.views.values()) views.delete(known.id);
  }
  private async windowsNow(client: FleetHelperClient, lifetime: AbortController) {
    const rows = (await client.request("windows", {})).windows.filter((w) => Number.isFinite(w.processStartedAt) && w.processStartedAt > 0);
    this.assertActive(lifetime);
    const live = new Set(rows.map(identityOf));
    for (const known of this.liveWindows.values()) if (!live.has(known.identity)) this.closeWindow(known);
    return rows;
  }
  private async resolveWindow(client: FleetHelperClient, id: string, lifetime: AbortController, viewOnly = false) {
    const known = this.windows.get(id);
    if (!known || known.closed) throw unavailable(known?.closed ? "closed" : undefined);
    const windows = await this.windowsNow(client, lifetime);
    const window = windows.find((w) => identityOf(w) === known.identity);
    if (!window) throw unavailable("closed");
    const reason = availableReason(window, viewOnly);
    if (reason) throw unavailable(reason);
    return { known, window };
  }

  private async list(client: FleetHelperClient, query: string | undefined, lifetime: AbortController) {
    if (!query) return renderApps((await this.windowsNow(client, lifetime)).map((w) => windowLine(this.registerWindow(w).id, w, this.os)), undefined);
    const result = await client.request("windows", { query });
    this.assertActive(lifetime);
    return renderApps(result.windows.filter((w) => w.processStartedAt > 0).map((w) => windowLine(this.registerWindow(w).id, w, this.os)), result.installed);
  }

  private async open(args: OpenArgs, lifetime: AbortController) {
    const resolved = await this.deps.platform.resolveApp(args.app, lifetime.signal);
    this.assertActive(lifetime);
    if ("error" in resolved) throw new InvalidComputerUseParameters((this.os === "win32" ? {
      exact_target_required: "Use an absolute .exe or .lnk path, an exact AppUserModelID, or an exact Start menu app name.",
      unambiguous_target_required: "That name did not match exactly one Start menu app; use the absolute .exe or .lnk path.",
      installed_target_required: "Use an existing .exe or .lnk path.",
    } : {
      exact_target_required: "Use an exact .app path or an unambiguous bundle ID.",
      unambiguous_target_required: "Bundle ID did not match exactly one installation; use the exact .app path.",
      installed_target_required: "Use an existing .app bundle path.",
    })[resolved.error]);
    const { app } = resolved;
    this.views.clear();
    this.publishCapture();
    const opened = await this.deps.platform.openApp(app, lifetime.signal, args.activate === true);
    const result = renderOpen(opened.requestDispatched, Boolean(opened.error), app);
    return { result, code: result.isError ? opened.requestDispatched ? "dispatch_unknown" : "not_sent:open_failed" : "ok" };
  }

  private rememberElements(known: KnownWindow, elements: HelperElement[]): void {
    if (known.closed) return;
    for (const { ref, role, actions, settable } of elements) {
      if (isElementId(ref)) known.issued.set(ref, { role, actions, settable });
    }
  }

  private issuedElement(known: KnownWindow, ref: string) {
    const element = known.issued.get(ref);
    if (!element) throw new FleetHelperError("stale_element");
    return element;
  }

  private async observe(client: FleetHelperClient, args: StateArgs, actor: string, lifetime: AbortController, caller?: Caller) {
    const { known, window } = await this.resolveWindow(client, args.window, lifetime, args.image === true);
    if (args.expand) this.issuedElement(known, args.expand);
    const { elements, image, omitted, window: observed, viewOnly, imageNote } = await client.request("snapshot", {
      ...address(window), find: args.find, expand: args.expand, limit: args.limit ?? 200, valueLimit: 80, image: args.image ?? false,
    });
    this.assertActive(lifetime);
    if (identityOf(observed) !== known.identity) { this.closeWindow(known); throw unavailable("closed"); }
    // 필터에 보이지 않는다고 요소가 사라진 것은 아니다. 현재 동일성은 헬퍼가 확인한다.
    if (!args.expand) this.rememberElements(known, elements);
    this.apps.add(window.app);
    if (client.hello?.permissions.accessibility === false) this.publishCapture(undefined, "accessibility_permission_required");
    else this.publishCapture(window.startedAtSource === "kernel" ? undefined : observed);
    let view: string | undefined;
    if (args.image && image && caller?.canDeliver?.() !== false && image.width > 0 && image.height > 0 && ["image/png", "image/jpeg"].includes(image.mime) && image.data) {
      view = `v${++this.viewSequence}`;
      const views = this.views.get(actor) ?? new Map();
      views.set(args.window, { id: view, frame: { ...observed.frame }, width: image.width, height: image.height });
      this.views.set(actor, views);
    }
    const result = renderState(args.window, observed, elements, omitted, args.expand, view, viewOnly === true, this.os, imageNote);
    return view && image ? { ...result, content: [...result.content, { type: "image", data: image.data, mimeType: image.mime }] } : result;
  }

  private async act(client: FleetHelperClient, args: ActionArgs, actor: string, lifetime: AbortController, onClipboard: (value: ClipboardRestoration) => void, didSend: () => void): Promise<DeviceOutput> {
    try { await client.ensureInputAllowed(); }
    finally { this.selfCheckFailed = this.failedSelfCheck(client); }
    // foreground 대체 경로는 macOS 헬퍼만 가진다. Windows는 메시지 경로와 UIA+전경 복원(결정 b753a115)으로 대신한다.
    if (args.foreground && this.os === "win32") throw new InvalidComputerUseParameters("foreground is not supported on Windows; controls without a background path already borrow focus briefly and restore it.");
    this.assertActive(lifetime);
    const { window, known } = await this.resolveWindow(client, args.window, lifetime);
    const element = args.target ? this.issuedElement(known, args.target) : undefined;
    const end = dragPoint(args.to);
    const point = args.x !== undefined && args.y !== undefined ? { x: args.x, y: args.y } : undefined;
    const view = point || end ? this.views.get(actor)?.get(args.window) : undefined;
    if (point || end) {
      if (!view || args.view !== view.id || !sameFrame(view.frame, window.frame)) {
        if (view && !sameFrame(view.frame, window.frame)) this.views.get(actor)?.delete(args.window);
        throw new FleetHelperError("coordinates_need_image");
      }
      if ((point && !pointInView(point, view)) || (end && !pointInView(end, view))) throw new InvalidComputerUseParameters("Coordinates must be inside the image.");
    }
    if (args.to && !end) this.issuedElement(known, args.to);
    if (args.action === "drag" && ["chromium", "electron", "catalyst"].includes(window.engine)) throw new FleetHelperError("drag_unsupported", false, { settableSlider: element?.role === "AXSlider" && element.settable === true });
    const name = args.action === "ax_action" ? element?.actions?.find((raw) => offeredAction(raw) === args.name) : undefined;
    if (args.action === "ax_action" && !name) throw new FleetHelperError("invalid_name");
    this.assertActive(lifetime);
    this.publishCapture(window.startedAtSource === "kernel" ? undefined : window);
    const target = { ...address(window), ref: args.target };
    let clipboard: ClipboardRestoration | undefined;
    let lease: ClipboardLease | undefined;
    let params: object;
    if (args.action === "paste") {
      // paste는 cmd+v 키라 화면에 없는 창에는 닿지 않는다. 포커스와 클립보드를 건드리기 전에 거절한다.
      if (window.hidden || window.minimized) throw new FleetHelperError("needs_visible_window", false, { reason: window.hidden ? "hidden" : "minimized" });
      const focus = await client.request("focus", target);
      if (!focus.editable) throw new FleetHelperError("no_editable_focus");
      this.assertActive(lifetime);
      try {
        const text = args.text!;
        const html = args.format === "md" ? await marked.parse(text, { async: false }) : args.format === "html" ? text : undefined;
        lease = await this.deps.platform.preparePaste({ text, ...(html === undefined ? {} : { html }) }, lifetime.signal);
      }
      catch { throw new FleetHelperError("clipboard_prepare_failed"); }
      // 일반 텍스트 붙여넣기만 헬퍼가 같은 문자열이 늘었는지로 검증한다. md·html은 필드 값이 원문과 달라 관측 결과를 그대로 쓴다.
      const plain = args.format === undefined || args.format === "text";
      params = { ...target, ref: args.target ?? focus.focusedRef, action: "key", key: "cmd+v", requireEditableFocus: true, ...(plain ? { text: args.text } : {}) };
    } else {
      params = { ...target, action: args.action, expectedFrame: view?.frame, name, ...point, text: args.text, key: args.key, direction: args.direction, pages: args.pages, foreground: args.foreground, menu: args.menu, to: end ?? (args.to ? { ref: args.to } : undefined) };
    }
    let reply;
    try {
      this.assertActive(lifetime);
      reply = await client.request("act", params);
      if (!reply.sent || !reply.via || !["ax", "event", "event+focus", "foreground", "message", "message+keystate", "uia"].includes(reply.via)) throw new FleetHelperError("timeout", true);
      didSend();
    } finally {
      if (lease) {
        try { clipboard = await lease.finish(); } catch { clipboard = "failed"; }
        onClipboard(clipboard);
      }
    }
    this.assertActive(lifetime);
    const changes: string[] = [];
    for (const change of reply.windowsChanged ?? []) {
      if (change.op === "+" && change.window.processStartedAt > 0 && change.window.onCurrentSpace && change.window.title.trim()) {
        changes.push(`+ ${windowLine(this.registerWindow(change.window).id, change.window, this.os)}`);
      }
      if (change.op === "-") {
        const closed = this.liveWindows.get(identityOf(change.window));
        if (closed) {
          this.closeWindow(closed);
          changes.push(`- ${windowLine(closed.id, change.window, this.os)}`);
          if (closed === known) this.publishCapture();
        }
      }
    }
    // 헬퍼가 보조 창 변경만 보고 관측을 끝냈다면, 변화 없음으로 단정할 수 없다.
    const onlyWindowNoise = reply.observation === "changes" && reply.windowsChanged?.length && !changes.length && !reply.changes.length && !reply.changesMore;
    const { result, code, exposed } = renderAction(args, onlyWindowNoise ? { ...reply, observation: "unobservable" } : reply, changes, clipboard, this.os);
    this.rememberElements(known, exposed);
    return { result, code };
  }

  private async verify(client: FleetHelperClient, args: VerifyArgs, lifetime: AbortController): Promise<DeviceOutput> {
    const unknown = (reason: string, index = 0) => ({ result: renderVerify({ status: "unknown", reason, index, waitedMs: 0 }, args.expect), code: "unknown" });
    try {
      const { window, known } = await this.resolveWindow(client, args.window, lifetime);
      const stale = args.expect.findIndex((condition) => condition.target && !known.issued.has(condition.target));
      if (stale >= 0) return unknown("stale_element", stale);
      this.publishCapture(window.startedAtSource === "kernel" ? undefined : window);
      const expect = args.expect.map(({ target, role, ...rest }) => ({ ...rest, ref: target, role: role ? nativeRole(role) : undefined }));
      const reply = await client.request("verify", { ...address(window), expect, timeoutMs: args.timeoutMs ?? 0 });
      this.assertActive(lifetime);
      return { result: renderVerify(reply, args.expect), code: reply.status };
    } catch (error) {
      if (error instanceof FleetHelperError && error.code === "window_unavailable") { this.publishCapture(); return unknown("window_unavailable"); }
      throw error;
    }
  }
}

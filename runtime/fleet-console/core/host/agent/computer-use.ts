import crypto from "node:crypto";
import { z } from "zod";
import type { AgentToolSpec } from "@dotobokuri/core-agent";
import { COMPUTER_USE_ACTIONS as ACTIONS, ComputerUseInputError, isRecord, type ComputerUseWindowIdentity, type ComputerUseAppTarget, type ComputerUseBackend, type ComputerUsePlatform, type ComputerUseResult } from "./computer-use-platform.js";

const IDLE_TIMEOUT_MS = 5 * 60_000;
type ObservationMode = "text" | "text_and_image";
const OBSERVATION_SCHEMA = { type: "string", enum: ["text", "text_and_image"], default: "text", description: "Model output only; native capture is unchanged. Default text omits images. Request text_and_image for visual verification or before coordinate actions; use the resulting fresh snapshotId." };
const ACTIVATION_SCHEMA = { type: "boolean", default: false, description: "Explicit permission for this call to launch/activate/restore the target app. Default false requires a currently focused, non-minimized window (best-effort check, not background support). Set true only when foreground use is authorized by the task, never automatically to bypass an error." };

function contentMetrics(content: ComputerUseResult["content"]) {
  return {
    textChars: content.reduce((sum, block) => sum + (block.type === "text" && typeof block.text === "string" ? block.text.length : 0), 0),
    imageCount: content.filter((block) => block.type === "image").length,
    imageBytes: content.reduce((sum, block) => sum + (block.type === "image" && typeof block.data === "string" ? Buffer.byteLength(block.data, "base64") : 0), 0),
  };
}

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
  readonly threadReleaseStatus: ComputerUseBackend["threadReleaseStatus"];
  readonly cleanupFailure: ComputerUseBackend["cleanupFailure"];
  readonly captureStopped: "unverified";
  readonly error: string | null;
  readonly lastCall: { readonly tool: string; readonly outcome: string; readonly elapsedMs: number; readonly error: string | null } | null;
}

function result(value: unknown, isError = false): ComputerUseResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError };
}

/** 데스크톱 하나를 여러 thread가 동시에 조작하지 않도록 소유자와 호출을 묶는다. */
export class ComputerUseService {
  private broker: ComputerUseBackend | null = null;
  private owner: string | null = null;
  private captureApp: string | null = null;
  private captureUnavailable = false;
  private controller: AbortController | null = null;
  private busy = false;
  private state: ComputerUseStatus["state"] = "idle";
  private readonly apps = new Set<string>();
  private readonly snapshots = new Map<string, { id: string; at: number; imageAvailable: boolean; imageDelivered: boolean }>();
  private readonly lastAgentActions = new Map<string, { action: string; outcome: "unknown" | "returned" | "error"; at: string }>();
  private readonly deliveredSchemas = new Set<string>();
  private appTargets: ComputerUseAppTarget[] = [];
  private installation: ComputerUseStatus["installation"] = "unchecked";
  private warning: string | null = null;
  private cleanupStatus: ComputerUseStatus["cleanupStatus"] = "not_requested";
  private threadReleaseStatus: ComputerUseBackend["threadReleaseStatus"] = "not_requested";
  private cleanupFailure: ComputerUseBackend["cleanupFailure"] = null;
  private error: string | null = null;
  private lastCall: ComputerUseStatus["lastCall"] = null;
  private activeTool: string | null = null;
  private startedAt: number | null = null;
  private stage: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;

  constructor(private readonly deps: {
    readonly directory: string;
    readonly enabled: () => boolean;
    readonly localControl: () => boolean;
    readonly platform: ComputerUsePlatform;
    readonly diagnostic?: (event: ComputerUseDiagnostic) => void;
    readonly onCaptureTarget?: (target: (ComputerUseWindowIdentity & { owner: string }) | null) => void;
  }) {}

  status(): ComputerUseStatus {
    const enabled = this.deps.enabled();
    return {
      enabled, supported: this.deps.platform.supported(),
      installation: this.installation, warning: this.warning,
      state: !enabled ? "off" : this.state,
      activeTool: this.activeTool, elapsedMs: this.startedAt === null ? 0 : Math.max(0, Date.now() - this.startedAt), stage: this.stage,
      apps: [...this.apps], cleanupStatus: this.cleanupStatus, threadReleaseStatus: this.threadReleaseStatus, cleanupFailure: this.cleanupFailure, captureStopped: "unverified", error: this.error, lastCall: this.lastCall,
    };
  }

  async inspectInstallation(): Promise<ComputerUseStatus["installation"]> {
    if (!this.status().supported) return this.installation = "unsupported";
    try { return this.installation = await this.deps.platform.inspectInstallation() ? "available" : "missing"; }
    catch { return this.installation = "missing"; }
  }

  async readStatus(): Promise<ComputerUseStatus> {
    await this.inspectInstallation();
    return this.status();
  }

  async verifyCaptureTarget(target: ComputerUseWindowIdentity): Promise<boolean> {
    return this.deps.enabled() && this.deps.localControl() && await (this.deps.platform.verifyCaptureTarget?.(target) ?? false);
  }

  activeOwner(): string | null { return this.state === "stopping" ? null : this.owner; }
  captureUnavailableOwner(): string | null { return this.captureUnavailable ? this.activeOwner() : null; }

  release(owner: string): void { if (this.owner === owner) void this.stop(); }
  /** 소유자 라벨이 조건에 맞으면 놓는다 — 연결별 접두를 모르는 호출자(허용 회수 라우트)용. */
  releaseWhere(predicate: (owner: string) => boolean): void { if (this.owner !== null && predicate(this.owner)) void this.stop(); }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.state = "stopping";
    this.captureApp = null;
    this.captureUnavailable = false;
    this.deps.onCaptureTarget?.(null);
    this.controller?.abort();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.apps.clear();
    this.lastAgentActions.clear();
    this.deliveredSchemas.clear();
    this.appTargets = [];
    this.snapshots.clear();
    const broker = this.broker;
    this.broker = null;
    this.stopping = Promise.resolve().then(async () => {
      try {
        await broker?.stop();
        if (broker) {
          this.cleanupStatus = broker.cleanupStatus;
          this.threadReleaseStatus = broker.threadReleaseStatus;
          this.cleanupFailure = broker.cleanupFailure;
          this.warning = this.cleanupStatus === "failed" ? "computer_use_cleanup_unconfirmed" : null;
        }
      } finally {
        this.owner = null;
        this.controller = null;
        this.state = "idle";
        this.stopping = null;
      }
    });
    return this.stopping;
  }

  specs(): AgentToolSpec[] {
    const spec = (id: string, description: string, parameters: Record<string, unknown>): AgentToolSpec => ({
      id, tag: id, title: id, promptSnippet: "", whenToUse: [], whenNotToUse: [], usageGuidelines: [], description, parameters,
      execute: (args, context) => this.execute(id, args, context.sessionLabel, context.signal),
    });
    return [
      { ...spec("computer_end", this.deps.platform.toolDescriptions.computer_end, { type: "object", properties: {}, additionalProperties: false }), execute: async (_args, context) => {
        if (!context.sessionLabel) return result({ error: "computer_use_session_unavailable" }, true);
        if (this.owner && this.owner !== context.sessionLabel) return result({ error: "computer_use_foreign_session" }, true);
        await this.stop();
        return result({ ended: true, cleanupStatus: this.cleanupStatus, threadReleaseStatus: this.threadReleaseStatus, cleanupFailure: this.cleanupFailure, captureStopped: "unverified", reconnect: "on_next_use", warning: this.warning, hint: this.deps.platform.endHint });
      } },
      { ...spec("computer_status", this.deps.platform.toolDescriptions.computer_status, { type: "object", properties: {}, additionalProperties: false }), execute: async () => { const { apps: _apps, ...status } = await this.readStatus(); return result(status); } },
      spec("computer_apps", this.deps.platform.toolDescriptions.computer_apps, { type: "object", properties: { query: { type: "string", maxLength: 4096, description: "Optional app name, bundle ID or path search." }, includeWindowState: { type: "boolean", description: "Read window state without capture or activation. Requires query; inspects at most 20 matched installations and reports truncation." } }, additionalProperties: false }),
      spec("computer_open", this.deps.platform.toolDescriptions.computer_open, { type: "object", properties: { app: { type: "string", minLength: 1, maxLength: 4096, description: "Exact absolute .app installation path observed in computer_apps or supplied by the user. No bundle IDs or name lookup." }, reason: { type: "string", minLength: 1, maxLength: 600 }, activate: { type: "boolean", default: false, description: "Default false requests background launch/reopen. The app may still activate itself; not a focus guarantee. Set true only when foreground opening is authorized." } }, required: ["app", "reason"], additionalProperties: false }),
      spec("computer_state", this.deps.platform.toolDescriptions.computer_state, { type: "object", properties: { app: { ...this.deps.platform.appTargetSchema }, observation: { ...OBSERVATION_SCHEMA }, allowActivation: { ...ACTIVATION_SCHEMA }, fullTree: { type: "boolean", description: "Require a standalone full AX tree, e.g. after context loss. Makes one native read; returns an error without a snapshot if the backend returns only a diff. Does not request additional images or action schemas." }, includeActionSchemas: { type: "boolean", description: "Request the full action schemas again, for example after context compaction. Otherwise returned once per schema version in this broker session." } }, required: ["app"], additionalProperties: false }),
      spec("computer_paste", this.deps.platform.toolDescriptions.computer_paste, {
        type: "object", properties: {
          app: { ...this.deps.platform.appTargetSchema }, snapshotId: { type: "string" },
          text: { type: "string", minLength: 1, maxLength: 100_000 }, format: { type: "string", enum: ["text", "md", "html"] },
          reason: { type: "string", minLength: 1, maxLength: 600 }, observation: { ...OBSERVATION_SCHEMA }, allowActivation: { ...ACTIVATION_SCHEMA },
        }, required: ["app", "snapshotId", "text", "format", "reason"], additionalProperties: false,
      }),
      spec("computer_action", this.deps.platform.toolDescriptions.computer_action, {
        type: "object", properties: {
          app: { ...this.deps.platform.appTargetSchema }, snapshotId: { type: "string" }, action: { type: "string", enum: [...ACTIONS] },
          arguments: { type: "object", description: "Upstream arguments excluding app. Get the exact schema from computer_state's actionSchemas." },
          reason: { type: "string", minLength: 1, maxLength: 600 },
          observation: { ...OBSERVATION_SCHEMA },
          allowActivation: { ...ACTIVATION_SCHEMA },
        }, required: ["app", "snapshotId", "action", "arguments", "reason"], additionalProperties: false,
      }),
    ];
  }

  private async execute(tool: string, input: unknown, owner: string | undefined, signal?: AbortSignal): Promise<ComputerUseResult> {
    const startedAt = Date.now();
    const value = await this.executeInternal(tool, tool === "computer_paste" && isRecord(input) ? { ...input, action: "paste", arguments: { text: input.text, format: input.format } } : input, owner, signal);
    // Project at the final boundary, including native errors and recovery reads.
    const textOnly = (tool === "computer_state" || tool === "computer_action" || tool === "computer_paste") && (!isRecord(input) || input.observation !== "text_and_image");
    const output = textOnly ? { ...value, content: value.content.filter((block) => block.type !== "image") } : value;
    try {
      this.deps.diagnostic?.({ tool, scope: "model_output", phase: "end", elapsedMs: Date.now() - startedAt, outcome: output.isError ? "error" : "returned", ...contentMetrics(output.content) });
    } catch { /* Output accounting must never retry an action. */ }
    return output;
  }

  private async executeInternal(tool: string, input: unknown, owner: string | undefined, signal?: AbortSignal): Promise<ComputerUseResult> {
    if (!this.deps.enabled()) return result({ error: "computer_use_disabled" }, true);
    if (!this.status().supported) return result({ error: this.deps.platform.unavailableError }, true);
    if (!this.deps.localControl()) return result({ error: "computer_use_local_only" }, true);
    if (!owner || signal?.aborted) return result({ error: "computer_use_session_unavailable" }, true);
    if (this.busy || this.stopping || (this.owner && this.owner !== owner)) return result({ error: "computer_use_busy", hint: "Another session owns Computer Use. Stop it in Settings before switching." }, true);
    if (!isRecord(input)) return result({ error: "invalid_arguments" }, true);
    if (tool === "computer_apps" && ((input.query !== undefined && (typeof input.query !== "string" || input.query.length > 4096)) || (input.includeWindowState !== undefined && typeof input.includeWindowState !== "boolean") || (input.includeWindowState === true && (typeof input.query !== "string" || !input.query.trim())))) return result({ error: "computer_use_invalid_window_query", hint: "Window inspection requires a nonempty query. Use an exact installation path to limit the read." }, true);
    if (tool === "computer_open" && ((input.activate !== undefined && typeof input.activate !== "boolean") || typeof input.app !== "string" || !input.app.startsWith("/") || !input.app.endsWith(".app") || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 600)) return result({ error: "computer_use_invalid_open", actionOutcome: "not_started", hint: "Use the exact absolute .app path and a reason authorizing foreground launch/reopen." }, true);
    if ((tool === "computer_state" || tool === "computer_action" || tool === "computer_paste") && input.observation !== undefined && input.observation !== "text" && input.observation !== "text_and_image") return result({ error: "computer_use_invalid_observation", actionOutcome: "not_started" }, true);
    if (tool === "computer_state" && input.fullTree !== undefined && typeof input.fullTree !== "boolean") return result({ error: "computer_use_invalid_full_tree", actionOutcome: "not_started" }, true);
    if (input.allowActivation !== undefined && typeof input.allowActivation !== "boolean") return result({ error: "computer_use_invalid_activation", actionOutcome: "not_started" }, true);
    const observationMode: ObservationMode = input.observation === "text_and_image" ? "text_and_image" : "text";
    let app = tool === "computer_apps" ? null : input.app;
    if (app !== null) {
      if (typeof app !== "string" || !app.trim() || app !== app.trim() || app.length > 4096 || /[\x00-\x1f\x7f]/u.test(app)) return result({ error: "computer_use_invalid_app_target" }, true);
      try { app = await this.deps.platform.resolveTarget(app); }
      catch (error) { if (error instanceof ComputerUseInputError) return result({ error: error.message }, true); throw error; }
    }
    if (this.busy || this.stopping || (this.owner && this.owner !== owner)) return result({ error: "computer_use_busy" }, true);
    if (!this.deps.enabled() || !this.deps.localControl() || signal?.aborted) return result({ error: "computer_use_session_unavailable" }, true);
    this.busy = true;
    this.activeTool = tool;
    this.startedAt = Date.now();
    this.stage = "installation";
    this.cleanupStatus = "not_requested";
    this.threadReleaseStatus = "not_requested";
    this.cleanupFailure = null;
    this.warning = null;
    this.owner = owner;
    this.controller ??= new AbortController();
    const lifetime = this.controller;
    const onAbort = () => { void this.stop(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (this.idleTimer) clearTimeout(this.idleTimer);
    let actionText: readonly Record<string, unknown>[] = [];
    let actionOutcome: "not_started" | "unknown" | "completed" | "error" = "not_started";
    try {
      if (tool === "computer_open") {
        this.assertActive(lifetime);
        this.snapshots.clear();
        this.captureApp = null;
        this.captureUnavailable = false;
        this.deps.onCaptureTarget?.(null);
        this.state = "running";
        this.stage = "open_app";
        actionOutcome = "unknown";
        const opened = await this.deps.platform.openApp(app as string, lifetime.signal, input.activate === true);
        actionOutcome = opened.requestDispatched ? "completed" : "not_started";
        this.assertActive(lifetime);
        return result({ ...opened, activateRequested: input.activate === true, focusGuaranteed: false, actionOutcome, snapshotId: null, retryPerformed: false, hint: opened.windowReady ? "A non-minimized window exists, not a captured observation or focus guarantee. computer_state may activate the app when allowActivation:true; do not capture when the task requires keeping focus elsewhere." : "No window matching the requested readiness was verified. Do not retry automatically, switch installations, force-quit, or replay input. The app may need the user to open a window or finish a dialog." }, Boolean(opened.error) || !opened.windowReady);
      }
      if (!this.broker) {
        this.state = "starting";
        this.assertActive(lifetime);
        const created = await this.deps.platform.createBroker({
          directory: this.deps.directory,
          onStage: (stage) => { if (!lifetime.signal.aborted) this.stage = stage; },
          approve: async () => !lifetime.signal.aborted && this.deps.enabled() && this.deps.localControl(),
        });
        if (lifetime.signal.aborted) { await created?.stop(); throw new Error("computer_use_stopped"); }
        this.assertActive(lifetime);
        this.broker = created;
        this.installation = created ? "available" : "missing";
        if (!created) throw new Error("computer_use_install_required");
        await created.start();
      }
      this.assertActive(lifetime);
      const broker = this.broker!;
      if (tool === "computer_apps") {
        this.assertActive(lifetime);
        this.state = "running";
        this.stage = "list_apps";
        const apps = await this.call(broker, "list_apps", {});
        this.assertActive(lifetime);
        this.appTargets = this.deps.platform.appTargets(apps);
        const query = typeof input.query === "string" ? input.query.normalize("NFC").trim().toLowerCase() : "";
        const targets = query ? this.appTargets.filter((target) => [target.name, target.app, target.bundleId ?? ""].some((value) => value.normalize("NFC").toLowerCase().includes(query))) : this.appTargets;
        const windowStates = input.includeWindowState === true && !apps.isError ? await this.deps.platform.inspectWindows(targets.slice(0, 20).map((target) => target.app)) : undefined;
        this.assertActive(lifetime);
        const content = query && !apps.isError ? apps.content.filter((block) => block.type === "text").map((block) => ({ ...block, text: String(block.text).split("\n").filter((line) => line.normalize("NFC").toLowerCase().includes(query)).join("\n") })) : apps.content;
        return { ...apps, content: [...result({ source: "native app inventory", targets, ...(windowStates ? { windowStates, windowStateTruncated: targets.length > windowStates.length } : {}), query: query || null, total: this.appTargets.length, matched: targets.length, targetHint: "Copy targets[].app unchanged into computer_state and computer_action. It is an exact installation path, avoiding duplicate bundle IDs and localized names. If targets is empty, use the original inventory below; no identifier was inferred.", runningStatus: "advisory", hint: "A missing running marker does not establish that an app is closed. Do not launch or close apps based solely on this list." }).content, ...content] };
      }
      const target = app as string;
      if (tool === "computer_state") return await this.observe(broker, target, lifetime, input.includeActionSchemas === true, observationMode, input.allowActivation === true, input.fullTree === true);
      if (!((tool === "computer_action" && typeof input.action === "string" && (ACTIONS as readonly string[]).includes(input.action)) || (tool === "computer_paste" && input.action === "paste")) || typeof input.action !== "string" || !isRecord(input.arguments)
        || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 600) throw new ComputerUseInputError("computer_use_invalid_action", "Use app only at the top level. Supply action, arguments (without app), reason and the latest snapshotId from computer_state or computer_action.");
      const snapshot = this.snapshots.get(target);
      if (!snapshot || input.snapshotId !== snapshot.id || Date.now() - snapshot.at > 120_000) throw new ComputerUseInputError("computer_use_fresh_state_required", "Fleet has one valid snapshot across apps. Another app observation or a dispatched action invalidates it. Call computer_state for the intended app and use its new snapshotId. Do not repeat an earlier action just to refresh state.");
      const coordinateAction = input.action === "drag" || ((input.action === "click" || input.action === "scroll") && ("x" in input.arguments || "y" in input.arguments));
      if (coordinateAction && !snapshot.imageAvailable) throw new ComputerUseInputError("computer_use_screenshot_required", "This snapshot has no screenshot. Native menus can replace the window tree and suppress images. No action was sent. Use menu element_index and an advertised secondary action to dismiss/close the menu without selecting a command, or explicitly request Escape. Then read the window again. Never reuse pre-menu coordinates.");
      if (coordinateAction && !snapshot.imageDelivered) throw new ComputerUseInputError("computer_use_screenshot_required", "This snapshot's image was not delivered to the model. No action was sent. Call computer_state with observation:text_and_image, inspect its image and use its new snapshotId. Do not reuse coordinates from an older image.");
      if (input.action === "click" && "element_index" in input.arguments && ("x" in input.arguments || "y" in input.arguments)) throw new ComputerUseInputError("computer_use_ambiguous_target", "Choose either element_index or screenshot coordinates, not both. No action was sent.");
      const schema = broker.tools.get(input.action)?.inputSchema;
      if (!schema || "app" in input.arguments) throw new ComputerUseInputError("computer_use_invalid_action", "Use app only at the top level. Supply action, arguments (without app), reason and the latest snapshotId from computer_state or computer_action.");
      const args = this.deps.platform.prepareAction(input.action, { ...input.arguments, app: target });
      const parsed = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]).safeParse(args);
      if (!parsed.success) throw new ComputerUseInputError("computer_use_invalid_arguments", "Match actionSchemas[action] from the latest observation; app belongs only at the top level.");
      await this.deps.platform.preflight(target, input.allowActivation === true);
      this.assertActive(lifetime);
      this.snapshots.clear();
      this.state = "running";
      this.stage = input.action;
      actionOutcome = "unknown";
      // 동작 이력은 출처 단서일 뿐 현재 선택의 작성자나 효과를 증명하지 않는다.
      if (this.lastAgentActions.size >= 32 && !this.lastAgentActions.has(target)) this.lastAgentActions.delete(this.lastAgentActions.keys().next().value!);
      const lastAgentAction = { action: input.action, outcome: "unknown" as "unknown" | "returned" | "error", at: new Date().toISOString() };
      this.lastAgentActions.set(target, lastAgentAction);
      const actionResult = await this.call(broker, input.action, args, input.action === "paste" ? { allowActivation: input.allowActivation === true } : undefined);
      actionText = actionResult.content.filter((block) => block.type === "text");
      actionOutcome = actionResult.dispatchBlocked ? "not_started" : actionResult.isError ? "error" : "completed";
      this.assertActive(lifetime);
      if (actionResult.isError) {
        const error = this.deps.platform.classifyFailure(actionResult);
        return { ...actionResult, content: [...result({ actionOutcome: error === "computer_use_app_closed" ? "app_closed" : actionOutcome, error, observation: "unavailable", ...(actionResult.dispatchBlocked ? { snapshotId: null } : {}), context: { imageAvailable: snapshot.imageAvailable, snapshotAgeMs: Date.now() - snapshot.at, target: coordinateAction ? "screenshot_coordinates" : "element_index" in args ? "accessibility_element" : "keyboard", focus: "unknown", display: "unknown", appSupport: "not_determined" }, hint: this.deps.platform.failureHint(error) }).content, ...actionResult.content] };
      }
      // Native actions already return their own observation. A second read may
      // restore a just-minimized window or activate an app. Never read implicitly.
      if (!this.deps.platform.hasActionObservation(actionResult)) {
        this.captureUnavailable = true;
        this.deps.onCaptureTarget?.(null);
        return { ...actionResult, content: [...result({ actionOutcome: "completed", effectVerified: false, action: input.action, observation: "unavailable", snapshotId: null, hint: "Action returned without a usable native AX observation. No follow-up read was made. Do not repeat the action. If more observation is needed, request computer_state explicitly; reads may activate/restore the app." }).content, ...actionResult.content] };
      }
      const observation = this.publishObservation(broker, target, actionResult, false, observationMode, 0);
      return { ...observation, content: [
        ...result({ actionOutcome: "completed", effectVerified: false, action: input.action, observation: "completed", observationSource: "action_response" }).content,
        ...observation.content,
      ] };
    } catch (error) {
      if (error instanceof ComputerUseInputError) return result({ error: error.message, hint: error.hint, actionOutcome: "not_started" }, true);
      const code = error instanceof Error && /^computer_use_[a-z_]+$/.test(error.message) ? error.message : "computer_use_failed";
      this.error = code;
      await this.stop();
      return { isError: true, content: [...result({ error: code, actionOutcome, observation: "failed", hint: code === "computer_use_runtime_incompatible" ? "The CLI/native MCP handshake failed. Select compatible versions (CODEX_BIN overrides the CLI). Repeated app reads cannot repair this; no GUI action was confirmed." : actionOutcome === "completed" ? "The action returned but its observation could not be published. The following text is from the action. Do not repeat the action; explicitly request computer_state only if necessary." : "Do not retry the action automatically. Request computer_state explicitly if necessary; reads may activate/restore the app." }).content, ...actionText] };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.busy = false;
      this.activeTool = null;
      this.startedAt = null;
      this.stage = null;
      if (this.owner === owner && !lifetime.signal.aborted) {
        this.state = "ready";
        this.idleTimer = setTimeout(() => { void this.stop(); }, IDLE_TIMEOUT_MS);
      }
    }
  }

  private async observe(broker: ComputerUseBackend, app: string, lifetime: AbortController, includeSchemas = true, observationMode: ObservationMode = "text", allowActivation = false, fullTree = false): Promise<ComputerUseResult> {
    await this.deps.platform.preflight(app, allowActivation);
    this.assertActive(lifetime);
    if (this.captureApp !== app) {
      this.captureApp = app;
      this.captureUnavailable = false;
      this.deps.onCaptureTarget?.(null);
    }
    this.snapshots.clear();
    this.state = "running";
    this.stage = "get_app_state";
    const state = await this.call(broker, "get_app_state", { app });
    this.assertActive(lifetime);
    if (state.isError) { this.deps.onCaptureTarget?.(null); return state; }
    if (fullTree && !this.deps.platform.hasFullObservation(state)) {
      this.captureUnavailable = true;
      this.deps.onCaptureTarget?.(null);
      return result({ error: "computer_use_full_tree_unavailable", snapshotId: null, observationReads: 1, hint: "The native response was not a standalone App/Window tree. No diff was presented as a full tree and no extra read was made. This backend may not support forcing full trees for this surface." }, true);
    }
    return this.publishObservation(broker, app, state, includeSchemas, observationMode, 1);
  }

  private publishObservation(broker: ComputerUseBackend, app: string, state: ComputerUseResult, includeSchemas: boolean, observationMode: ObservationMode, observationReads: number): ComputerUseResult {
    const captureTarget = this.deps.platform.captureTarget?.(state);
    if (state.captureWindow !== undefined) this.captureUnavailable = state.captureWindow === null;
    // 동일 앱의 diff·메뉴 관찰은 새 창 식별자가 없어도 기존 공유를 유지한다.
    // 다른 앱으로 전환하면 위에서 먼저 해제하며, 식별 가능한 새 창을 얻은 뒤에만 공유한다.
    if (captureTarget && this.owner) this.deps.onCaptureTarget?.({ ...captureTarget, owner: this.owner });
    else if (state.captureWindow === null) this.deps.onCaptureTarget?.(null);
    const interactionHints = this.deps.platform.interactionHints(state);
    this.apps.add(this.deps.platform.displayTarget(app));
    const snapshotId = crypto.randomUUID();
    const imageAvailable = state.content.some((block) => block.type === "image" && typeof block.data === "string" && block.data.length > 0 && typeof block.mimeType === "string" && block.mimeType.startsWith("image/"));
    const imageDelivered = imageAvailable && observationMode === "text_and_image";
    this.snapshots.set(app, { id: snapshotId, at: Date.now(), imageAvailable, imageDelivered });
    const actionSchemas = this.deps.platform.actionSchemas(broker.tools);
    const actionSchemasVersion = crypto.createHash("sha256").update(JSON.stringify(actionSchemas)).digest("hex").slice(0, 16);
    const sendSchemas = includeSchemas || !this.deliveredSchemas.has(actionSchemasVersion);
    this.deliveredSchemas.add(actionSchemasVersion);
    return { isError: false, content: [...result({ app, snapshotId, observationReads, ...(interactionHints.length ? { interactionHints } : {}), snapshotScope: "broker_session", lastAgentAction: this.lastAgentActions.get(app) ?? null, imageAvailable, imageDelivered, coordinateActionsAvailable: imageDelivered ? "unverified" : false, ...(imageDelivered ? { coordinateSpace: "latest_native_screenshot_pixels" } : {}), actionSchemasVersion, actionSchemasIncluded: sendSchemas, observationMode: imageDelivered ? "image_and_text" : "text_only", ...(imageAvailable ? {} : { navigationHint: "Image unavailable; tree may be a menu. Use current menu elements/advertised secondary actions; never old coordinates." }), treeFormat: this.deps.platform.hasFullObservation(state) ? "full" : "upstream text or diff", selectionSource: "not_established", trust: "untrusted_app_content", ...(sendSchemas ? { actionSchemas } : {}) }).content, ...state.content] };
  }

  private async call(broker: ComputerUseBackend, tool: string, args: Record<string, unknown>, options?: { readonly allowActivation: boolean }): Promise<ComputerUseResult> {
    const startedAt = Date.now();
    const emit = (event: ComputerUseDiagnostic) => { try { this.deps.diagnostic?.({ ...event, scope: "native_output" }); } catch { /* 진단 실패가 조작을 반복시키면 안 된다. */ } };
    emit({ tool, phase: "start", ...(options ? { allowActivation: options.allowActivation } : {}) });
    try {
      const value = await (options ? broker.call(tool, args, options) : broker.call(tool, args));
      // 반환된 시점에 이력을 확정한 뒤 직렬화해야 액션과 후속 관찰의 값이 일치한다.
      if (tool !== "get_app_state" && typeof args.app === "string") {
        const lastAction = this.lastAgentActions.get(args.app);
        if (lastAction) lastAction.outcome = value.isError ? "error" : "returned";
      }
      const content = value.content.filter((block) => block.type === "text" || block.type === "image");
      if (tool !== "list_apps") content.unshift(...result({
        contentSource: "native_tool_output",
        observationSource: tool === "get_app_state" ? "agent_requested_observation" : "agent_action_response",
        selectionSource: tool === "select_text" && !value.isError && (!args.selection || args.selection === "text") ? "agent_requested_selection" : "not_established",
        cursorPlacement: tool === "select_text" && (args.selection === "cursor_before" || args.selection === "cursor_after") ? args.selection : null,
        trust: "untrusted_app_content",
      }).content);
      const error = value.isError ? this.deps.platform.classifyFailure(value) : null;
      if (error) content.unshift(...result({ nativeError: error, effectVerified: false, hint: this.deps.platform.failureHint(error), ...(error === "computer_use_ambiguous_app" || error === "computer_use_app_not_found" ? { candidates: this.deps.platform.appCandidates(value, args.app, this.appTargets), recovery: "Choose an exact candidate app path; if none match, call computer_apps. No alternative app was tried." } : {}), ...(tool === "press_key" ? { keyAttempted: args.key } : {}) }).content);
      this.error = error;
      this.lastCall = { tool, outcome: error === "computer_use_app_closed" ? "app_closed" : value.isError ? "error" : "returned", elapsedMs: Date.now() - startedAt, error };
      emit({ tool, phase: "end", elapsedMs: this.lastCall.elapsedMs, outcome: value.isError ? "error" : "returned", ...(error ? { error } : {}),
        ...contentMetrics(value.content),
      });
      return { content, isError: value.isError === true, ...(value.dispatchBlocked ? { dispatchBlocked: true } : {}), ...(value.captureWindow !== undefined ? { captureWindow: value.captureWindow } : {}) };
    } catch (error) {
      this.lastCall = { tool, outcome: "unknown", elapsedMs: Date.now() - startedAt, error: error instanceof Error && /^computer_use_[a-z_]+$/.test(error.message) ? error.message : "computer_use_failed" };
      emit({ tool, phase: "end", elapsedMs: Date.now() - startedAt, outcome: "unknown", error: error instanceof Error && /^computer_use_[a-z_]+$/.test(error.message) ? error.message : "computer_use_failed" });
      throw error;
    }
  }

  private assertActive(lifetime: AbortController): void {
    if (lifetime.signal.aborted || !this.deps.enabled() || !this.deps.localControl()) throw new Error("computer_use_stopped");
  }

}

export interface ComputerUseDiagnostic {
  readonly allowActivation?: boolean;
  readonly scope?: "native_output" | "model_output";
  readonly tool: string;
  readonly phase: "start" | "end";
  readonly elapsedMs?: number;
  readonly outcome?: "returned" | "error" | "unknown";
  readonly error?: string;
  readonly textChars?: number;
  readonly imageCount?: number;
  readonly imageBytes?: number;
}

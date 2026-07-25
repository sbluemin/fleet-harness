import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";

import { createCarrierResultReminderRouter, createDelayedPtyWriter, createFleetAgentRuntimeLifecycle, formatCarrierResultReminderMessage, getAgentCliAuthStatuses, getAgentCliMetadata, parseAgentCliId, sanitizeCarrierResultReminder, type AgentCliId } from "@dotobokuri/fleet-admiral";
import { createPlanWorkspaceServerBindings, getPlanToolSpecs } from "@dotobokuri/fleet-plans";
import { getCarrierConfig, resolveAgentCliType } from "@dotobokuri/fleet-carriers";
import { ensureWorkspaceDirectory, withDirectoryLock, type AuthService, type GlobalOptionsService } from "@dotobokuri/core-infra";
import { createWikiWorkspaceResolver, getWikiToolSpecs } from "@dotobokuri/fleet-wiki";
import type { OperationLaunchKind, OperationNode, OperationPatchInput } from "@fleet-console/sdk/operations";
import { registerRouter } from "@fleet-console/sdk/plugin/node";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { createWorkspaceChangeScanner } from "./shared/index.js";
import type { TerminalRuntime } from "./shared/index.js";

import { createDefaultAgentCliDetector } from "./agent-api/agent-cli-detect.js";
import { buildAgentCliLaunchKinds } from "./agent-api/agent-cli-launch-kinds.js";
import { combineAgentCliLaunchMetadata, type AgentCliLaunchMetadata } from "./agent-api/agent-cli-launch-metadata.js";
import { deriveOperationLabel } from "./agent-api/auto-name.js";
import { normalizeAttentionReason } from "./agent-api/attention-hook.js";
import { captureSession, readProviderSessionCapture, unlinkProviderSessionCapture, type ProviderSession } from "./agent-api/session-capture.js";
import { createAgentTerminalLaunchResolver, type ConsoleRuntimeSessionInfo } from "./agent-api/launch.js";
import { createConsoleObservabilityStore } from "./agent-api/observability-store.js";
import { writeAggregateObserverEvents } from "./agent-api/observability-routes.js";
import type { AgentProviderTitleMarker, AgentTerminalSessionInfo, AgentLabelSource } from "./agent-api/types.js";
type SessionCreateBody = { readonly cliId?: unknown; readonly theaterId?: unknown; readonly initialPrompt?: unknown };
type HookTurnBody = { readonly phase?: unknown };
type HookAttentionBody = { readonly input?: unknown; readonly reason?: unknown };
type HookAutoNameBody = { readonly input?: unknown; readonly prompt?: unknown };
type HookCaptureBody = { readonly provider?: unknown; readonly input?: unknown };
type AgentLaunchKindBackfillOperation = Pick<OperationNode, "pluginId" | "type" | "payload">;
type OperationRenamedEvent = {
  readonly operationId: string;
  readonly pluginId: string;
  readonly type: string;
  readonly title: string;
  readonly previousTitle: string;
};
interface AgentRouteDeps {
  readonly authService: AuthService;
  readonly globalOptionsService: GlobalOptionsService;
}
interface InitialPromptReadyWatcher {
  readonly generation: number;
  readonly prompt: string;
  quietTimer: ReturnType<typeof setTimeout> | undefined;
  timeoutTimer: ReturnType<typeof setTimeout> | undefined;
}

const AGENT_OPERATION_TYPE = "agent";
const CONSOLE_PTY_MESSAGE_DELIVERY = { submitDelayMs: 250 } as const;
const INITIAL_PROMPT_MAX_LENGTH = 4_000;
const INITIAL_PROMPT_READY_QUIET_MS = 800;
const INITIAL_PROMPT_READY_TIMEOUT_MS = 15_000;
const INITIAL_PROMPT_RETRY_DELAY_MS = 500;
const OPERATION_RENAMED_EVENT_CHANNEL = "operation:renamed";
const TERMINAL_PLUGIN_ID = "terminal";

export function registerAgentRoutes(
  ctx: FleetPluginServerContext,
  terminalRuntime: TerminalRuntime,
  deps: AgentRouteDeps,
): () => Promise<readonly OperationLaunchKind[]> {
  const api = createAgentApi(ctx, terminalRuntime, deps);
  terminalRuntime.registerLaunchResolver(AGENT_OPERATION_TYPE, api.launch);
  terminalRuntime.onExit(async (operationId) => {
    await api.handleExit(operationId);
  });
  ctx.host.lifecycle.registerCleanup(api.cleanup);
  registerRouter(ctx, "agent", api.handle);
  return api.launchKinds;
}

export function buildAgentLaunchKindBackfillPatch(operation: AgentLaunchKindBackfillOperation): Pick<OperationPatchInput, "payload"> | null {
  if (operation.pluginId !== TERMINAL_PLUGIN_ID || operation.type !== AGENT_OPERATION_TYPE) return null;
  const cliId = operation.payload.cliId;
  if (typeof cliId !== "string" || cliId.length === 0) return null;
  if (operation.payload.launchKindId !== undefined) return null;
  return { payload: { ...operation.payload, launchKindId: cliId } };
}

function createAgentApi(ctx: FleetPluginServerContext, terminalRuntime: TerminalRuntime, deps: AgentRouteDeps) {
  const planTools = getPlanToolSpecs({ dataDir: ctx.host.paths.fleetDataDir });
  const wikiToolSpecs = createTerminalWikiToolSpecs(ctx.host.paths.fleetDataDir);
  const runtime = createFleetAgentRuntimeLifecycle({
    authService: deps.authService,
    dataDir: ctx.host.paths.fleetDataDir,
    globalOptionsService: deps.globalOptionsService,
    onMcpServerStartError: (error) => {
      console.error("[fleet-console] Failed to start MCP server", error);
    },
    workspaceChangeScanner: createWorkspaceChangeScanner(),
    wikiToolSpecs,
    extraAgentTools: [planTools.read, planTools.verify],
    extraExecutorTools: [
      { spec: planTools.write, options: { allowedScopes: [] } },
      { spec: planTools.markTasks, options: { allowedScopes: [] } },
    ],
  });
  const observability = createConsoleObservabilityStore({
    canonicalizeTheaterPath: ctx.host.paths.canonicalizeTheaterPath,
    workspaceHash: ctx.host.paths.workspaceHash,
  });
  const detector = createDefaultAgentCliDetector();
  const pendingRuntimeSessions = new Map<string, ConsoleRuntimeSessionInfo>();
  const initialPromptRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const initialPromptReadyWatchers = new Map<string, InitialPromptReadyWatcher>();
  const initialPromptGenerations = new Map<string, number>();
  let nextInitialPromptGeneration = 1;
  const identityRefreshes = new Map<string, { running: boolean; queued: boolean }>();
  const jobOriginById = new Map<string, string>();
  const launchResolver = createAgentTerminalLaunchResolver({
    agentRuntime: runtime,
    dataDir: ctx.host.paths.fleetDataDir,
    infraServices: deps,
    resolveServerBindings: (launchContext) => {
      const operationId = launchContext?.operationId;
      if (!operationId) return undefined;
      const operation = ctx.host.operations.get(operationId);
      if (!operation || operation.pluginId !== ctx.pluginId || operation.type !== AGENT_OPERATION_TYPE) return undefined;
      const theaterRoot = ctx.host.paths.resolveTheaterPath(operation.theaterId);
      return theaterRoot ? createPlanWorkspaceServerBindings(ctx.host.paths.fleetDataDir, theaterRoot) : undefined;
    },
    onRuntimeSessionStart: (session) => {
      pendingRuntimeSessions.set(session.sessionId, session);
    },
  });
  const unsubscribeStream = runtime.carrierRuntime.jobs.streaming.register((event) => {
    const sessionId = resolveCarrierEventOrigin(event as { readonly jobId: string; readonly type: string; readonly originSessionId?: string }, jobOriginById);
    if (!sessionId) return;
    observability.appendTerminalRuntimeEvent(sessionId, withSignatureCli(event, runtime.carrierRuntime.registry));
  });
  const unsubscribePtyOutput = terminalRuntime.onOutput(handleInitialPromptOutput);
  // carrier 리마인더와 rename 주입이 세션 단위로 함께 직렬화되도록 공유 writer를 사용한다.
  const reminderWriter = createDelayedPtyWriter();
  const unsubscribeReminder = createCarrierResultReminderRouter({
    streamRegister: runtime.carrierRuntime.jobs.streaming.register,
    writer: reminderWriter,
    delivery: CONSOLE_PTY_MESSAGE_DELIVERY,
    resolveSink: (event) => {
      const sessionId = resolveCarrierEventOrigin(event as { readonly jobId: string; readonly type: string; readonly originSessionId?: string }, jobOriginById);
      return sessionId ? { write: (data) => terminalRuntime.write(sessionId, data) } : undefined;
    },
    resolvePolicy: (event) => {
      const sessionId = resolveCarrierEventOrigin(event as { readonly jobId: string; readonly type: string; readonly originSessionId?: string }, jobOriginById);
      return sessionId ? terminalRuntime.getMessagePolicy(sessionId) ?? {} : {};
    },
    // 세션별 지연 제출 직렬화 키: 같은 터미널 세션으로 동시 도착한 리마인더가 뒤섞이지 않도록 한다.
    resolveSessionKey: (event) => resolveCarrierEventOrigin(event as { readonly jobId: string; readonly type: string; readonly originSessionId?: string }, jobOriginById) ?? undefined,
  });
  const unsubscribeRename = ctx.host.events.subscribe(OPERATION_RENAMED_EVENT_CHANNEL, (payload) => {
    if (!isOperationRenamedEvent(payload)) return;
    if (payload.pluginId !== TERMINAL_PLUGIN_ID || payload.type !== AGENT_OPERATION_TYPE) return;
    const updated = observability.renameTerminalSession(payload.operationId, payload.title);
    if (updated) {
      observability.notifySessionUpdated(updated);
      const operation = ctx.host.operations.get(payload.operationId);
      if (operation) {
        const cwd = readPayloadString(operation.payload, "cwd") || ctx.host.paths.resolveTheaterPath(operation.theaterId) || "";
        const providerSession = readProviderSession(operation.payload);
        // 빈 리네임(reset)이면 updated.label이 비므로 title도 기본 표시명(cwdLabel=basename)으로 되돌린다.
        // core PATCH의 빈 title은 기존 title로 normalize되어 사용자 옛 이름이 남기 때문에, 여기서 명시적으로 복원한다.
        // 이 patch는 store.patch(HTTP 미경유)라 operation:renamed를 재발행하지 않아 구독 루프를 만들지 않는다.
        ctx.host.operations.patch(payload.operationId, { title: updated.label ?? updated.cwdLabel, payload: toOperationPayload(operation.payload, cwd, updated, providerSession) });
      }
    }
    injectRenameCommand(payload.operationId, payload.title);
  });
  backfillAgentOperationLaunchKinds();
  rehydrateDormantAgentOperations();

  async function handle({ req, res, pathname }: Parameters<FleetPluginServerContext["registerRouter"]>[1] extends (arg: infer T) => unknown ? T : never): Promise<boolean> {
    const path = pathname.slice(`${ctx.basePath}/agent`.length) || "/";
    if (path === "/state") {
      if (req.method !== "GET") return methodNotAllowed(res);
      ctx.host.http.writeJson(res, 200, { agentClis: await buildAgentCliLaunchMetadata() });
      return true;
    }
    if (path === "/agent-cli/state") {
      if (req.method !== "GET") return methodNotAllowed(res);
      ctx.host.http.writeJson(res, 200, { clis: await detector.detect() });
      return true;
    }
    if (path === "/tenants") {
      if (req.method !== "GET") return methodNotAllowed(res);
      ctx.host.http.writeJson(res, 200, { tenants: observability.listWorkspaces() });
      return true;
    }
    if (path === "/jobs") {
      if (req.method !== "GET") return methodNotAllowed(res);
      const requestedTenantId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("tenant");
      const visible = requestedTenantId ? observability.listWorkspaces().filter((workspace) => workspace.tenantId === requestedTenantId) : observability.listWorkspaces();
      if (requestedTenantId && visible.length === 0) {
        ctx.host.http.writeJson(res, 404, { error: "Workspace not found" });
        return true;
      }
      ctx.host.http.writeJson(res, 200, { tenants: visible.map((workspace) => ({ tenantId: workspace.tenantId, tenantLabel: workspace.tenantLabel, jobs: observability.listJobs(workspace.tenantId), truncation: observability.getTruncation(workspace.tenantId) })) });
      return true;
    }
    if (path === "/events") {
      if (req.method !== "GET") return methodNotAllowed(res);
      const requestedTenantId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("tenant");
      const visible = requestedTenantId ? observability.listWorkspaces().filter((workspace) => workspace.tenantId === requestedTenantId) : observability.listWorkspaces();
      if (requestedTenantId && visible.length === 0) {
        ctx.host.http.writeJson(res, 404, { error: "Workspace not found" });
        return true;
      }
      writeAggregateObserverEvents(req, res, visible, observability, (tenantId) => observability.getWorkspace(tenantId), { subscribeAll: true });
      return true;
    }
    if (path === "/sessions") return handleSessions(req, res);
    if (path === "/capture") return handleCapture(req, res, "");
    const sessionMatch = path.match(/^\/sessions\/([^/]+)(?:\/([^/]+))?$/);
    if (sessionMatch) return handleSessionItem(req, res, decodeURIComponent(sessionMatch[1] ?? ""), sessionMatch[2] ?? "");
    if (path === "/ticket") {
      if (req.method !== "POST") return methodNotAllowed(res);
      if (!ctx.host.security.isTerminalAuthorized(req)) {
        ctx.host.http.writeJson(res, 401, { error: "Unauthorized" });
        return true;
      }
      const body = await ctx.host.http.readJsonBody<{ readonly operationId?: unknown }>(req);
      if (typeof body?.operationId !== "string") {
        ctx.host.http.writeJson(res, 400, { error: "terminal_session_not_found" });
        return true;
      }
      const operation = ctx.host.operations.get(body.operationId);
      if (!operation) {
        ctx.host.http.writeJson(res, 404, { error: "terminal_session_not_found" });
        return true;
      }
      const cwd = readPayloadString(operation.payload, "cwd") ?? ctx.host.paths.resolveTheaterPath(operation.theaterId);
      if (!cwd) {
        ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
        return true;
      }
      ctx.host.http.writeJson(res, 200, terminalRuntime.issueTicket({
        cwd,
        sessionId: operation.id,
        operationId: operation.id,
        operationType: operation.type,
        pluginId: operation.pluginId,
        theaterId: operation.theaterId,
        cliId: readPayloadString(operation.payload, "cliId") ?? undefined,
      }));
      return true;
    }
    return false;
  }

  async function handleSessions(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"]): Promise<boolean> {
    if (!ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method === "GET") {
      ctx.host.http.writeJson(res, 200, { sessions: observability.listTerminalSessions() });
      return true;
    }
    if (req.method !== "POST") return methodNotAllowed(res);
    const body = await ctx.host.http.readJsonBody<SessionCreateBody>(req);
    const initialPrompt = readInitialPrompt(body?.initialPrompt);
    if (initialPrompt === false) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_initial_prompt" });
      return true;
    }
    const cliId = readOptionalAgentCliId(body?.cliId, res);
    if (cliId === false) return true;
    if (!cliId) {
      ctx.host.http.writeJson(res, 400, { error: "agent_cli_required" });
      return true;
    }
    const theaterId = typeof body?.theaterId === "string"
      ? body.theaterId
      : new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("theaterId");
    if (!theaterId) {
      ctx.host.http.writeJson(res, 400, { error: "theater_required" });
      return true;
    }
    const cwd = ctx.host.paths.resolveTheaterPath(theaterId);
    if (!cwd) {
      ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
      return true;
    }
    await createSession(cwd, theaterId, cliId, initialPrompt, res);
    return true;
  }

  async function handleSessionItem(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string, action: string): Promise<boolean> {
    if (action === "turn") return handleTurn(req, res, sessionId);
    if (action === "attention") return handleAttention(req, res, sessionId);
    if (action === "auto-name") return handleAutoName(req, res, sessionId);
    if (action === "capture") return handleCapture(req, res, sessionId);
    if (action === "resume") return handleResume(req, res, sessionId);
    if (!ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method === "DELETE") {
      removeSession(sessionId);
      ctx.host.http.writeJson(res, 200, { ok: true });
      return true;
    }
    return methodNotAllowed(res);
  }

  async function createSession(cwd: string, theaterId: string, cliId: AgentCliId, initialPrompt: string | undefined, res: Parameters<typeof handle>[0]["res"]): Promise<void> {
    const meta = (await buildAgentCliLaunchMetadata()).find((entry) => entry.id === cliId);
    if (!meta || !meta.available || !meta.signedIn) {
      ctx.host.http.writeJson(res, 409, { error: "agent_cli_unavailable" });
      return;
    }
    const sessionId = crypto.randomUUID();
    const initialPromptGeneration = beginInitialPromptGeneration(sessionId);
    const session = observability.createPendingTerminalSession({ sessionId, cwd, cliId });
    ctx.host.operations.create({
      id: session.sessionId,
      theaterId,
      type: AGENT_OPERATION_TYPE,
      pluginId: ctx.pluginId,
      title: session.label ?? path.basename(cwd),
      payload: toOperationPayload(undefined, cwd, session),
      createdAt: session.createdAt,
    });
    if (initialPrompt) watchInitialPromptReadiness(sessionId, initialPrompt, initialPromptGeneration);
    try {
      await terminalRuntime.attach({
        cwd,
        sessionId,
        operationId: sessionId,
        operationType: AGENT_OPERATION_TYPE,
        pluginId: ctx.pluginId,
        theaterId,
        cliId,
      });
      const runtimeSession = pendingRuntimeSessions.get(sessionId);
      pendingRuntimeSessions.delete(sessionId);
      const created = runtimeSession
        ? observability.registerTerminalRuntimeSession(runtimeSession) ?? session
        : observability.updateTerminalSessionStatus(sessionId, "terminal-only") ?? session;
      observability.notifySessionUpdated(created);
      ctx.host.operations.patch(sessionId, { payload: toOperationPayload(ctx.host.operations.get(sessionId)?.payload, cwd, created, undefined, observability.getDurableOperation(sessionId)?.providerTitle) });
      ctx.host.http.writeJson(res, 200, created);
    } catch {
      invalidateInitialPromptGeneration(sessionId);
      pendingRuntimeSessions.delete(sessionId);
      observability.updateTerminalSessionStatus(sessionId, "error");
      ctx.host.http.writeJson(res, 503, { error: "terminal_unavailable" });
    }
  }

  async function handleResume(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string): Promise<boolean> {
    if (req.method !== "POST") return methodNotAllowed(res);
    if (!ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const node = ctx.host.operations.get(sessionId);
    const payload = node?.payload;
    const cliId = readOptionalAgentCliId(payload?.cliId, res);
    const providerSession = readProviderSession(payload);
    if (!node || cliId === false || !cliId || !providerSession) {
      ctx.host.http.writeJson(res, node ? 409 : 404, { error: node ? "resume_unavailable" : "session_not_found" });
      return true;
    }
    const starting = observability.updateTerminalSessionStatus(sessionId, "starting") ?? injectOperation(node);
    try {
      const cwd = readPayloadString(node.payload, "cwd") ?? ctx.host.paths.resolveTheaterPath(node.theaterId);
      if (!cwd) {
        ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
        return true;
      }
      beginInitialPromptGeneration(sessionId);
      await terminalRuntime.attach({
        cwd,
        sessionId,
        operationId: sessionId,
        operationType: node.type,
        pluginId: node.pluginId,
        theaterId: node.theaterId,
        cliId,
        resumeSessionId: providerSession.sessionId,
      });
      const runtimeSession = pendingRuntimeSessions.get(sessionId);
      pendingRuntimeSessions.delete(sessionId);
      const resumed = runtimeSession ? observability.registerTerminalRuntimeSession(runtimeSession) ?? starting : observability.updateTerminalSessionStatus(sessionId, "terminal-only") ?? starting;
      observability.notifySessionUpdated(resumed);
      ctx.host.operations.patch(sessionId, { payload: toOperationPayload(node.payload, cwd, resumed, providerSession, observability.getDurableOperation(sessionId)?.providerTitle) });
      ctx.host.http.writeJson(res, 200, resumed);
    } catch {
      invalidateInitialPromptGeneration(sessionId);
      pendingRuntimeSessions.delete(sessionId);
      const reverted = observability.updateTerminalSessionStatus(sessionId, "dormant");
      if (reverted) observability.notifySessionUpdated(reverted);
      ctx.host.http.writeJson(res, 503, { error: "terminal_unavailable" });
    }
    return true;
  }

  async function handleTurn(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string): Promise<boolean> {
    if (req.method !== "POST") return methodNotAllowed(res);
    if (!ctx.host.security.isLockAuthorized(req)) return unauthorized(res);
    const body = await ctx.host.http.readJsonBody<HookTurnBody>(req);
    const turnState = body?.phase === "start" ? "running" : body?.phase === "end" ? "ended" : null;
    if (turnState === null) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_phase" });
      return true;
    }
    const updated = observability.setTerminalSessionTurnState(sessionId, turnState);
    if (!updated) {
      ctx.host.http.writeJson(res, 404, { error: "terminal_session_not_found" });
      return true;
    }
    observability.notifySessionUpdated(updated);
    ctx.host.http.writeJson(res, 200, { ok: true });
    if (turnState === "ended") scheduleIdentityRefresh(sessionId);
    return true;
  }

  async function handleAttention(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string): Promise<boolean> {
    if (req.method !== "POST") return methodNotAllowed(res);
    if (!ctx.host.security.isLockAuthorized(req)) return unauthorized(res);
    const session = observability.getTerminalSessionInfo(sessionId);
    if (!session) {
      ctx.host.http.writeJson(res, 404, { error: "terminal_session_not_found" });
      return true;
    }
    const body = await ctx.host.http.readJsonBody<HookAttentionBody>(req);
    observability.notifySessionAttention(session, normalizeAttentionReason(body?.reason ?? readHookNotificationType(body?.input)));
    ctx.host.http.writeJson(res, 200, { ok: true });
    return true;
  }

  async function handleAutoName(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string): Promise<boolean> {
    if (req.method !== "POST") return methodNotAllowed(res);
    if (!ctx.host.security.isLockAuthorized(req)) return unauthorized(res);
    const body = await ctx.host.http.readJsonBody<HookAutoNameBody>(req);
    const prompt = typeof body?.prompt === "string" ? body.prompt : readHookPrompt(body?.input);
    const result = observability.autoNameTerminalSession(sessionId, deriveOperationLabel(prompt));
    if (result?.renamed) {
      observability.notifySessionUpdated(result.session);
      const autoNameCwd = readPayloadString(ctx.host.operations.get(sessionId)?.payload ?? {}, "cwd") ?? result.session.cwdLabel;
      ctx.host.operations.patch(sessionId, { title: result.session.label ?? path.basename(autoNameCwd) });
    }
    ctx.host.http.writeJson(res, 200, { ok: true, renamed: result?.renamed === true });
    return true;
  }

  async function handleCapture(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string): Promise<boolean> {
    if (req.method !== "POST") return methodNotAllowed(res);
    if (!ctx.host.security.isLockAuthorized(req)) return unauthorized(res);
    const body = await ctx.host.http.readJsonBody<HookCaptureBody>(req);
    if (!sessionId || typeof body?.provider !== "string" || typeof body.input !== "string") {
      ctx.host.http.writeJson(res, 400, { error: "invalid_capture" });
      return true;
    }
    const result = captureSession({
      diagnostics: process.stderr,
      env: { ...process.env, FLEET_CONSOLE_SESSION_ID: sessionId },
      input: body.input,
      paths: ctx.host.paths,
      provider: body.provider,
    });
    if (result) {
      observability.updateTerminalSessionProviderSession(sessionId, result.providerSession);
      const operation = ctx.host.operations.get(sessionId);
      if (operation) {
        ctx.host.operations.patch(sessionId, { payload: { ...operation.payload, providerSession: result.providerSession } });
      } else {
        console.warn(`[fleet-console] capture-session persisted without operation payload: ${sessionId}`);
      }
    }
    ctx.host.http.writeJson(res, 200, { ok: result !== null });
    return true;
  }

  async function buildAgentCliLaunchMetadata(): Promise<readonly AgentCliLaunchMetadata[]> {
    const metadata = getAgentCliMetadata();
    if ((process.env.FLEET_TERMINAL_CMD ?? "").trim().length > 0) {
      return metadata.map((meta) => ({ id: meta.id, label: meta.label, available: true, signedIn: true }));
    }
    const detected = await detector.detect();
    const authStatuses = await getAgentCliAuthStatuses(deps.authService);
    return combineAgentCliLaunchMetadata(metadata, detected, authStatuses);
  }

  async function buildLaunchKinds(): Promise<readonly OperationLaunchKind[]> {
    const metadata = await buildAgentCliLaunchMetadata();
    return buildAgentCliLaunchKinds(metadata, AGENT_OPERATION_TYPE);
  }

  function launch(cwd: string | undefined, context: { readonly operationId?: string } | undefined) {
    const operationId = context?.operationId ?? "";
    const operation = ctx.host.operations.get(operationId);
    const cliId = typeof operation?.payload.cliId === "string" ? operation.payload.cliId : undefined;
    const providerSession = readProviderSession(operation?.payload)?.sessionId;
    return launchResolver(cwd, {
      sessionId: operationId,
      operationId,
      operationType: AGENT_OPERATION_TYPE,
      pluginId: ctx.pluginId,
      ...(operation?.theaterId ? { theaterId: operation.theaterId } : {}),
      ...(cliId ? { cliId } : {}),
      ...(providerSession ? { resumeSessionId: providerSession } : {}),
    });
  }

  async function handleExit(operationId: string): Promise<void> {
    reminderWriter.cancel(operationId);
    invalidateInitialPromptGeneration(operationId);
    pendingRuntimeSessions.delete(operationId);
    const providerSession = readProviderSessionCapture(operationId, { capturesDir: ctx.host.paths.capturesDir }) ?? readProviderSession(ctx.host.operations.get(operationId)?.payload);
    if (providerSession) {
      observability.updateTerminalSessionProviderSession(operationId, providerSession);
      const dormant = observability.transitionTerminalSessionToDormant(operationId, providerSession);
      if (dormant) {
        observability.notifySessionUpdated(dormant);
        const exitCwd = readPayloadString(ctx.host.operations.get(operationId)?.payload ?? {}, "cwd") ?? "";
        ctx.host.operations.patch(operationId, { payload: toOperationPayload(ctx.host.operations.get(operationId)?.payload, exitCwd, dormant, providerSession, observability.getDurableOperation(operationId)?.providerTitle) });
      }
    } else {
      observability.removeTerminalSession(operationId);
      ctx.host.operations.delete(operationId);
    }
  }

  function removeSession(sessionId: string): void {
    reminderWriter.cancel(sessionId);
    invalidateInitialPromptGeneration(sessionId);
    terminalRuntime.terminate(sessionId);
    pendingRuntimeSessions.delete(sessionId);
    observability.removeTerminalSession(sessionId);
    ctx.host.operations.delete(sessionId);
    unlinkProviderSessionCapture(sessionId, { capturesDir: ctx.host.paths.capturesDir });
  }

  async function cleanup(): Promise<void> {
    reminderWriter.cancelAll();
    for (const sessionId of new Set([...initialPromptGenerations.keys(), ...initialPromptReadyWatchers.keys(), ...initialPromptRetryTimers.keys()])) {
      invalidateInitialPromptGeneration(sessionId);
    }
    unsubscribePtyOutput();
    unsubscribeRename();
    unsubscribeReminder();
    unsubscribeStream();
    await runtime.cleanup();
  }

  function scheduleIdentityRefresh(sessionId: string): void {
    const state = identityRefreshes.get(sessionId);
    if (state?.running) {
      state.queued = true;
      return;
    }
    const operation = ctx.host.operations.get(sessionId);
    const providerSessionId = readProviderSession(operation?.payload)?.sessionId;
    if (!providerSessionId) {
      identityRefreshes.delete(sessionId);
      return;
    }
    const next = state ?? { running: false, queued: false };
    next.running = true;
    identityRefreshes.set(sessionId, next);
    void terminalRuntime.resolveSessionIdentity(sessionId, providerSessionId)
      .then((title) => {
        const current = ctx.host.operations.get(sessionId);
        if (!title || !current || readProviderSession(current.payload)?.sessionId !== providerSessionId) return;
        const applied = observability.applyTerminalSessionProviderIdentity(sessionId, title);
        if (!applied?.renamed) return;
        observability.notifySessionUpdated(applied.session);
        const operation = ctx.host.operations.get(sessionId);
        if (!operation || readProviderSession(operation.payload)?.sessionId !== providerSessionId) return;
        const cwd = readPayloadString(operation.payload, "cwd") || applied.session.cwdLabel;
        const providerSession = readProviderSession(operation.payload);
        ctx.host.operations.patch(sessionId, {
          title: applied.session.label ?? applied.session.cwdLabel,
          payload: toOperationPayload(operation.payload, cwd, applied.session, providerSession, observability.getDurableOperation(sessionId)?.providerTitle),
        });
      })
      .catch(() => {})
      .finally(() => {
        next.running = false;
        if (next.queued) {
          next.queued = false;
          scheduleIdentityRefresh(sessionId);
        } else {
          identityRefreshes.delete(sessionId);
        }
      });
  }

  function injectRenameCommand(sessionId: string, label: string | undefined): void {
    if (!label) return;
    const renameCommand = terminalRuntime.getRenameCommand(sessionId);
    if (!renameCommand) return;
    const safeLabel = sanitizeCarrierResultReminder(label.replace(/[\r\n\t]+/g, " ")).trim();
    if (safeLabel.length === 0) return;
    const policy = terminalRuntime.getMessagePolicy(sessionId) ?? {};
    // 리마인더와 동일한 세션 키/writer로 직렬화해 rename+리마인더 인터리브를 막는다.
    reminderWriter.enqueue(
      sessionId,
      (data) => terminalRuntime.write(sessionId, data),
      formatCarrierResultReminderMessage(policy, `${renameCommand} ${safeLabel}`, process.platform, CONSOLE_PTY_MESSAGE_DELIVERY),
    );
  }

  function watchInitialPromptReadiness(sessionId: string, prompt: string, generation: number): void {
    clearInitialPromptReadyWatcher(sessionId);
    if (!isCurrentInitialPromptGeneration(sessionId, generation)) return;
    const watcher: InitialPromptReadyWatcher = {
      generation,
      prompt,
      quietTimer: undefined,
      timeoutTimer: undefined,
    };
    initialPromptReadyWatchers.set(sessionId, watcher);
    watcher.timeoutTimer = setTimeout(() => {
      completeInitialPromptReadiness(sessionId, watcher);
    }, INITIAL_PROMPT_READY_TIMEOUT_MS);
  }

  function handleInitialPromptOutput(sessionId: string): void {
    const watcher = initialPromptReadyWatchers.get(sessionId);
    if (!watcher) return;
    if (!isCurrentInitialPromptGeneration(sessionId, watcher.generation)) {
      clearInitialPromptReadyWatcher(sessionId, watcher);
      return;
    }
    if (watcher.quietTimer) clearTimeout(watcher.quietTimer);
    watcher.quietTimer = setTimeout(() => {
      completeInitialPromptReadiness(sessionId, watcher);
    }, INITIAL_PROMPT_READY_QUIET_MS);
  }

  function completeInitialPromptReadiness(sessionId: string, watcher: InitialPromptReadyWatcher): void {
    if (initialPromptReadyWatchers.get(sessionId) !== watcher) return;
    clearInitialPromptReadyWatcher(sessionId, watcher);
    if (!isCurrentInitialPromptGeneration(sessionId, watcher.generation)) return;
    injectInitialPrompt(sessionId, watcher.prompt, watcher.generation);
  }

  function clearInitialPromptReadyWatcher(sessionId: string, expected?: InitialPromptReadyWatcher): void {
    const watcher = initialPromptReadyWatchers.get(sessionId);
    if (!watcher || (expected && watcher !== expected)) return;
    if (watcher.quietTimer) clearTimeout(watcher.quietTimer);
    if (watcher.timeoutTimer) clearTimeout(watcher.timeoutTimer);
    initialPromptReadyWatchers.delete(sessionId);
  }

  function injectInitialPrompt(sessionId: string, prompt: string, generation: number, isRetry = false): void {
    if (!isCurrentInitialPromptGeneration(sessionId, generation)) return;
    const safePrompt = sanitizeCarrierResultReminder(prompt).trim();
    if (safePrompt.length === 0) return;
    const policy = terminalRuntime.getMessagePolicy(sessionId) ?? {};
    let handledWriteFailure = false;
    reminderWriter.enqueue(
      sessionId,
      (data) => {
        if (!isCurrentInitialPromptGeneration(sessionId, generation)) return false;
        const written = terminalRuntime.write(sessionId, data);
        if (written || handledWriteFailure) return written;
        handledWriteFailure = true;
        if (!isCurrentInitialPromptGeneration(sessionId, generation)) return false;
        if (isRetry) {
          console.debug("[fleet-console] Initial prompt injection dropped because the PTY was unavailable", { sessionId });
          return false;
        }
        const timer = setTimeout(() => {
          if (initialPromptRetryTimers.get(sessionId) !== timer) return;
          if (!isCurrentInitialPromptGeneration(sessionId, generation)) {
            initialPromptRetryTimers.delete(sessionId);
            return;
          }
          initialPromptRetryTimers.delete(sessionId);
          injectInitialPrompt(sessionId, safePrompt, generation, true);
        }, INITIAL_PROMPT_RETRY_DELAY_MS);
        initialPromptRetryTimers.set(sessionId, timer);
        return false;
      },
      formatCarrierResultReminderMessage(policy, safePrompt, process.platform, CONSOLE_PTY_MESSAGE_DELIVERY),
    );
  }

  function beginInitialPromptGeneration(sessionId: string): number {
    clearInitialPromptReadyWatcher(sessionId);
    clearInitialPromptRetry(sessionId);
    const generation = nextInitialPromptGeneration;
    nextInitialPromptGeneration += 1;
    initialPromptGenerations.set(sessionId, generation);
    return generation;
  }

  function invalidateInitialPromptGeneration(sessionId: string): void {
    clearInitialPromptReadyWatcher(sessionId);
    clearInitialPromptRetry(sessionId);
    initialPromptGenerations.delete(sessionId);
  }

  function isCurrentInitialPromptGeneration(sessionId: string, generation: number): boolean {
    return initialPromptGenerations.get(sessionId) === generation;
  }

  function clearInitialPromptRetry(sessionId: string): void {
    const timer = initialPromptRetryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    initialPromptRetryTimers.delete(sessionId);
  }

  function injectOperation(operation: OperationNode): AgentTerminalSessionInfo {
    const cwd = readPayloadString(operation.payload, "cwd") ?? ctx.host.paths.resolveTheaterPath(operation.theaterId) ?? "";
    const providerTitle = readProviderTitle(operation.payload);
    return observability.injectDormantOperation({
      sessionId: operation.id,
      theaterId: operation.theaterId,
      cwd,
      ...(providerTitle
        ? { label: operation.title, providerTitle }
        : readPayloadString(operation.payload, "labelSource")
          ? { label: operation.title, labelSource: readPayloadString(operation.payload, "labelSource") as AgentLabelSource }
          : {}),
      ...(readPayloadString(operation.payload, "cliId") ? { cliId: readPayloadString(operation.payload, "cliId")! } : {}),
      ...(readPayloadString(operation.payload, "cliLabel") ? { cliLabel: readPayloadString(operation.payload, "cliLabel")! } : {}),
      createdAt: operation.ts.createdAt,
      ...(readProviderSession(operation.payload) ? { providerSession: readProviderSession(operation.payload)! } : {}),
    });
  }

  function rehydrateDormantAgentOperations(): void {
    for (const operation of ctx.host.operations.list()) {
      if (operation.pluginId !== ctx.pluginId || operation.type !== AGENT_OPERATION_TYPE) continue;
      const providerSession = readProviderSession(operation.payload);
      if (!providerSession || observability.getTerminalSessionInfo(operation.id)) continue;
      const dormant = injectOperation(operation);
      const cwd = readPayloadString(operation.payload, "cwd") || (ctx.host.paths.resolveTheaterPath(operation.theaterId) ?? "");
      ctx.host.operations.patch(operation.id, { payload: toOperationPayload(operation.payload, cwd, dormant, providerSession, observability.getDurableOperation(operation.id)?.providerTitle) });
    }
  }

  function backfillAgentOperationLaunchKinds(): void {
    for (const operation of ctx.host.operations.list()) {
      const patch = buildAgentLaunchKindBackfillPatch(operation);
      if (!patch) continue;
      ctx.host.operations.patch(operation.id, patch);
    }
  }

  return { cleanup, handle, handleExit, launch, launchKinds: buildLaunchKinds };

  function methodNotAllowed(res: Parameters<typeof handle>[0]["res"]): true {
    ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  function unauthorized(res: Parameters<typeof handle>[0]["res"]): true {
    ctx.host.http.writeJson(res, 401, { error: "Unauthorized" });
    return true;
  }
}

export function createTerminalWikiToolSpecs(fleetDataDir: string) {
  const resolver = createWikiWorkspaceResolver({
    ensureWorkspace: (cwd) => ensureWorkspaceDirectory(fleetDataDir, cwd),
    withMigrationLock: (workspace, operation) => withDirectoryLock(
      { lockDir: path.join(workspace.path, "knowledge.migration.lock") },
      operation,
    ),
  });
  return getWikiToolSpecs(resolver);
}

function toOperationPayload(existing: Record<string, unknown> | undefined, cwd: string, session: AgentTerminalSessionInfo, providerSession?: ProviderSession, providerTitle?: AgentProviderTitleMarker): Record<string, unknown> {
  const payload = { ...(existing ?? {}) };
  for (const key of ["cwd", "cliId", "launchKindId", "cliLabel", "providerSession", "labelSource", "providerTitle"]) {
    delete payload[key];
  }
  return {
    ...payload,
    cwd,
    ...(session.cliId ? { cliId: session.cliId } : {}),
    ...(session.cliId ? { launchKindId: session.cliId } : {}),
    ...(session.cliLabel ? { cliLabel: session.cliLabel } : {}),
    ...(providerSession ? { providerSession } : {}),
    ...(session.labelSource ? { labelSource: session.labelSource } : {}),
    ...(providerTitle ? { providerTitle } : {}),
  };
}

function isOperationRenamedEvent(payload: unknown): payload is OperationRenamedEvent {
  if (typeof payload !== "object" || payload === null) return false;
  const event = payload as Record<string, unknown>;
  return typeof event.operationId === "string"
    && typeof event.pluginId === "string"
    && typeof event.type === "string"
    && typeof event.title === "string"
    && typeof event.previousTitle === "string";
}

function readOptionalAgentCliId(value: unknown, res: Parameters<FleetPluginServerContext["host"]["http"]["writeJson"]>[0]): AgentCliId | undefined | false {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_agent_cli" }));
    return false;
  }
  try {
    return parseAgentCliId(value);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_agent_cli" }));
    return false;
  }
}

function readInitialPrompt(value: unknown): string | undefined | false {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return false;
  const prompt = value.trim();
  if (prompt.length > INITIAL_PROMPT_MAX_LENGTH) return false;
  return prompt.length > 0 ? prompt : undefined;
}

function readProviderSession(value: Record<string, unknown> | undefined): ProviderSession | undefined {
  const providerSession = value?.providerSession;
  if (!providerSession || typeof providerSession !== "object") return undefined;
  const candidate = providerSession as { readonly provider?: unknown; readonly sessionId?: unknown; readonly capturedAt?: unknown; readonly transcriptPath?: unknown; readonly source?: unknown };
  if ((candidate.provider !== "claude" && candidate.provider !== "codex") || typeof candidate.sessionId !== "string" || typeof candidate.capturedAt !== "string") return undefined;
  return {
    provider: candidate.provider,
    sessionId: candidate.sessionId,
    capturedAt: candidate.capturedAt,
    ...(typeof candidate.transcriptPath === "string" ? { transcriptPath: candidate.transcriptPath } : {}),
    ...(typeof candidate.source === "string" ? { source: candidate.source } : {}),
  };
}

function readProviderTitle(value: Record<string, unknown> | undefined): AgentProviderTitleMarker | undefined {
  const marker = value?.providerTitle;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return undefined;
  const candidate = marker as Record<string, unknown>;
  if (candidate.source !== "provider" || Object.keys(candidate).length !== 1) return undefined;
  return { source: "provider" };
}

function resolveCarrierEventOrigin(event: { readonly jobId: string; readonly type: string; readonly originSessionId?: string }, jobOriginById: Map<string, string>): string | null {
  if (event.originSessionId) {
    jobOriginById.set(event.jobId, event.originSessionId);
    if (event.type === "job:finalized") queueMicrotask(() => jobOriginById.delete(event.jobId));
    return event.originSessionId;
  }
  const knownOrigin = jobOriginById.get(event.jobId);
  if (event.type === "job:finalized") queueMicrotask(() => jobOriginById.delete(event.jobId));
  return knownOrigin ?? null;
}

function readPayloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function readPayloadNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readHookNotificationType(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value) as { readonly notification_type?: unknown };
    return parsed.notification_type;
  } catch {
    return undefined;
  }
}

function readHookPrompt(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value) as { readonly prompt?: unknown };
    return typeof parsed.prompt === "string" ? parsed.prompt : undefined;
  } catch {
    return undefined;
  }
}

function withSignatureCli(event: unknown, registry: Parameters<typeof getCarrierConfig>[0]): unknown {
  if (typeof event !== "object" || event === null) return event;
  const obj = event as Record<string, unknown>;
  if (obj.type !== "job:registered" || typeof obj.ownerCarrierId !== "string") return event;
  const config = getCarrierConfig(registry, obj.ownerCarrierId);
  if (!config) return event;
  const signatureCli = resolveAgentCliType(obj.ownerCarrierId, config.defaultCliType);
  return { ...obj, signatureCli };
}

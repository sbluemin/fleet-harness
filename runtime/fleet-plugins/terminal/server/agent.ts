import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";

import { buildGatewayModelsToolSpec, createCarrierResultReminderRouter, createDelayedPtyWriter, createFleetAgentRuntimeLifecycle, formatCarrierResultReminderMessage, getAgentCliIds, getAgentCliMetadata, parseAgentCliId, sanitizeCarrierResultReminder, type AgentCliId } from "@dotobokuri/fleet-admiral";
import type { AgentToolSpec } from "@dotobokuri/core-agent";
import { getCarrierConfig, resolveAgentCliType } from "@dotobokuri/fleet-carriers";
import { ensureWorkspaceDirectory, withDirectoryLock, type GlobalOptionsService } from "@dotobokuri/core-infra";
import { createWikiWorkspaceResolver, getWikiToolSpecs } from "@dotobokuri/fleet-wiki";
import type { OperationLaunchKind, OperationNode, OperationPatchInput } from "@fleet-console/sdk/operations";
import { registerRouter } from "@fleet-console/sdk/plugin/node";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { createWorkspaceChangeScanner } from "./shared/index.js";
import type { TerminalRuntime } from "./shared/index.js";

import { createDefaultAgentCliDetector, validateAgentCliPathForSave } from "./agent-api/agent-cli-detect.js";
import { buildAgentCliLaunchKinds } from "./agent-api/agent-cli-launch-kinds.js";
import { combineAgentCliLaunchMetadata, type AgentCliLaunchMetadata } from "./agent-api/agent-cli-launch-metadata.js";
import { AGENT_CLI_COMMANDS, createAgentCliPathStore, createCarrierAgentCliLaunchResolver, resolveAgentCliBinary } from "./agent-api/agent-cli-paths.js";
import type { AgentCliDiagnostics } from "./agent-api/agent-cli-types.js";
import { readConsoleQuotaSnapshot } from "./agent-api/gateway-loadout.js";
import { resolveAiGatewaySelection } from "./ai-gateway-settings.js";
import type { AiGatewayLaunchBinding } from "./agent-api/launch.js";
import type { AiGatewayStoredSettings } from "./ai-gateway-settings.js";
import { deriveOperationLabel } from "./agent-api/auto-name.js";
import { normalizeAttentionReason } from "./agent-api/attention-hook.js";
import { createAgentTerminalLaunchResolver, type ConsoleRuntimeSessionInfo } from "./agent-api/launch.js";
import { createConsoleObservabilityStore } from "./agent-api/observability-store.js";
import { createOscAgentActivityTracker, type OscAgentActivityTracker } from "./agent-api/osc-agent-activity.js";
import { writeAggregateObserverEvents } from "./agent-api/observability-routes.js";
import { readAnalysisProviderSession, readProviderSession, type AnalysisProviderSession } from "./agent-api/provider-session.js";
import type { AgentProviderSession, AgentProviderTitleMarker, AgentTerminalSessionInfo, AgentLabelSource } from "./agent-api/types.js";
import { CARRIER_JOB_FINALIZED_GRACE_MS, isCarrierJobActiveForIdle, startIdleAgentDormantSweeper } from "./agent-idle-dormant-sweeper.js";
type SessionCreateBody = { readonly cliId?: unknown; readonly theaterId?: unknown };
type HookTurnBody = { readonly phase?: unknown };
type HookBackgroundBody = { readonly event?: unknown };
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
  readonly globalOptionsService: GlobalOptionsService;
  readonly aiGateway?: AiGatewayLaunchBinding;
  readonly readAiGatewaySettings?: () => Promise<AiGatewayStoredSettings>;
}

const AGENT_OPERATION_TYPE = "agent";
const CONSOLE_PTY_MESSAGE_DELIVERY = { submitDelayMs: 250 } as const;
const OPERATION_RENAMED_EVENT_CHANNEL = "operation:renamed";
const OPERATION_RESTORED_EVENT_CHANNEL = "operation:restored";
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

// 로스터는 호출 시점에 해석한다. 노출 선별은 세션이 도는 동안에도 사용자가 바꿀 수 있고,
// 등록 시점에 고정하면 호스트가 이미 꺼진 모델을 오류 없이 계속 배치하게 된다.
function buildGatewayLoadoutTools(deps: AgentRouteDeps): readonly AgentToolSpec[] {
  const readAiGatewaySettings = deps.readAiGatewaySettings;
  if (!readAiGatewaySettings) return [];
  const aiGateway = deps.aiGateway;
  return [buildGatewayModelsToolSpec({
    readSelection: async () => {
      const selection = resolveAiGatewaySelection(await readAiGatewaySettings());
      return {
        models: selection.models,
        ...(selection.defaultModel ? { defaultModel: selection.defaultModel } : {}),
      };
    },
    ...(aiGateway
      ? { readQuota: () => readConsoleQuotaSnapshot(aiGateway.origin()) }
      : {}),
  })];
}

function createAgentApi(ctx: FleetPluginServerContext, terminalRuntime: TerminalRuntime, deps: AgentRouteDeps) {
  const wikiToolSpecs = createTerminalWikiToolSpecs(ctx.host.paths.fleetDataDir);
  const agentCliPathStore = createAgentCliPathStore(ctx.host.storage, ctx.pluginId);
  const readAgentCliPaths = async () => (await agentCliPathStore.read()).paths;
  const runtime = createFleetAgentRuntimeLifecycle({
    dataDir: ctx.host.paths.fleetDataDir,
    onMcpServerStartError: (error) => {
      console.error("[fleet-console] Failed to start MCP server", error);
    },
    workspaceChangeScanner: createWorkspaceChangeScanner(),
    wikiToolSpecs,
    extraAgentTools: buildGatewayLoadoutTools(deps),
  });
  runtime.carrierRuntime.setAgentCliLaunchResolver(createCarrierAgentCliLaunchResolver(readAgentCliPaths));
  const observability = createConsoleObservabilityStore({
    canonicalizeTheaterPath: ctx.host.paths.canonicalizeTheaterPath,
    workspaceHash: ctx.host.paths.workspaceHash,
  });
  const detector = createDefaultAgentCliDetector(readAgentCliPaths);
  const pendingRuntimeSessions = new Map<string, ConsoleRuntimeSessionInfo>();
  const identityRefreshes = new Map<string, { running: boolean; queued: boolean }>();
  const jobOriginById = new Map<string, string>();
  const oscActivityTrackers = new Map<string, OscAgentActivityTracker>();
  const launchResolver = createAgentTerminalLaunchResolver({
    agentRuntime: runtime,
    ...(deps.aiGateway ? { aiGateway: deps.aiGateway } : {}),
    ...(deps.readAiGatewaySettings ? { readAiGatewaySettings: deps.readAiGatewaySettings } : {}),
    dataDir: ctx.host.paths.fleetDataDir,
    infraServices: deps,
    readAgentCliPaths,
    onRuntimeSessionStart: (session) => {
      pendingRuntimeSessions.set(session.sessionId, session);
    },
  });
  const unsubscribeStream = runtime.carrierRuntime.jobs.streaming.register((event) => {
    const sessionId = resolveCarrierEventOrigin(event as { readonly jobId: string; readonly type: string; readonly originSessionId?: string }, jobOriginById);
    if (!sessionId) return;
    observability.appendTerminalRuntimeEvent(sessionId, withSignatureCli(event, runtime.carrierRuntime.registry));
  });
  const unsubscribeTitle = terminalRuntime.onTitle(AGENT_OPERATION_TYPE, (sessionId, title) => {
    // spinner는 프레임마다 타이틀을 방출하므로 tracker가 이미 있으면 세션 조회(DTO 투영)를 건너뛴다.
    let tracker = oscActivityTrackers.get(sessionId);
    if (!tracker) {
      const session = observability.getTerminalSessionInfo(sessionId);
      if (!session) return;
      const cliId = session.cliId;
      if (cliId !== "claude" && cliId !== "claude-native" && cliId !== "claude-gateway") return;
      tracker = createOscAgentActivityTracker({
        cliId,
        cwdBasename: session.cwdLabel,
        onActivity: (modelActivity) => {
          const updated = observability.setTerminalSessionModelActivity(sessionId, modelActivity);
          if (updated) observability.notifySessionUpdated(updated);
        },
      });
      oscActivityTrackers.set(sessionId, tracker);
    }
    tracker.observeTitle(title);
  });
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
        const providerSession = readAnalysisProviderSession(operation.payload.providerSession);
        // 빈 리네임(reset)이면 updated.label이 비므로 title도 기본 표시명(cwdLabel=basename)으로 되돌린다.
        // core PATCH의 빈 title은 기존 title로 normalize되어 사용자 옛 이름이 남기 때문에, 여기서 명시적으로 복원한다.
        // 이 patch는 store.patch(HTTP 미경유)라 operation:renamed를 재발행하지 않아 구독 루프를 만들지 않는다.
        ctx.host.operations.patch(payload.operationId, { title: updated.label ?? updated.cwdLabel, payload: toOperationPayload(operation.payload, cwd, updated, providerSession) });
      }
    }
    injectRenameCommand(payload.operationId, payload.title);
  });
  const unsubscribeRestore = ctx.host.events.subscribe(OPERATION_RESTORED_EVENT_CHANNEL, (payload) => {
    if (!isOperationRestoredEvent(payload) || payload.pluginId !== ctx.pluginId || payload.type !== AGENT_OPERATION_TYPE) return;
    const operation = ctx.host.operations.get(payload.operationId);
    if (!operation || observability.getTerminalSessionInfo(operation.id)) return;
    const dormant = injectOperation(operation);
    observability.notifySessionUpdated(dormant);
  });
  backfillAgentOperationLaunchKinds();
  rehydrateDormantAgentOperations();
  startIdleAgentDormantSweeper({
    loadGlobalOptions: () => deps.globalOptionsService.load(),
    listTerminalSessions: () => observability.listTerminalSessions(),
    getSessionLastActivityAt: (sessionId) => terminalRuntime.getSessionLastActivityAt(sessionId),
    hasProviderSessionCapture: (sessionId) => readProviderSession(ctx.host.operations.get(sessionId)?.payload) !== undefined,
    // tenantId(=cliRunId)로 세션-job이 연결된다. 활성·finalize grace 안 job이 있으면 reminder용 PTY를 지킨다.
    // job.updatedAt은 wall-clock(Date.now) 기준이므로 grace 비교도 동일 시계를 쓴다.
    hasActiveCarrierJob: (sessionId) => {
      const tenantId = observability.getTerminalSessionInfo(sessionId)?.tenantId;
      if (!tenantId) return false;
      const nowMs = Date.now();
      return observability.listJobs(tenantId).some((job) => isCarrierJobActiveForIdle(job, nowMs, CARRIER_JOB_FINALIZED_GRACE_MS));
    },
    terminate: (sessionId) => terminalRuntime.terminate(sessionId),
    registerCleanup: (cleanup) => ctx.host.lifecycle.registerCleanup(cleanup),
  });

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
    if (path === "/agent-cli/diagnostics") {
      if (req.method !== "GET") return methodNotAllowed(res);
      if (!ctx.host.security.isTerminalAuthorized(req)) return unauthorized(res);
      ctx.host.http.writeJson(res, 200, await buildAgentCliDiagnostics());
      return true;
    }
    if (path === "/agent-cli/path") {
      if (req.method !== "PUT") return methodNotAllowed(res);
      if (!ctx.host.security.isTerminalAuthorized(req)) return unauthorized(res);
      const body = await ctx.host.http.readJsonBody<{ readonly cliCommand?: unknown; readonly path?: unknown }>(req);
      if (
        !body
        || typeof body.cliCommand !== "string"
        || !AGENT_CLI_COMMANDS.includes(body.cliCommand as (typeof AGENT_CLI_COMMANDS)[number])
        || (body.path !== null && typeof body.path !== "string")
      ) {
        ctx.host.http.writeJson(res, 400, { error: "path_not_absolute" });
        return true;
      }
      const executablePath = body.path ?? "";
      if (executablePath.length > 0) {
        const validation = await validateAgentCliPathForSave(executablePath, process.env);
        if (validation.error) {
          ctx.host.http.writeJson(res, 400, { error: validation.error });
          return true;
        }
      }
      await agentCliPathStore.writePath(body.cliCommand, executablePath);
      ctx.host.http.writeJson(res, 200, { ok: true });
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
    const sessionMatch = path.match(/^\/sessions\/([^/]+)(?:\/([^/]+))?$/);
    if (sessionMatch) return handleSessionItem(req, res, decodeURIComponent(sessionMatch[1] ?? ""), sessionMatch[2] ?? "");
    if (path === "/ticket") {
      if (req.method !== "POST") return methodNotAllowed(res);
      if (!ctx.host.security.isTerminalAuthorized(req)) {
        ctx.host.http.writeJson(res, 401, { error: "Unauthorized" });
        return true;
      }
      const body = await ctx.host.http.readJsonBody<{ readonly operationId?: unknown; readonly colorScheme?: unknown }>(req);
      if (typeof body?.operationId !== "string") {
        ctx.host.http.writeJson(res, 400, { error: "terminal_session_not_found" });
        return true;
      }
      const operation = ctx.host.operations.get(body.operationId);
      if (!operation) {
        ctx.host.http.writeJson(res, 404, { error: "terminal_session_not_found" });
        return true;
      }
      // dormant 세션은 ticket 발급을 거부한다 — stale 클라이언트가 PTY를 재생성하지 못하게 한다.
      // resume은 /resume이 status를 dormant에서 뺀 뒤에야 TerminalSurface가 ticket을 요청한다.
      if (observability.getTerminalSessionInfo(operation.id)?.status === "dormant") {
        ctx.host.http.writeJson(res, 409, { error: "operation_dormant" });
        return true;
      }
      const cwd = readPayloadString(operation.payload, "cwd") ?? ctx.host.paths.resolveTheaterPath(operation.theaterId);
      if (!cwd) {
        ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
        return true;
      }
      const colorScheme = body?.colorScheme === "light" || body?.colorScheme === "dark" ? body.colorScheme : undefined;
      ctx.host.http.writeJson(res, 200, terminalRuntime.issueTicket({
        cwd,
        sessionId: operation.id,
        operationId: operation.id,
        operationType: operation.type,
        pluginId: operation.pluginId,
        theaterId: operation.theaterId,
        cliId: readPayloadString(operation.payload, "cliId") ?? undefined,
        ...(colorScheme ? { colorScheme } : {}),
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
    await createSession(cwd, theaterId, cliId, res);
    return true;
  }

  async function handleSessionItem(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string, action: string): Promise<boolean> {
    if (action === "turn") return handleTurn(req, res, sessionId);
    if (action === "background") return handleBackground(req, res, sessionId);
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

  async function createSession(cwd: string, theaterId: string, cliId: AgentCliId, res: Parameters<typeof handle>[0]["res"]): Promise<void> {
    const meta = (await buildAgentCliLaunchMetadata()).find((entry) => entry.id === cliId);
    if (!meta || !meta.available || !meta.signedIn) {
      ctx.host.http.writeJson(res, 409, { error: "agent_cli_unavailable" });
      return;
    }
    const sessionId = crypto.randomUUID();
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
    // body는 선택이다: { fresh: true }이면 저장된 provider 세션을 버리고 같은 Operation에서
    // 완전히 새 세션을 시작한다(Resume 실패 후의 Start fresh 경로). body 없음/파싱 실패는 일반 resume.
    const body = await ctx.host.http.readJsonBody<{ readonly fresh?: unknown }>(req);
    const fresh = body?.fresh === true;
    const node = ctx.host.operations.get(sessionId);
    const payload = node?.payload;
    const cliId = readOptionalAgentCliId(payload?.cliId, res);
    if (cliId === false) return true;
    const providerSession = readProviderSession(payload);
    if (!node || !cliId || (!fresh && !providerSession)) {
      ctx.host.http.writeJson(res, node ? 409 : 404, { error: node ? "resume_unavailable" : "session_not_found" });
      return true;
    }
    resetOscActivity(sessionId);
    const starting = observability.updateTerminalSessionStatus(sessionId, "starting") ?? injectOperation(node);
    try {
      const cwd = readPayloadString(node.payload, "cwd") ?? ctx.host.paths.resolveTheaterPath(node.theaterId);
      if (!cwd) {
        ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
        return true;
      }
      if (fresh) {
        // stale provider 상태는 spawn 전에 observability와 payload에서 모두 떼어낸다 —
        // attach 도중 새 CLI의 capture hook이 먼저 완료되면 attach 후 정리가 새
        // providerSession까지 지우고, payload에 구 세션이 남으면 성공 patch가 그것을 다시
        // 심는다. attach 실패 시에는 catch에서 payload providerSession을 원복해
        // 일반 resume 재시도와 Session Analyst의 transcript 접근을 보존한다.
        observability.clearTerminalSessionProviderSession(sessionId);
        const payloadWithoutProvider = { ...node.payload };
        delete payloadWithoutProvider.providerSession;
        ctx.host.operations.patch(sessionId, { payload: payloadWithoutProvider });
      }
      await terminalRuntime.attach({
        cwd,
        sessionId,
        operationId: sessionId,
        operationType: node.type,
        pluginId: node.pluginId,
        theaterId: node.theaterId,
        cliId,
        ...(fresh ? {} : { resumeSessionId: providerSession?.sessionId }),
      });
      const runtimeSession = pendingRuntimeSessions.get(sessionId);
      pendingRuntimeSessions.delete(sessionId);
      const resumed = runtimeSession ? observability.registerTerminalRuntimeSession(runtimeSession) ?? starting : observability.updateTerminalSessionStatus(sessionId, "terminal-only") ?? starting;
      observability.notifySessionUpdated(resumed);
      // fresh 성공 patch는 attach 중 자식이 capture한 새 providerSession만 보존한다 —
      // payload는 spawn 전에 비워 두었으므로, 읽히는 세션은 반드시 자식의 신규 capture다.
      const currentPayload = fresh ? ctx.host.operations.get(sessionId)?.payload : node.payload;
      const effectiveProviderSession = fresh ? readProviderSession(currentPayload) : providerSession;
      ctx.host.operations.patch(sessionId, { payload: toOperationPayload(currentPayload ?? node.payload, cwd, resumed, effectiveProviderSession, observability.getDurableOperation(sessionId)?.providerTitle) });
      ctx.host.http.writeJson(res, 200, resumed);
    } catch {
      resetOscActivity(sessionId);
      if (fresh && providerSession) {
        // 실패 롤백: spawn 전에 떼어낸 payload providerSession과 observability 세션을
        // 복원한다 — payload의 providerSession이 resume과 Analyst transcript의 단일 권위다.
        const rollbackPayload = { ...(ctx.host.operations.get(sessionId)?.payload ?? {}) };
        rollbackPayload.providerSession = providerSession;
        ctx.host.operations.patch(sessionId, { payload: rollbackPayload });
        observability.updateTerminalSessionProviderSession(sessionId, providerSession);
      }
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
    oscActivityTrackers.get(sessionId)?.reset();
    observability.notifySessionUpdated(updated);
    ctx.host.http.writeJson(res, 200, { ok: true });
    if (turnState === "ended") scheduleIdentityRefresh(sessionId);
    return true;
  }

  async function handleBackground(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string): Promise<boolean> {
    if (req.method !== "POST") return methodNotAllowed(res);
    if (!ctx.host.security.isLockAuthorized(req)) return unauthorized(res);
    const body = await ctx.host.http.readJsonBody<HookBackgroundBody>(req);
    const event = body?.event === "spawn" || body?.event === "stop" ? body.event : null;
    if (event === null) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_event" });
      return true;
    }
    const updated = observability.setTerminalSessionBackgroundEvent(sessionId, event);
    if (!updated) {
      ctx.host.http.writeJson(res, 404, { error: "terminal_session_not_found" });
      return true;
    }
    observability.notifySessionUpdated(updated);
    ctx.host.http.writeJson(res, 200, { ok: true });
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
    const providerSession = parseCaptureHookInput(body.provider, body.input);
    if (providerSession) {
      observability.updateTerminalSessionProviderSession(sessionId, providerSession);
      const operation = ctx.host.operations.get(sessionId);
      if (operation) {
        ctx.host.operations.patch(sessionId, { payload: { ...operation.payload, providerSession } });
      } else {
        console.warn(`[fleet-console] capture-session persisted without operation payload: ${sessionId}`);
      }
    }
    ctx.host.http.writeJson(res, 200, { ok: providerSession !== undefined });
    return true;
  }

  async function buildAgentCliLaunchMetadata(): Promise<readonly AgentCliLaunchMetadata[]> {
    // Console은 게이트웨이 라우트를 가진 유일한 호스트라 console-only CLI까지 후보로 받는다.
    const metadata = getAgentCliMetadata(getAgentCliIds({ includeConsoleOnly: true }));
    if ((process.env.FLEET_TERMINAL_CMD ?? "").trim().length > 0) {
      return metadata.map((meta) => ({ id: meta.id, label: meta.label, available: true, signedIn: true }));
    }
    const detected = await detector.detect();
    return combineAgentCliLaunchMetadata(metadata, detected);
  }

  async function buildAgentCliDiagnostics(): Promise<AgentCliDiagnostics> {
    const userPaths = await readAgentCliPaths();
    return {
      entries: AGENT_CLI_COMMANDS.map((cliCommand) => {
        const resolution = resolveAgentCliBinary({ cliCommand, env: process.env, userPaths });
        return {
          cliCommand,
          configuredPath: userPaths[cliCommand] ?? null,
          resolutionSource: resolution.source,
          searchedPathEntries: resolution.searchedPathEntries,
        };
      }),
    };
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
    resetOscActivity(operationId);
    pendingRuntimeSessions.delete(operationId);
    const providerSession = readProviderSession(ctx.host.operations.get(operationId)?.payload);
    if (providerSession) {
      observability.updateTerminalSessionProviderSession(operationId, providerSession);
      const dormant = observability.transitionTerminalSessionToDormant(operationId, providerSession);
      if (dormant) {
        // 전이 전 발급된 미소비 ticket이 WS consume으로 PTY를 되살리지 못하도록 폐기한다.
        terminalRuntime.invalidateTicketsForSession(operationId);
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
    resetOscActivity(sessionId);
    terminalRuntime.terminate(sessionId);
    pendingRuntimeSessions.delete(sessionId);
    observability.removeTerminalSession(sessionId);
    ctx.host.operations.delete(sessionId);
  }

  async function cleanup(): Promise<void> {
    reminderWriter.cancelAll();
    unsubscribeRename();
    unsubscribeRestore();
    unsubscribeReminder();
    unsubscribeStream();
    unsubscribeTitle();
    for (const tracker of oscActivityTrackers.values()) tracker.reset();
    oscActivityTrackers.clear();
    await runtime.cleanup();
  }

  function resetOscActivity(sessionId: string): void {
    const tracker = oscActivityTrackers.get(sessionId);
    tracker?.reset();
    oscActivityTrackers.delete(sessionId);
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

function isOperationRestoredEvent(value: unknown): value is { readonly operationId: string; readonly pluginId: string; readonly type: string } {
  if (!value || typeof value !== "object") return false;
  const event = value as { readonly operationId?: unknown; readonly pluginId?: unknown; readonly type?: unknown };
  return typeof event.operationId === "string" && typeof event.pluginId === "string" && typeof event.type === "string";
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

function toOperationPayload(existing: Record<string, unknown> | undefined, cwd: string, session: AgentTerminalSessionInfo, providerSession?: AgentProviderSession | AnalysisProviderSession, providerTitle?: AgentProviderTitleMarker): Record<string, unknown> {
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

function parseCaptureHookInput(provider: string, input: string): AgentProviderSession | undefined {
  try {
    if (provider !== "claude") throw new Error("invalid_provider");
    const parsed = JSON.parse(input) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid_hook_input");
    const candidate = parsed as { readonly session_id?: unknown; readonly transcript_path?: unknown; readonly source?: unknown };
    if (typeof candidate.session_id !== "string" || candidate.session_id.length === 0) throw new Error("missing_provider_session_id");
    return {
      provider,
      sessionId: candidate.session_id,
      ...(typeof candidate.transcript_path === "string" && candidate.transcript_path.length > 0 ? { transcriptPath: candidate.transcript_path } : {}),
      ...(typeof candidate.source === "string" && candidate.source.length > 0 ? { source: candidate.source } : {}),
      capturedAt: new Date().toISOString(),
    };
  } catch (error) {
    process.stderr.write(`[fleet-console] capture-session skipped: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
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

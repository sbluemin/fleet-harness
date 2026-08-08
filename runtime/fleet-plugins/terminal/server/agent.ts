import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";

import { buildGatewayModelsToolSpec, clampGoalCheckLimit, createDelayedPtyWriter, createFleetGatewayAgentRuntimeLifecycle, formatPtyMessage, getAgentCliIds, getAgentCliMetadata, MAX_GOAL_CONDITION_CHARS, LaunchPromptError, MAX_LAUNCH_PROMPT_CHARS, NATIVE_CLAUDE_EFFORTS, NATIVE_CLAUDE_MODEL_ALIASES, parseAgentCliId, sanitizeLaunchPrompt, sanitizePtyMessageText, type AgentCliId } from "@dotobokuri/fleet-admiral";
import type { AgentToolSpec } from "@dotobokuri/core-agent";
import { ensureWorkspaceDirectory, withDirectoryLock, type GlobalOptionsService } from "@dotobokuri/core-infra";
import { createWikiWorkspaceResolver, getWikiToolSpecs } from "@dotobokuri/fleet-wiki";
import type { OperationLaunchKind, OperationNode, OperationPatchInput } from "@fleet-console/sdk/operations";
import { registerRouter } from "@fleet-console/sdk/plugin/node";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { readSocketRole } from "./shared/index.js";
import type { TerminalRuntime } from "./shared/index.js";

import { createDefaultAgentCliDetector, validateAgentCliPathForSave } from "./agent-api/agent-cli-detect.js";
import { buildAgentCliLaunchKinds } from "./agent-api/agent-cli-launch-kinds.js";
import { combineAgentCliLaunchMetadata, type AgentCliLaunchMetadata } from "./agent-api/agent-cli-launch-metadata.js";
import { AGENT_CLI_COMMANDS, createAgentCliPathStore, resolveAgentCliBinary } from "./agent-api/agent-cli-paths.js";
import type { AgentCliDiagnostics } from "./agent-api/agent-cli-types.js";
import { readConsoleQuotaSnapshot } from "./agent-api/gateway-loadout.js";
import { resolveAiGatewaySelection } from "@dotobokuri/core-ai-gateway";
import type { AiGatewayStoredSettings } from "@dotobokuri/core-ai-gateway";
import type { AiGatewayLaunchBinding } from "./agent-api/launch.js";
import { deriveOperationLabel } from "./agent-api/auto-name.js";
import { normalizeAttentionReason } from "./agent-api/attention-hook.js";
import { resolveBackgroundPendingFromHookInput } from "./agent-api/background-report.js";
import { createAgentTerminalLaunchResolver, GatewayLaunchOptionError, isGatewayLaunchEffortAllowed, type ConsoleRuntimeSessionInfo } from "./agent-api/launch.js";
import { createConsoleObservabilityStore } from "./agent-api/observability-store.js";
import { writeAgentSessionEvents } from "./agent-api/observability-routes.js";
import { createOscAgentActivityTracker, type OscAgentActivityTracker } from "./agent-api/osc-agent-activity.js";
import { readAnalysisProviderSession, readProviderSession, type AnalysisProviderSession } from "./agent-api/provider-session.js";
import { buildAgentSessionGoal, dropGoalTranscriptCache, readGoalMarkersFromTranscript } from "./agent-api/goal-transcript.js";
import type { AgentProviderSession, AgentProviderTitleMarker, AgentTerminalSessionInfo, AgentLabelSource, OperationGoalRecord } from "./agent-api/types.js";
import { startIdleAgentDormantSweeper } from "./agent-idle-dormant-sweeper.js";
type SessionCreateBody = { readonly cliId?: unknown; readonly theaterId?: unknown; readonly model?: unknown; readonly effort?: unknown; readonly prompt?: unknown };
type GoalBody = { readonly condition?: unknown; readonly checkLimit?: unknown };
type HookTurnBody = { readonly phase?: unknown; readonly input?: unknown };
type HookBackgroundBody = { readonly input?: unknown };
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
  readonly readAiGatewaySettings?: () => AiGatewayStoredSettings;
}

const AGENT_OPERATION_TYPE = "agent";
const CONSOLE_PTY_MESSAGE_DELIVERY = { submitDelayMs: 250 } as const;
const OPERATION_RENAMED_EVENT_CHANNEL = "operation:renamed";
const OPERATION_RESTORED_EVENT_CHANNEL = "operation:restored";
const TERMINAL_PLUGIN_ID = "terminal";

export async function registerAgentRoutes(
  ctx: FleetPluginServerContext,
  terminalRuntime: TerminalRuntime,
  deps: AgentRouteDeps,
): Promise<() => Promise<readonly OperationLaunchKind[]>> {
  const api = await createAgentApi(ctx, terminalRuntime, deps);
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
    readSelection: () => {
      const selection = resolveAiGatewaySelection(readAiGatewaySettings());
      return {
        models: selection.models,
        effortExposure: selection.effortExposure,
        ...(selection.defaultModel ? { defaultModel: selection.defaultModel } : {}),
        ...(selection.providerPriority ? { providerPriority: selection.providerPriority } : {}),
      };
    },
    ...(aiGateway
      ? { readQuota: () => readConsoleQuotaSnapshot(aiGateway.origin()) }
      : {}),
  })];
}

async function createAgentApi(ctx: FleetPluginServerContext, terminalRuntime: TerminalRuntime, deps: AgentRouteDeps) {
  const wikiToolSpecs = createTerminalWikiToolSpecs(ctx.host.paths.fleetDataDir);
  const agentCliPathStore = createAgentCliPathStore(ctx.host.storage, ctx.pluginId);
  const readAgentCliPaths = async () => (await agentCliPathStore.read()).paths;
  const runtime = await createFleetGatewayAgentRuntimeLifecycle({
    wikiToolSpecs,
    extraAgentTools: buildGatewayLoadoutTools(deps),
  });
  const observability = createConsoleObservabilityStore({
    canonicalizeTheaterPath: ctx.host.paths.canonicalizeTheaterPath,
    workspaceHash: ctx.host.paths.workspaceHash,
  });
  const detector = createDefaultAgentCliDetector(readAgentCliPaths);
  const pendingRuntimeSessions = new Map<string, ConsoleRuntimeSessionInfo>();
  const identityRefreshes = new Map<string, { running: boolean; queued: boolean }>();
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
  const unsubscribeTitle = terminalRuntime.onTitle(AGENT_OPERATION_TYPE, (sessionId, title) => {
    // spinner는 프레임마다 타이틀을 방출하므로 tracker가 이미 있으면 세션 조회(DTO 투영)를 건너뛴다.
    let tracker = oscActivityTrackers.get(sessionId);
    if (!tracker) {
      const session = observability.getTerminalSessionInfo(sessionId);
      if (!session) return;
      const cliId = session.cliId;
      if (cliId !== "claude-native" && cliId !== "claude-gateway") return;
      tracker = createOscAgentActivityTracker({
        cliId,
        cwdBasename: session.cwdLabel,
        onActivity: (modelActivity) => {
          const updated = observability.setTerminalSessionModelActivity(sessionId, modelActivity);
          if (updated) void notifySessionUpdated(updated);
        },
      });
      oscActivityTrackers.set(sessionId, tracker);
    }
    tracker.observeTitle(title);
  });
  // rename 주입이 세션 단위로 직렬화되도록 공유 writer를 쓴다.
  const reminderWriter = createDelayedPtyWriter();
  const unsubscribeRename = ctx.host.events.subscribe(OPERATION_RENAMED_EVENT_CHANNEL, (payload) => {
    if (!isOperationRenamedEvent(payload)) return;
    if (payload.pluginId !== TERMINAL_PLUGIN_ID || payload.type !== AGENT_OPERATION_TYPE) return;
    const updated = observability.renameTerminalSession(payload.operationId, payload.title);
    if (updated) {
      void notifySessionUpdated(updated);
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
    void notifySessionUpdated(dormant);
  });

  // 목표는 세션 상태가 아니라 durable payload + 트랜스크립트에서 매번 파생된다. 스냅샷(GET)과
  // 브로드캐스트(SSE)가 같은 파생을 공유해야 한다 — 브로드캐스트에만 실으면 SSE를 놓친
  // 클라이언트나 새로 연 페이지에는 영수증이 영영 나타나지 않는다.
  async function withSessionGoal(session: AgentTerminalSessionInfo): Promise<AgentTerminalSessionInfo> {
    const operation = ctx.host.operations.get(session.sessionId);
    const providerSession = readProviderSession(operation?.payload);
    const goal = await buildAgentSessionGoal({
      goal: readOperationGoal(operation?.payload),
      transcriptPath: providerSession?.transcriptPath,
      turnRunning: session.turnState === "running",
      backgroundPending: session.backgroundPending === true,
      sessionLive: isLiveAgentSession(session),
      launchCheckLimit: readPositiveNumber(operation?.payload, "goalLaunchCheckLimit"),
      clearedBaseline: readPositiveNumber(operation?.payload, "goalClearedBaseline"),
    });
    return goal ? { ...session, goal } : session;
  }

  async function notifySessionUpdated(session: AgentTerminalSessionInfo): Promise<void> {
    observability.notifySessionUpdated(await withSessionGoal(session));
  }

  backfillAgentOperationLaunchKinds();
  rehydrateDormantAgentOperations();
  startIdleAgentDormantSweeper({
    loadGlobalOptions: () => deps.globalOptionsService.load(),
    listTerminalSessions: () => observability.listTerminalSessions(),
    getSessionLastActivityAt: (sessionId) => terminalRuntime.getSessionLastActivityAt(sessionId),
    hasProviderSessionCapture: (sessionId) => readProviderSession(ctx.host.operations.get(sessionId)?.payload) !== undefined,
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
    if (path === "/events") {
      if (req.method !== "GET") return methodNotAllowed(res);
      writeAgentSessionEvents(req, res, observability);
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
      const body = await ctx.host.http.readJsonBody<{ readonly operationId?: unknown; readonly colorScheme?: unknown; readonly role?: unknown }>(req);
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
      const role = readSocketRole(body?.role);
      ctx.host.http.writeJson(res, 200, terminalRuntime.issueTicket({
        cwd,
        sessionId: operation.id,
        operationId: operation.id,
        operationType: operation.type,
        pluginId: operation.pluginId,
        theaterId: operation.theaterId,
        cliId: readPayloadString(operation.payload, "cliId") ?? undefined,
        ...(colorScheme ? { colorScheme } : {}),
        ...(role ? { role } : {}),
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
      const sessions = await Promise.all(observability.listTerminalSessions().map((session) => withSessionGoal(session)));
      ctx.host.http.writeJson(res, 200, { sessions });
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
    const launchOptions = readLaunchOptions(body, cliId, res);
    if (launchOptions === false) return true;
    if (body?.prompt !== undefined && typeof body.prompt !== "string") {
      ctx.host.http.writeJson(res, 400, { error: "invalid_prompt" });
      return true;
    }
    if (typeof body?.prompt === "string" && body.prompt.length > MAX_LAUNCH_PROMPT_CHARS) {
      ctx.host.http.writeJson(res, 400, { error: "prompt_too_long" });
      return true;
    }
    // spawn-only: sanitizeLaunchPrompt 결과는 Operation payload·브라우저 DTO에 넣지 않는다
    // (FORBIDDEN_BROWSER_PAYLOAD_KEYS에 "prompt" 포함).
    const prompt = typeof body?.prompt === "string" ? sanitizeLaunchPrompt(body.prompt) : undefined;
    const cwd = ctx.host.paths.resolveTheaterPath(theaterId);
    if (!cwd) {
      ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
      return true;
    }
    await createSession(cwd, theaterId, cliId, res, {
      ...launchOptions,
      ...(prompt ? { prompt } : {}),
    });
    return true;
  }

  function readLaunchOptions(
    body: SessionCreateBody | null,
    cliId: AgentCliId,
    res: Parameters<typeof handle>[0]["res"],
  ): { readonly model?: string; readonly effort?: string } | false {
    if ((body?.model !== undefined && typeof body.model !== "string")
      || (body?.effort !== undefined && typeof body.effort !== "string")) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_launch_option" });
      return false;
    }
    const model = body?.model;
    const effort = body?.effort;
    if (model === undefined && effort === undefined) return {};
    if (cliId !== "claude-gateway") {
      ctx.host.http.writeJson(res, 400, { error: "launch_option_unsupported" });
      return false;
    }
    if (model === undefined) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_launch_option" });
      return false;
    }
    if (NATIVE_CLAUDE_MODEL_ALIASES.includes(model as (typeof NATIVE_CLAUDE_MODEL_ALIASES)[number])) {
      if (effort !== undefined && !NATIVE_CLAUDE_EFFORTS.includes(effort as (typeof NATIVE_CLAUDE_EFFORTS)[number])) {
        ctx.host.http.writeJson(res, 400, { error: "invalid_effort" });
        return false;
      }
      return { model, ...(effort === undefined ? {} : { effort }) };
    }
    const selection = resolveAiGatewaySelection(deps.readAiGatewaySettings?.());
    const gatewayModel = selection.models.find((candidate) => candidate.id === model);
    if (!gatewayModel) {
      ctx.host.http.writeJson(res, 409, { error: "gateway_model_not_enabled" });
      return false;
    }
    if (effort !== undefined && !isGatewayLaunchEffortAllowed(selection, gatewayModel, effort)) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_effort" });
      return false;
    }
    return { model, ...(effort === undefined ? {} : { effort }) };
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
    if (action === "goal") return handleGoal(req, res, sessionId);
    if (req.method === "DELETE") {
      removeSession(sessionId);
      ctx.host.http.writeJson(res, 200, { ok: true });
      return true;
    }
    return methodNotAllowed(res);
  }

  async function createSession(
    cwd: string,
    theaterId: string,
    cliId: AgentCliId,
    res: Parameters<typeof handle>[0]["res"],
    launchOptions: { readonly model?: string; readonly effort?: string; readonly prompt?: string } = {},
  ): Promise<void> {
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
        ...(launchOptions.model ? { model: launchOptions.model } : {}),
        ...(launchOptions.effort ? { effort: launchOptions.effort } : {}),
        // spawn-only 상태 — Operation payload·브라우저 DTO에 넣지 않는다
        // (FORBIDDEN_BROWSER_PAYLOAD_KEYS에 "prompt" 포함).
        ...(launchOptions.prompt ? { prompt: launchOptions.prompt } : {}),
      });
      const runtimeSession = pendingRuntimeSessions.get(sessionId);
      pendingRuntimeSessions.delete(sessionId);
      const created = runtimeSession
        ? observability.registerTerminalRuntimeSession(runtimeSession) ?? session
        : observability.updateTerminalSessionStatus(sessionId, "terminal-only") ?? session;
      void notifySessionUpdated(created);
      ctx.host.operations.patch(sessionId, { payload: toOperationPayload(ctx.host.operations.get(sessionId)?.payload, cwd, created, undefined, observability.getDurableOperation(sessionId)?.providerTitle) });
      ctx.host.http.writeJson(res, 200, created);
    } catch (error) {
      if (error instanceof GatewayLaunchOptionError) {
        removeSession(sessionId);
        ctx.host.http.writeJson(res, error.code === "gateway_model_not_enabled" ? 409 : 400, { error: error.code });
        return;
      }
      // 프롬프트를 이 실행 경로로 안전하게 전달할 수 없을 때 spawn 전에 거부된다(cmd.exe shim 재해석,
      // FLEET_TERMINAL_CMD 대체 실행). 요청이 잘못된 것이지 터미널이 죽은 게 아니므로 503이 아니라 400이다.
      if (error instanceof LaunchPromptError) {
        removeSession(sessionId);
        // 몇 글자를 줄여야 하는지는 서버만 알 수 있다 — 상한이 이 실행의 argv 전체에 달려 있어
        // 브라우저가 되계산할 수 없다. 코드만 실어 보내면 사용자는 다시 찍어 보는 수밖에 없다.
        ctx.host.http.writeJson(res, 400, {
          error: error.code,
          ...(error.shortenByChars === undefined ? {} : { shortenByChars: error.shortenByChars }),
        });
        return;
      }
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
        // 목표 기록도 함께 버린다. fresh는 조건문을 다시 주입하지 않으므로 새 프로세스는
        // 그 목표를 강제하지 않고, 기준선과 묘비는 사라진 트랜스크립트를 가리키는 수다 —
        // 남겨 두면 강제되지 않는 목표를 "요청됨"으로 보여 주게 된다.
        delete payloadWithoutProvider.goal;
        delete payloadWithoutProvider.goalClearedBaseline;
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
      void notifySessionUpdated(resumed);
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
      if (reverted) void notifySessionUpdated(reverted);
      ctx.host.http.writeJson(res, 503, { error: "terminal_unavailable" });
    }
    return true;
  }

  async function handleGoal(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string): Promise<boolean> {
    if (req.method !== "POST" && req.method !== "DELETE") return methodNotAllowed(res);
    const operation = ctx.host.operations.get(sessionId);
    const session = observability.getTerminalSessionInfo(sessionId);
    if (!operation || !session) {
      ctx.host.http.writeJson(res, 404, { error: "terminal_session_not_found" });
      return true;
    }
    // 해제는 세션 생사와 무관하게 항상 받는다. 목표를 건 세션이 이미 죽은 뒤에도 사용자는
    // Fleet에 남은 영수증을 치울 수 있어야 하고, 살아 있을 때만 CLI에 `/goal clear`를 흘린다.
    // 여기서 live를 요구하면 휴면 Operation의 목표 기록이 영영 지워지지 않는다.
    if (req.method === "DELETE") {
      if (isLiveAgentSession(session) && terminalRuntime.getGoalCommand(sessionId)) injectGoalClear(sessionId);
      // 기록만 지우면 영수증이 되살아난다: 목표는 트랜스크립트에서 매번 파생되고 sentinel
      // 마커는 지워지지 않으므로, 다음 파생이 같은 마커를 터미널 소유 목표로 다시 읽는다.
      // 해제 시점의 마커 수를 묘비로 남겨 그 이전 마커를 영구히 배제한다.
      const clearedPath = readProviderSession(operation.payload)?.transcriptPath;
      const clearedBaseline = clearedPath ? (await readGoalMarkersFromTranscript(clearedPath)).length : 0;
      const payload: Record<string, unknown> = { ...operation.payload, goalClearedBaseline: clearedBaseline };
      delete payload.goal;
      ctx.host.operations.patch(sessionId, { payload });
      void notifySessionUpdated(session);
      ctx.host.http.writeJson(res, 202, { ok: true });
      return true;
    }

    if (!isLiveAgentSession(session)) {
      ctx.host.http.writeJson(res, 409, { error: "goal_not_live" });
      return true;
    }
    if (!terminalRuntime.getGoalCommand(sessionId)) {
      ctx.host.http.writeJson(res, 409, { error: "goal_unsupported" });
      return true;
    }

    const body = await ctx.host.http.readJsonBody<GoalBody>(req);
    const rawCondition = typeof body?.condition === "string" ? body.condition.trim() : "";
    if (rawCondition.length === 0) {
      ctx.host.http.writeJson(res, 400, { error: "goal_condition_required" });
      return true;
    }
    if (rawCondition.length > MAX_GOAL_CONDITION_CHARS) {
      ctx.host.http.writeJson(res, 400, { error: "goal_condition_too_long" });
      return true;
    }
    const condition = sanitizeGoalCondition(rawCondition);
    if (condition.length === 0) {
      ctx.host.http.writeJson(res, 400, { error: "goal_condition_required" });
      return true;
    }
    const checkLimit = clampGoalCheckLimit(typeof body?.checkLimit === "number" ? body.checkLimit : undefined);
    // 주입 전에 지금까지 쌓인 마커 수를 기준선으로 잡는다. 이전 목표의 종료 마커가
    // 새 목표의 상태로 읽히는 것을 막는 유일한 수단이다(마커에는 시각이 없다).
    const goalTranscriptPath = readProviderSession(operation.payload)?.transcriptPath;
    const markerBaseline = goalTranscriptPath ? (await readGoalMarkersFromTranscript(goalTranscriptPath)).length : 0;
    const goal: OperationGoalRecord = {
      origin: "fleet",
      checkLimit,
      requestedAt: Date.now(),
      markerBaseline,
      condition,
    };
    injectGoalCommand(sessionId, condition);
    // 새 목표의 기준선이 묘비를 대신한다 — 둘을 함께 두면 어느 쪽이 유효한지 payload가 두 벌로 말한다.
    const goalPayload: Record<string, unknown> = { ...operation.payload, goal };
    delete goalPayload.goalClearedBaseline;
    ctx.host.operations.patch(sessionId, { payload: goalPayload });
    // 이미 뜬 프로세스의 cap은 spawn 환경에 박혀 있다. 방금 고른 한도는 다음 재개부터
    // 유효하므로, 응답도 강제 중인 한도와 예약된 한도를 갈라서 말한다.
    const launchCheckLimit = clampGoalCheckLimit(readPositiveNumber(operation.payload, "goalLaunchCheckLimit"));
    const requested = {
      state: "requested" as const,
      live: true,
      origin: "fleet" as const,
      checksUsed: 0,
      checkLimit: launchCheckLimit,
      ...(checkLimit === launchCheckLimit ? {} : { pendingCheckLimit: checkLimit }),
      condition,
    };
    ctx.host.http.writeJson(res, 202, { goal: requested });
    observability.notifySessionUpdated({ ...session, goal: requested });
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
    // 턴 종료 payload가 실어 온 살아 있는 백그라운드 작업 보고를 같은 전이 안에서 반영한 뒤 한 번만 알린다.
    // 두 번 알리면 그 사이의 프레임에서 세션이 백그라운드 작업을 잊은 채 유휴로 읽힌다.
    const pending = turnState === "ended" ? resolveBackgroundPendingFromHookInput(body?.input) : undefined;
    const settled = pending === undefined ? updated : observability.setTerminalSessionBackgroundPending(sessionId, pending) ?? updated;
    void notifySessionUpdated(settled);
    ctx.host.http.writeJson(res, 200, { ok: true });
    if (turnState === "ended") scheduleIdentityRefresh(sessionId);
    return true;
  }

  async function handleBackground(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string): Promise<boolean> {
    if (req.method !== "POST") return methodNotAllowed(res);
    if (!ctx.host.security.isLockAuthorized(req)) return unauthorized(res);
    const body = await ctx.host.http.readJsonBody<HookBackgroundBody>(req);
    const pending = resolveBackgroundPendingFromHookInput(body?.input);
    if (pending === undefined) {
      // background_tasks를 읽어내지 못한 보고는 무의견이다. 상태를 건드리지 않고 조용히 수용한다.
      ctx.host.http.writeJson(res, 200, { ok: true });
      return true;
    }
    const updated = observability.setTerminalSessionBackgroundPending(sessionId, pending);
    if (!updated) {
      ctx.host.http.writeJson(res, 404, { error: "terminal_session_not_found" });
      return true;
    }
    void notifySessionUpdated(updated);
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
      void notifySessionUpdated(result.session);
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
    const metadata = getAgentCliMetadata(getAgentCliIds());
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
    const selection = deps.readAiGatewaySettings
      ? resolveAiGatewaySelection(deps.readAiGatewaySettings())
      : undefined;
    return buildAgentCliLaunchKinds(metadata, AGENT_OPERATION_TYPE, selection);
  }

  function launch(cwd: string | undefined, context: { readonly operationId?: string; readonly model?: string; readonly effort?: string; readonly prompt?: string } | undefined) {
    const operationId = context?.operationId ?? "";
    const operation = ctx.host.operations.get(operationId);
    const cliId = typeof operation?.payload.cliId === "string" ? operation.payload.cliId : undefined;
    const goal = readOperationGoal(operation?.payload);
    const providerSession = readProviderSession(operation?.payload)?.sessionId;
    // 이 spawn이 실제로 강제하게 될 한도를 payload에 남긴다. 뜬 뒤에는 자식 프로세스의
    // 환경을 바꿀 수 없으므로, 영수증이 눈금으로 셀 수 있는 값은 여기서 고정된 이 숫자뿐이다.
    const launchCheckLimit = clampGoalCheckLimit(goal?.checkLimit);
    if (operation) {
      ctx.host.operations.patch(operation.id, {
        payload: { ...operation.payload, goalLaunchCheckLimit: launchCheckLimit },
      });
    }
    // prompt는 spawn-only. Operation payload·브라우저 DTO에 넣지 않는다(FORBIDDEN_BROWSER_PAYLOAD_KEYS).
    return launchResolver(cwd, {
      sessionId: operationId,
      operationId,
      operationType: AGENT_OPERATION_TYPE,
      pluginId: ctx.pluginId,
      ...(operation?.theaterId ? { theaterId: operation.theaterId } : {}),
      ...(cliId ? { cliId } : {}),
      ...(context?.model ? { model: context.model } : {}),
      ...(context?.effort ? { effort: context.effort } : {}),
      goalCheckLimit: launchCheckLimit,
      ...(context?.prompt ? { prompt: context.prompt } : {}),
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
        void notifySessionUpdated(dormant);
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
    dropGoalTranscriptCache(readProviderSession(ctx.host.operations.get(sessionId)?.payload)?.transcriptPath);
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
        void notifySessionUpdated(applied.session);
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
    const safeLabel = sanitizeGoalCondition(label);
    if (safeLabel.length === 0) return;
    injectSerializedCommand(sessionId, `${renameCommand} ${safeLabel}`);
  }

  function injectGoalCommand(sessionId: string, condition: string): void {
    const goalCommand = terminalRuntime.getGoalCommand(sessionId);
    if (!goalCommand) return;
    injectSerializedCommand(sessionId, `${goalCommand} ${condition}`);
  }

  function injectGoalClear(sessionId: string): void {
    const goalCommand = terminalRuntime.getGoalCommand(sessionId);
    if (!goalCommand) return;
    injectSerializedCommand(sessionId, `${goalCommand} clear`);
  }

  function injectSerializedCommand(sessionId: string, command: string): void {
    const policy = terminalRuntime.getMessagePolicy(sessionId) ?? {};
    // 리마인더와 동일한 세션 키/writer로 직렬화해 명령+리마인더 인터리브를 막는다.
    reminderWriter.enqueue(
      sessionId,
      (data) => terminalRuntime.write(sessionId, data),
      formatPtyMessage(policy, command, process.platform, CONSOLE_PTY_MESSAGE_DELIVERY),
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

function readPayloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function readPayloadNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// 부재는 그 사실 자체가 의미다: goalLaunchCheckLimit이 없으면 자식이 받은 cap은 기본값이고
// (clampGoalCheckLimit(undefined)이 그 값이다), goalClearedBaseline이 없으면 해제 이력이 없다.
function readPositiveNumber(payload: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readOperationGoal(payload: Record<string, unknown> | undefined): OperationGoalRecord | undefined {
  const value = payload?.goal;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.origin !== "fleet" && candidate.origin !== "terminal") return undefined;
  if (typeof candidate.checkLimit !== "number" || !Number.isFinite(candidate.checkLimit)) return undefined;
  if (typeof candidate.requestedAt !== "number" || !Number.isFinite(candidate.requestedAt)) return undefined;
  if (typeof candidate.markerBaseline !== "number" || !Number.isSafeInteger(candidate.markerBaseline) || candidate.markerBaseline < 0) return undefined;
  if (candidate.condition !== undefined && typeof candidate.condition !== "string") return undefined;
  return {
    origin: candidate.origin,
    checkLimit: clampGoalCheckLimit(candidate.checkLimit),
    requestedAt: candidate.requestedAt,
    markerBaseline: candidate.markerBaseline,
    ...(typeof candidate.condition === "string" ? { condition: candidate.condition } : {}),
  };
}

function sanitizeGoalCondition(value: string): string {
  return sanitizePtyMessageText(value.replace(/[\r\n\t]+/g, " ")).trim();
}

function isLiveAgentSession(session: AgentTerminalSessionInfo): boolean {
  return session.status === "starting" || session.status === "terminal-only" || session.status === "registered";
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


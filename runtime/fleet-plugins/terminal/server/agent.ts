import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";

import { buildGatewayModelsToolSpec, createDelayedPtyWriter, createFleetGatewayAgentRuntimeLifecycle, formatPtyMessage, getAgentCliIds, getAgentCliMetadata, LaunchPromptError, MAX_LAUNCH_PROMPT_CHARS, NATIVE_CLAUDE_EFFORTS, parseAgentCliId, resolveNativeClaudeModelAlias, sanitizeLaunchPrompt, sanitizePtyMessageText, type AgentCliId, type PtyInputChunk } from "@dotobokuri/fleet-admiral";
import type { AgentToolSpec } from "@dotobokuri/core-agent";
import { ensureWorkspaceDirectory, withDirectoryLock, type GlobalOptionsService } from "@dotobokuri/core-infra";
import { createWikiWorkspaceResolver, getWikiToolSpecs } from "@dotobokuri/fleet-wiki";
import type { OperationLaunchKind, OperationNode, OperationPatchInput } from "@fleet-console/sdk/operations";
import { registerRouter } from "@fleet-console/sdk/plugin/node";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { readSocketRole } from "./shared/index.js";
import type { TerminalRuntime } from "./shared/index.js";

import { createDefaultAgentCliDetector, validateAgentCliPathForSave, type AgentCliDetector } from "./agent-api/agent-cli-detect.js";
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
import { readBackgroundHookReport } from "./agent-api/background-report.js";
import { createAgentTerminalLaunchResolver, GatewayLaunchOptionError, isGatewayLaunchEffortAllowed, type ConsoleRuntimeSessionInfo } from "./agent-api/launch.js";
import { composeLaunchPromptWithAttachments, createLaunchAttachmentStore, LaunchAttachmentError, readLaunchAttachmentBody } from "./agent-api/launch-attachments.js";
import { AGENT_LAUNCH_PROVIDER_PAYLOAD_KEY, agentLaunchProviderFromModel, isAgentLaunchProvider } from "./agent-api/launch-provider.js";
import { createConsoleObservabilityStore } from "./agent-api/observability-store.js";
import { writeAgentSessionEvents } from "./agent-api/observability-routes.js";
import { createOscAgentActivityTracker, type OscAgentActivityTracker } from "./agent-api/osc-agent-activity.js";
import { readAnalysisProviderSession, readProviderSession, type AnalysisProviderSession } from "./agent-api/provider-session.js";
import { AgentChatRegistry, type AgentChatSessionSeed, type CreateChatSdk } from "./agent-api/chat-session.js";
import { resolveAnalysisGatewayBaseUrl } from "./agent-api/analysis-types.js";
import { resolveTranscriptPath } from "./agent-api/transcript-path.js";
import type { ClaudeGatewayEffort } from "@dotobokuri/core-agent/claude";
import type { AgentProviderSession, AgentProviderTitleMarker, AgentTerminalSessionInfo, AgentLabelSource } from "./agent-api/types.js";
import { startIdleAgentDormantSweeper } from "./agent-idle-dormant-sweeper.js";
type SessionCreateBody = { readonly cliId?: unknown; readonly theaterId?: unknown; readonly model?: unknown; readonly effort?: unknown; readonly prompt?: unknown; readonly attachmentIds?: unknown };
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
// 재기동 직후 전달의 부팅 여유폭 — resume된 CLI가 컴포저를 세우기 전의 stdin flush에 페이로드가
// 삼켜지지 않도록 페이로드 앞에 두는 지연이다.
const RESUMED_PTY_MESSAGE_BOOT_DELAY_MS = 1500;
const OPERATION_RENAMED_EVENT_CHANNEL = "operation:renamed";
const OPERATION_RESTORED_EVENT_CHANNEL = "operation:restored";
const OPERATION_DELETED_EVENT_CHANNEL = "operation:deleted";
const OPERATION_PURGED_EVENT_CHANNEL = "operation:purged";
const TERMINAL_PLUGIN_ID = "terminal";
/** Chat Mode를 여는 payload 마커 — 브라우저 DTO에 그대로 흐르는 비민감 불리언이다. */
const CHAT_MODE_PAYLOAD_KEY = "chatMode";
/** Phase 1에서 Chat Mode를 지원하는 유일한 실행 종류. */
const CHAT_SUPPORTED_CLI_ID = "claude-gateway";

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
  registerRouter(ctx, "agent", api.handle, [
    { method: "GET", path: "/state", summary: "Read Agent session state.", category: "Terminal Plugin", gate: "loopback", transport: "http" },
    { method: "GET", path: "/agent-cli/state", summary: "Read installed Agent CLI status.", category: "Terminal Plugin", gate: "loopback", transport: "http" },
    { method: "GET", path: "/agent-cli/diagnostics", summary: "Read Agent CLI diagnostics.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "PUT", path: "/agent-cli/path", summary: "Save an Agent CLI executable path.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "GET", path: "/events", summary: "Stream Agent session events.", category: "Terminal Plugin", gate: "loopback", transport: "sse" },
    { method: "GET", path: "/sessions", summary: "List Agent sessions.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "POST", path: "/sessions", summary: "Create an Agent session.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "DELETE", path: "/sessions/:sessionId", summary: "Delete an Agent session.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "POST", path: "/sessions/:sessionId/resume", summary: "Resume an Agent session.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "POST", path: "/sessions/:sessionId/message", summary: "Deliver a prompt to an Agent session.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "POST", path: "/sessions/:sessionId/chat", summary: "Switch an Agent session to chat mode.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "DELETE", path: "/sessions/:sessionId/chat", summary: "Leave chat mode for an Agent session.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "GET", path: "/sessions/:sessionId/chat-stream", summary: "Stream Agent chat events.", category: "Terminal Plugin", gate: "origin-write", transport: "sse" },
    { method: "POST", path: "/sessions/:sessionId/turn", summary: "Receive an Agent turn hook.", category: "Terminal Plugin", gate: "lock-token", transport: "http" },
    { method: "POST", path: "/sessions/:sessionId/background", summary: "Receive an Agent background-task hook.", category: "Terminal Plugin", gate: "lock-token", transport: "http" },
    { method: "POST", path: "/sessions/:sessionId/attention", summary: "Receive an Agent attention hook.", category: "Terminal Plugin", gate: "lock-token", transport: "http" },
    { method: "POST", path: "/sessions/:sessionId/auto-name", summary: "Receive an Agent auto-name hook.", category: "Terminal Plugin", gate: "lock-token", transport: "http" },
    { method: "POST", path: "/sessions/:sessionId/capture", summary: "Receive an Agent session capture hook.", category: "Terminal Plugin", gate: "lock-token", transport: "http" },
    { method: "POST", path: "/ticket", summary: "Issue an Agent Terminal WebSocket ticket.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "POST", path: "/attachments", summary: "Upload a Quick Launch image attachment.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "DELETE", path: "/attachments/:attachmentId", summary: "Discard an unsent Quick Launch image attachment.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
  ]);
  return api.launchKinds;
}

export function buildAgentLaunchKindBackfillPatch(operation: AgentLaunchKindBackfillOperation): Pick<OperationPatchInput, "payload"> | null {
  if (operation.pluginId !== TERMINAL_PLUGIN_ID || operation.type !== AGENT_OPERATION_TYPE) return null;
  const cliId = operation.payload.cliId;
  if (typeof cliId !== "string" || cliId.length === 0) return null;
  if (operation.payload.launchKindId !== undefined) return null;
  return { payload: { ...operation.payload, launchKindId: cliId } };
}

/**
 * 공급자 기록이 없는 agent Operation을 순정 Claude로 메운다. 이 축이 생기기 전에 실행된
 * Operation의 실제 모델은 어디에도 남아 있지 않지만, 그때도 크롬은 Claude 마크를 보여 주고
 * 있었으므로 같은 사실로 메워야 새 실행과 표현이 갈라지지 않는다.
 */
export function buildAgentLaunchProviderBackfillPatch(operation: AgentLaunchKindBackfillOperation): Pick<OperationPatchInput, "payload"> | null {
  if (operation.pluginId !== TERMINAL_PLUGIN_ID || operation.type !== AGENT_OPERATION_TYPE) return null;
  if (isAgentLaunchProvider(operation.payload[AGENT_LAUNCH_PROVIDER_PAYLOAD_KEY])) return null;
  return { payload: { ...operation.payload, [AGENT_LAUNCH_PROVIDER_PAYLOAD_KEY]: "claude" } };
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
        // identity와 roster는 delegationModels를, wire·launch picker·validation은 models를 사용한다.
        models: selection.delegationModels,
        effortExposure: selection.effortExposure,
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
  // __fleetTerminalLaunch/__fleetTerminalStartShell와 같은 자리의 테스트 훅이다. 플러그인 번들은
  // 호스트와 별개 모듈 인스턴스라 호스트가 만든 detector가 여기로 오지 않으므로, 설치 여부를
  // 고정하려면 이 훅을 거쳐야 한다. 이것이 없으면 세션 생성 테스트가 실행 기계에 Claude Code가
  // 설치돼 있는지에 따라 갈린다.
  const testDetector = (globalThis as { __fleetAgentCliDetector?: AgentCliDetector }).__fleetAgentCliDetector;
  const detector = testDetector ?? createDefaultAgentCliDetector(readAgentCliPaths);
  const launchAttachments = createLaunchAttachmentStore({ dataDir: ctx.host.paths.fleetDataDir });
  const pendingRuntimeSessions = new Map<string, ConsoleRuntimeSessionInfo>();
  const identityRefreshes = new Map<string, { running: boolean; queued: boolean }>();
  const oscActivityTrackers = new Map<string, OscAgentActivityTracker>();
  // __fleetAgentCliDetector와 같은 자리의 테스트 훅 — 실 SDK 스폰 없이 chat 경로를 고정한다.
  const testChatSdkFactory = (globalThis as { __fleetAgentChatSdkFactory?: CreateChatSdk }).__fleetAgentChatSdkFactory;
  const chatRegistry = testChatSdkFactory ? new AgentChatRegistry(testChatSdkFactory) : new AgentChatRegistry();
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
      if (cliId !== "claude-gateway") return;
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
  // rename 주입이 세션 단위로 직렬화되도록 공유 writer를 쓴다.
  const reminderWriter = createDelayedPtyWriter();
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
  const unsubscribeChatDelete = ctx.host.events.subscribe(OPERATION_DELETED_EVENT_CHANNEL, (payload) => {
    if (isOperationDeletedEventPayload(payload) && payload.pluginId === ctx.pluginId) void chatRegistry.dispose(payload.operationId);
  });
  const unsubscribeRestore = ctx.host.events.subscribe(OPERATION_RESTORED_EVENT_CHANNEL, (payload) => {
    if (!isOperationRestoredEvent(payload) || payload.pluginId !== ctx.pluginId || payload.type !== AGENT_OPERATION_TYPE) return;
    const operation = ctx.host.operations.get(payload.operationId);
    if (!operation || observability.getTerminalSessionInfo(operation.id)) return;
    const dormant = injectOperation(operation);
    observability.notifySessionUpdated(dormant);
  });

  // 호스트 주도 삭제(Theater 잊기 등)는 플러그인 DELETE 라우트를 지나지 않는다 — 유예가 끝나
  // 복원 불가로 확정되는 purge가 그 경로의 유일한 회수 신호다. deleted 시점에 거두면 유예 중
  // 복원된 Operation이 첨부를 잃는다.
  const unsubscribePurge = ctx.host.events.subscribe(OPERATION_PURGED_EVENT_CHANNEL, (payload) => {
    if (!isOperationRestoredEvent(payload) || payload.pluginId !== ctx.pluginId || payload.type !== AGENT_OPERATION_TYPE) return;
    launchAttachments.releaseSession(payload.operationId);
  });

  backfillAgentOperationLaunchAxes();
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
    if (path === "/attachments") return handleAttachmentUpload(req, res);
    const attachmentMatch = path.match(/^\/attachments\/([^/]+)$/);
    if (attachmentMatch) return handleAttachmentDiscard(req, res, decodeURIComponent(attachmentMatch[1] ?? ""));
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
      // chat 전환 응답과 PTY 종료 사이의 좁은 창에서 stale TerminalSurface가 ticket으로
      // 터미널을 되살리지 못하게 한다 — 터미널 복귀는 /chat DELETE + /resume 경로만이 연다.
      if (operation.payload[CHAT_MODE_PAYLOAD_KEY] === true) {
        ctx.host.http.writeJson(res, 409, { error: "operation_chat_mode" });
        return true;
      }
      const cwd = readPayloadString(operation.payload, "cwd") ?? ctx.host.paths.resolveTheaterPath(operation.theaterId);
      if (!cwd) {
        ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
        return true;
      }
      const colorScheme = body?.colorScheme === "light" || body?.colorScheme === "dark" ? body.colorScheme : undefined;
      // 등급은 Console이 정한다. 요청이 control을 원해도 제어를 쥔 원격이 있으면 관전으로 내려간다 —
      // 새로고침 한 번이 조용히 제어를 되가져가는 경합을 클라이언트에 맡기지 않는다.
      const role = ctx.host.security.resolveTerminalSocketRole(req) === "viewer" ? "viewer" : readSocketRole(body?.role);
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

  async function handleAttachmentUpload(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"]): Promise<boolean> {
    if (req.method !== "POST") return methodNotAllowed(res);
    if (!ctx.host.security.isTerminalAuthorized(req)) return unauthorized(res);
    try {
      // 상한이 이미 찼으면 본문을 받기 전에 거절한다 — 10MB를 다 받아 놓고 거절하는 상한은
      // 메모리 보호라는 목적을 잃는다.
      launchAttachments.assertSaveCapacity();
      const bytes = await readLaunchAttachmentBody(req);
      // 응답은 불투명 id뿐이다 — 저장 경로는 브라우저 DTO에 오르지 못한다(Console 보안 불변식).
      ctx.host.http.writeJson(res, 200, launchAttachments.save(bytes));
    } catch (error) {
      // 업로드 중 클라이언트가 끊으면 본문 스트림이 거절로 끝난다 — 죽은 소켓에는 답하지 않는다.
      if (res.destroyed || res.writableEnded) return true;
      if (error instanceof LaunchAttachmentError) {
        ctx.host.http.writeJson(res, 400, { error: error.code });
        return true;
      }
      ctx.host.http.writeJson(res, 500, { error: "attachment_upload_failed" });
    }
    return true;
  }

  async function handleAttachmentDiscard(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], attachmentId: string): Promise<boolean> {
    if (req.method !== "DELETE") return methodNotAllowed(res);
    if (!ctx.host.security.isTerminalAuthorized(req)) return unauthorized(res);
    // 발사된 첨부는 지울 수 없고, 이미 사라진 id는 이미 원하는 상태다 — 둘 다 200으로 답한다.
    launchAttachments.discard(attachmentId);
    ctx.host.http.writeJson(res, 200, { ok: true });
    return true;
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
    const attachmentIds = readAttachmentIds(body?.attachmentIds, res);
    if (attachmentIds === false) return true;
    const cwd = ctx.host.paths.resolveTheaterPath(theaterId);
    if (!cwd) {
      ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
      return true;
    }
    let composedPrompt: string | undefined;
    try {
      // 모르는 id·상한 초과는 스폰 전에 거절한다 — 세션을 만들고 나서 거절하면 빈 Operation이 남는다.
      // 해석은 스폰이 끝날 때까지 id를 예약하므로 마지막 거절 관문 뒤에 서고, 스폰 실패는
      // createSession이 unreserve로 되돌린다. 경로 지시는 여기서 합성되어 이후의 런치 프롬프트
      // 가드(cmd-shim·명령줄 예산)를 그대로 지난다.
      composedPrompt = composeLaunchPromptWithAttachments(prompt, launchAttachments.resolve(attachmentIds));
    } catch (error) {
      if (error instanceof LaunchAttachmentError) {
        ctx.host.http.writeJson(res, 400, { error: error.code });
        return true;
      }
      throw error;
    }
    try {
      await createSession(cwd, theaterId, cliId, res, {
        ...launchOptions,
        ...(composedPrompt ? { prompt: composedPrompt } : {}),
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      });
    } catch (error) {
      // createSession이 스스로 처리하지 못한 throw까지 예약을 되돌린다 — bind 후에는 no-op이라 안전.
      if (attachmentIds.length > 0) launchAttachments.unreserve(attachmentIds);
      throw error;
    }
    return true;
  }

  function readAttachmentIds(value: unknown, res: Parameters<typeof handle>[0]["res"]): readonly string[] | false {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.length === 0)) {
      ctx.host.http.writeJson(res, 400, { error: "attachment_not_found" });
      return false;
    }
    return value as readonly string[];
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
    const nativeAlias = resolveNativeClaudeModelAlias(model);
    if (nativeAlias) {
      // ultracode는 wire effort가 아니라 하네스 능력이라 네이티브 행도 ultra를 받는다 —
      // wire로의 번역(max + settings)은 launch factory가 담당한다.
      if (effort !== undefined && !([...NATIVE_CLAUDE_EFFORTS, "ultra"] as readonly string[]).includes(effort)) {
        ctx.host.http.writeJson(res, 400, { error: "invalid_effort" });
        return false;
      }
      return { model: nativeAlias, ...(effort === undefined ? {} : { effort }) };
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
    if (action === "message") return handleMessage(req, res, sessionId);
    if (action === "chat") return handleChat(req, res, sessionId);
    if (action === "chat-stream") return handleChatStream(req, res, sessionId);
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

  async function createSession(
    cwd: string,
    theaterId: string,
    cliId: AgentCliId,
    res: Parameters<typeof handle>[0]["res"],
    launchOptions: { readonly model?: string; readonly effort?: string; readonly prompt?: string; readonly attachmentIds?: readonly string[] } = {},
  ): Promise<void> {
    const meta = (await buildAgentCliLaunchMetadata()).find((entry) => entry.id === cliId);
    if (!meta || !meta.available || !meta.signedIn) {
      // 이 preflight 거절은 unreserve가 있는 아래 try보다 앞이다 — 여기서 되돌리지 않으면
      // 예약이 영영 남아 재시도가 전부 attachment_not_found로 떨어진다.
      if (launchOptions.attachmentIds && launchOptions.attachmentIds.length > 0) {
        launchAttachments.unreserve(launchOptions.attachmentIds);
      }
      ctx.host.http.writeJson(res, 409, { error: "agent_cli_unavailable" });
      return;
    }
    const sessionId = crypto.randomUUID();
    const session = observability.createPendingTerminalSession({ sessionId, cwd, cliId });
    // 원문은 argv에 오르지 않고 파일 포인터가 첫 UserPromptSubmit이 된다. 그 지시는 절대
    // 경로라 deriveOperationLabel이 폐기하고, 작명이 후속 턴으로 밀린다. 원문은 이 시점에만
    // 서버에 있으므로 같은 휴리스틱으로 첫 작명을 여기서 적용한다. payload·브라우저 DTO에는
    // 원문을 넣지 않는다.
    const named = launchOptions.prompt === undefined
      ? null
      : observability.autoNameTerminalSession(sessionId, deriveOperationLabel(launchOptions.prompt));
    const namedSession = named?.session ?? session;
    ctx.host.operations.create({
      id: session.sessionId,
      theaterId,
      type: AGENT_OPERATION_TYPE,
      pluginId: ctx.pluginId,
      title: namedSession.label ?? session.label ?? path.basename(cwd),
      // 공급자는 실행 시점에 한 번 확정되고 이후 어떤 patch도 다시 쓰지 않는다 —
      // toOperationPayload가 지우는 키 목록 밖이라 resume·복원을 지나도 그대로 남는다.
      payload: {
        ...toOperationPayload(undefined, cwd, namedSession),
        [AGENT_LAUNCH_PROVIDER_PAYLOAD_KEY]: agentLaunchProviderFromModel(launchOptions.model),
        // Claude Code의 resume가 launch 좌표를 자체 복원한다고 가정하지 않는다 — 정규화된
        // 최초 선택을 Operation에 남겨 dormant·Console 재시작 뒤에도 같은 인자로 재개한다.
        ...(launchOptions.model ? { launchModel: launchOptions.model } : {}),
        ...(launchOptions.effort ? { launchEffort: launchOptions.effort } : {}),
      },
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
      // 스폰이 성공했을 때만 묶는다 — 거절·실패한 실행의 첨부는 미발사분으로 남아 재시도가
      // 같은 id를 다시 실을 수 있고, 남으면 TTL이 거둔다.
      if (launchOptions.attachmentIds && launchOptions.attachmentIds.length > 0) {
        launchAttachments.bind(sessionId, launchOptions.attachmentIds);
        // attach의 await 동안 DELETE가 지나갔다면 이 bind는 고아다 — 되짚어 거둔다(멘션 경로와 같은 계약).
        if (!ctx.host.operations.get(sessionId)) launchAttachments.releaseSession(sessionId);
      }
      const runtimeSession = pendingRuntimeSessions.get(sessionId);
      pendingRuntimeSessions.delete(sessionId);
      const created = runtimeSession
        ? observability.registerTerminalRuntimeSession(runtimeSession) ?? namedSession
        : observability.updateTerminalSessionStatus(sessionId, "terminal-only") ?? namedSession;
      observability.notifySessionUpdated(created);
      ctx.host.operations.patch(sessionId, { payload: toOperationPayload(ctx.host.operations.get(sessionId)?.payload, cwd, created, undefined, observability.getDurableOperation(sessionId)?.providerTitle) });
      ctx.host.http.writeJson(res, 200, created);
    } catch (error) {
      // 실패한 스폰은 첨부 예약을 되돌린다 — 재시도가 같은 id를 다시 실을 수 있고,
      // 남으면 TTL이 거둔다.
      if (launchOptions.attachmentIds && launchOptions.attachmentIds.length > 0) {
        launchAttachments.unreserve(launchOptions.attachmentIds);
      }
      if (error instanceof GatewayLaunchOptionError) {
        removeSession(sessionId);
        ctx.host.http.writeJson(res, gatewayLaunchOptionErrorStatus(error), { error: error.code });
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
    // chat 모드 Operation의 resume은 터미널 복귀다 — 진행 중 chat 턴이 있으면 같은 세션 위에
    // 두 필자를 만들 수 없어 거절하고, 아니면 chat 세션을 접고 모드 마커를 걷은 뒤 재기동한다.
    let resumeNode = node;
    let resumeProviderSession = providerSession;
    if (node.payload[CHAT_MODE_PAYLOAD_KEY] === true) {
      if (chatRegistry.isBusy(sessionId)) {
        ctx.host.http.writeJson(res, 409, { error: "chat_busy" });
        return true;
      }
      await chatRegistry.dispose(sessionId);
      // dispose까지의 write-back이 providerSession을 갱신했을 수 있다 — 최신 payload로 다시 읽는다.
      const cleared = { ...(ctx.host.operations.get(sessionId)?.payload ?? node.payload) };
      delete cleared[CHAT_MODE_PAYLOAD_KEY];
      ctx.host.operations.patch(sessionId, { payload: cleared });
      const releasedOnResume = observability.setTerminalSessionChatActive(sessionId, false);
      if (releasedOnResume) observability.notifySessionUpdated(releasedOnResume);
      resumeNode = ctx.host.operations.get(sessionId) ?? node;
      if (!fresh) resumeProviderSession = readProviderSession(resumeNode.payload) ?? providerSession;
    }
    const result = await resumeAgentSessionCore(resumeNode, sessionId, cliId, { fresh, providerSession: resumeProviderSession });
    if (!result.ok) {
      ctx.host.http.writeJson(res, result.status, { error: result.error });
      return true;
    }
    ctx.host.http.writeJson(res, 200, result.resumed);
    return true;
  }

  // handleResume(fresh 포함)과 handleMessage(dormant 전달)가 공유하는 재기동 코어 — 상태 어휘·
  // 기본 모델 폴백·롤백 계약이 한 곳에만 살아야 두 진입점이 같은 Operation을 같은 좌표로 되살린다.
  async function resumeAgentSessionCore(
    node: OperationNode,
    sessionId: string,
    cliId: AgentCliId,
    options: { readonly fresh: boolean; readonly providerSession: AgentProviderSession | undefined },
  ): Promise<{ ok: true; resumed: AgentTerminalSessionInfo } | { ok: false; status: number; error: string }> {
    const { fresh, providerSession } = options;
    // launchModel 도입 전 Operation은 복원할 정확한 좌표가 없으므로 Claude Gateway에만
    // 신규 Quick Launch와 같은 native Opus 1M 기본값을 적용한다. 다른 CLI에는 넘기지 않는다.
    const launchModel = readPayloadString(node.payload, "launchModel")
      || (cliId === "claude-gateway" ? "opus[1m]" : undefined);
    const launchEffort = readPayloadString(node.payload, "launchEffort") || undefined;
    // cwd 해석은 상태 전이 전에 끝낸다 — 'starting'으로 올린 뒤 404로 빠지면 catch의 dormant
    // 복귀를 건너뛰어 세션이 starting에 고착된다.
    const cwd = readPayloadString(node.payload, "cwd") ?? ctx.host.paths.resolveTheaterPath(node.theaterId);
    if (!cwd) return { ok: false, status: 404, error: "theater_not_found" };
    resetOscActivity(sessionId);
    const starting = observability.updateTerminalSessionStatus(sessionId, "starting") ?? injectOperation(node);
    try {
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
        ...(launchModel ? { model: launchModel } : {}),
        ...(launchEffort ? { effort: launchEffort } : {}),
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
      const resumedPayload = toOperationPayload(currentPayload ?? node.payload, cwd, resumed, effectiveProviderSession, observability.getDurableOperation(sessionId)?.providerTitle);
      // Legacy fallback도 첫 성공 뒤에는 Operation의 확정 launch 좌표가 된다 — 매 resume마다
      // fallback 정책을 다시 적용해 향후 기본값 변경에 따라 같은 Operation이 흔들리지 않게 한다.
      if (!readPayloadString(resumedPayload, "launchModel") && launchModel) resumedPayload.launchModel = launchModel;
      ctx.host.operations.patch(sessionId, { payload: resumedPayload });
      return { ok: true, resumed };
    } catch (error) {
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
      if (error instanceof GatewayLaunchOptionError) {
        return { ok: false, status: gatewayLaunchOptionErrorStatus(error), error: error.code };
      }
      return { ok: false, status: 503, error: "terminal_unavailable" };
    }
  }

  // Quick Launch 멘션 전달 라우트. 살아 있는 세션이면 PTY에 곧장 쓰고, dormant면 재기동(비-fresh
  // resume) 후 같은 요청 안에서 전달한다 — 재기동 흐름은 handleResume의 비-fresh 경로와 행동
  // 쌍둥이로 유지한다(fresh 분기가 얽힌 handleResume를 쪼개면 그쪽 롤백 계약이 흔들린다).
  // 응답에는 프롬프트 원문·providerSession·경로를 싣지 않는다.
  async function handleMessage(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string): Promise<boolean> {
    if (req.method !== "POST") return methodNotAllowed(res);
    if (!ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await ctx.host.http.readJsonBody<{ readonly text?: unknown; readonly attachmentIds?: unknown }>(req);
    const text = body?.text;
    if (typeof text !== "string") {
      ctx.host.http.writeJson(res, 400, { error: "message_invalid" });
      return true;
    }
    if (text.length > MAX_LAUNCH_PROMPT_CHARS) {
      ctx.host.http.writeJson(res, 400, { error: "prompt_too_long" });
      return true;
    }
    const attachmentIds = readAttachmentIds(body?.attachmentIds, res);
    if (attachmentIds === false) return true;
    // PTY로 나가는 텍스트에서 제어 바이트·괄호붙임 종료 마커를 벗겨낸다 — rename 주입과 같은 방어선.
    const sanitized = sanitizePtyMessageText(text);
    if (sanitized.trim().length === 0) {
      ctx.host.http.writeJson(res, 400, { error: "message_empty" });
      return true;
    }
    const node = ctx.host.operations.get(sessionId);
    if (!node || node.pluginId !== ctx.pluginId || node.type !== AGENT_OPERATION_TYPE) {
      ctx.host.http.writeJson(res, 404, { error: "session_not_found" });
      return true;
    }
    // 첨부 경로는 런치와 같은 문법으로 본문 뒤에 합성된다. 해석은 전달이 끝날 때까지 id를
    // 예약하므로 여기(모든 syntactic 거절 뒤)에 서고, 이후의 모든 실패 경로가 settle(false)로
    // 되돌린다 — 성공만 세션에 묶어 파일 수명이 그 Operation을 따르게 한다.
    let attachmentPaths: readonly string[] = [];
    try {
      attachmentPaths = launchAttachments.resolve(attachmentIds);
    } catch (error) {
      if (error instanceof LaunchAttachmentError) {
        ctx.host.http.writeJson(res, 400, { error: error.code });
        return true;
      }
      throw error;
    }
    const settleAttachments = (delivered: boolean) => {
      if (attachmentIds.length === 0) return;
      if (delivered) {
        launchAttachments.bind(sessionId, attachmentIds);
        // resume·chat ensure의 await 동안 DELETE가 지나갔다면 releaseSession은 이미 끝났고
        // (예약분은 건너뛰었다), 방금의 bind는 고아가 된다 — 지금 되짚어 거둔다.
        if (!ctx.host.operations.get(sessionId)) launchAttachments.releaseSession(sessionId);
        return;
      }
      launchAttachments.unreserve(attachmentIds);
    };
    // resolve가 연 예약은 아래 어떤 경로로 던져져도 닫혀야 한다 — settle을 지나 bind된 뒤의
    // unreserve는 no-op이라(sessionId가 이미 붙었다) 이중 정산이 안전하다.
    try {
    // Chat Mode Operation은 PTY가 없다 — 전달은 SDK 턴으로 실행된다. 구조화 경로라 PTY 정화를
    // 거치지 않은 원문을 그대로 쓴다(빈 문자열·상한 검사는 위에서 끝났다).
    if (node.payload[CHAT_MODE_PAYLOAD_KEY] === true) {
      const seed = await resolveChatSeed(node);
      if (!seed.ok) {
        settleAttachments(false);
        ctx.host.http.writeJson(res, seed.status, { error: seed.error });
        return true;
      }
      // seed 해석의 await 동안 DELETE가 chat을 접었을 수 있다 — ensure와 같은 tick에서 모드를
      // 재검증해야 stale 요청이 새 chat 세션을 만들어 되살아난 PTY와 이중 필자가 되지 않는다.
      if (ctx.host.operations.get(sessionId)?.payload[CHAT_MODE_PAYLOAD_KEY] !== true) {
        settleAttachments(false);
        ctx.host.http.writeJson(res, 409, { error: "chat_not_active" });
        return true;
      }
      try {
        const chat = await chatRegistry.ensure(sessionId, () => seed.seed);
        if (!chat.canReportActivity()) {
          settleAttachments(false);
          ctx.host.http.writeJson(res, 503, { error: "chat_activity_unavailable" });
          return true;
        }
        chat.send(composeLaunchPromptWithAttachments(text.trim(), attachmentPaths) as string);
      } catch {
        settleAttachments(false);
        ctx.host.http.writeJson(res, 503, { error: "chat_unavailable" });
        return true;
      }
      settleAttachments(true);
      ctx.host.http.writeJson(res, 200, { delivered: true, chat: true });
      return true;
    }
    const deliveredText = composeLaunchPromptWithAttachments(sanitized, attachmentPaths) as string;
    const deliver = (leadChunks: readonly PtyInputChunk[] = []) => {
      const policy = terminalRuntime.getMessagePolicy(sessionId) ?? {};
      // rename 주입과 같은 세션 키/writer로 직렬화해 rename+메시지 인터리브를 막는다.
      reminderWriter.enqueue(
        sessionId,
        (data) => terminalRuntime.write(sessionId, data),
        [...leadChunks, ...formatPtyMessage(policy, deliveredText, process.platform, CONSOLE_PTY_MESSAGE_DELIVERY)],
      );
    };
    if (terminalRuntime.getSessionLastActivityAt(sessionId) !== null) {
      // awaiting 재검사: 덱은 pick 시점만 가드한다 — 작성하는 사이 CLI가 권한 프롬프트로 전환하면
      // 전달 끝의 줄 종결자가 대기 중인 선택지를 그대로 확정해 버린다. 직접 POST 호출도 여기서 닫힌다.
      if (observability.getTerminalSessionInfo(sessionId)?.attentionPending === true) {
        settleAttachments(false);
        ctx.host.http.writeJson(res, 409, { error: "session_awaiting_input" });
        return true;
      }
      deliver();
      settleAttachments(true);
      ctx.host.http.writeJson(res, 200, { delivered: true });
      return true;
    }
    // dormant 대상은 재기동 후 전달한다(제품 결정). providerSession이 없으면 이어붙일 세션이 없다.
    const cliId = readOptionalAgentCliId(node.payload?.cliId, res);
    if (cliId === false) {
      settleAttachments(false);
      return true;
    }
    const providerSession = readProviderSession(node.payload);
    if (!cliId || !providerSession) {
      settleAttachments(false);
      ctx.host.http.writeJson(res, 409, { error: "resume_unavailable" });
      return true;
    }
    const result = await resumeAgentSessionCore(node, sessionId, cliId, { fresh: false, providerSession });
    if (!result.ok) {
      settleAttachments(false);
      ctx.host.http.writeJson(res, result.status, { error: result.error });
      return true;
    }
    // 전달은 attach 성공 뒤에만 큐에 올린다 — 죽은 세션에 쌓인 메시지가 다음 재기동에 새는 것을 막는다.
    // 선두의 빈 지연 청크는 재기동된 CLI TUI의 부팅·raw-mode 초기화에 여유를 준다. readiness
    // 신호가 없는 경로라 보장이 아니라 여유폭이다(fresh launch는 argv로 프롬프트를 넘겨 이 경합이 없다).
    deliver([{ data: "", submitDelayMs: RESUMED_PTY_MESSAGE_BOOT_DELAY_MS }]);
    settleAttachments(true);
    ctx.host.http.writeJson(res, 200, { delivered: true, resumed: true });
    return true;
    } catch (error) {
      // 처리되지 않은 throw가 예약을 영구 고착시키면 그 id는 어떤 재시도에도 실리지 못한다.
      if (attachmentIds.length > 0) launchAttachments.unreserve(attachmentIds);
      throw error;
    }
  }

  // ── Chat Mode ──────────────────────────────────────────────────────────────
  // 전환(POST)·터미널 복귀 준비(DELETE). 전환은 payload 마커를 먼저 심은 뒤 PTY를 접는다 —
  // handleExit의 payload 재작성은 기존 키를 보존하므로 마커는 dormant 전이를 지나도 남는다.
  async function handleChat(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string): Promise<boolean> {
    if (req.method !== "POST" && req.method !== "DELETE") return methodNotAllowed(res);
    if (!ctx.host.security.validateHost(req) || !ctx.host.security.isTerminalAuthorized(req)) return unauthorized(res);
    const node = ctx.host.operations.get(sessionId);
    if (!node || node.pluginId !== ctx.pluginId || node.type !== AGENT_OPERATION_TYPE) {
      ctx.host.http.writeJson(res, 404, { error: "session_not_found" });
      return true;
    }
    if (req.method === "DELETE") {
      if (node.payload[CHAT_MODE_PAYLOAD_KEY] !== true) {
        ctx.host.http.writeJson(res, 409, { error: "chat_not_active" });
        return true;
      }
      if (chatRegistry.isBusy(sessionId)) {
        ctx.host.http.writeJson(res, 409, { error: "chat_busy" });
        return true;
      }
      await chatRegistry.dispose(sessionId);
      // dispose까지의 write-back이 providerSession을 갱신했을 수 있다 — 최신 payload에서 마커만 걷는다.
      const cleared = { ...(ctx.host.operations.get(sessionId)?.payload ?? node.payload) };
      delete cleared[CHAT_MODE_PAYLOAD_KEY];
      ctx.host.operations.patch(sessionId, { payload: cleared });
      const released = observability.setTerminalSessionChatActive(sessionId, false);
      if (released) observability.notifySessionUpdated(released);
      ctx.host.http.writeJson(res, 200, { ok: true });
      return true;
    }
    if (node.payload[CHAT_MODE_PAYLOAD_KEY] === true) {
      ctx.host.http.writeJson(res, 200, { ok: true });
      return true;
    }
    const seed = await resolveChatSeed(node);
    if (!seed.ok) {
      ctx.host.http.writeJson(res, seed.status, { error: seed.error });
      return true;
    }
    const info = observability.getTerminalSessionInfo(sessionId);
    // PTY 스폰이 in-flight인 세션(starting)은 activity가 아직 null이라 non-live로 읽힌다 —
    // 이때 전환하면 launch가 완주해 PTY와 SDK가 같은 provider 세션의 이중 필자가 된다.
    if (info?.status === "starting") {
      ctx.host.http.writeJson(res, 409, { error: "chat_convert_busy" });
      return true;
    }
    const live = terminalRuntime.getSessionLastActivityAt(sessionId) !== null;
    if (live) {
      // Phase 1은 유휴 세션만 전환한다 — 진행 중 턴·입력 대기·턴 종료 후에도 살아 있는 백그라운드
      // 작업(backgroundPending) 중의 PTY를 접으면 그 작업을 잃는다(활동축 불변식과 같은 판정).
      if (info?.turnState === "running" || info?.attentionPending === true || info?.modelActivity === "working" || info?.backgroundPending === true) {
        ctx.host.http.writeJson(res, 409, { error: "chat_convert_busy" });
        return true;
      }
    }
    ctx.host.operations.patch(sessionId, { payload: { ...node.payload, [CHAT_MODE_PAYLOAD_KEY]: true } });
    const activated = observability.setTerminalSessionChatActive(sessionId, true);
    if (activated) observability.notifySessionUpdated(activated);
    if (live) {
      terminalRuntime.invalidateTicketsForSession(sessionId);
      terminalRuntime.terminate(sessionId);
    }
    ctx.host.http.writeJson(res, 200, { ok: true });
    return true;
  }

  function handleChatStream(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string): boolean {
    if (req.method !== "GET") return methodNotAllowed(res);
    if (!ctx.host.security.validateHost(req) || !ctx.host.security.isTerminalAuthorized(req)) return unauthorized(res);
    const node = ctx.host.operations.get(sessionId);
    if (!node || node.pluginId !== ctx.pluginId || node.type !== AGENT_OPERATION_TYPE) {
      ctx.host.http.writeJson(res, 404, { error: "session_not_found" });
      return true;
    }
    if (node.payload[CHAT_MODE_PAYLOAD_KEY] !== true) {
      ctx.host.http.writeJson(res, 409, { error: "chat_not_active" });
      return true;
    }
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    const write = (data: string) => {
      if (!closed && !res.writableEnded && !res.destroyed) res.write(data);
    };
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    const keepalive = setInterval(() => write(": keepalive\n\n"), 30_000);
    req.on("close", () => {
      closed = true;
      clearInterval(keepalive);
      unsubscribe?.();
    });
    void (async () => {
      const seed = await resolveChatSeed(node);
      if (!seed.ok) {
        write(`data: ${JSON.stringify({ seq: 0, event: { kind: "error", code: seed.error } })}\n\n`);
        res.end();
        return;
      }
      // seed 해석의 await 동안 DELETE가 chat을 접었을 수 있다 — ensure와 같은 tick의 재검증이
      // stale 스트림 요청의 새 세션 생성을 막는다(메시지 라우트와 같은 계약).
      if (ctx.host.operations.get(sessionId)?.payload[CHAT_MODE_PAYLOAD_KEY] !== true) {
        write(`data: ${JSON.stringify({ seq: 0, event: { kind: "error", code: "chat_not_active" } })}\n\n`);
        res.end();
        return;
      }
      try {
        const chat = await chatRegistry.ensure(sessionId, () => seed.seed);
        if (closed) return;
        unsubscribe = chat.subscribe((entry) => write(`data: ${JSON.stringify(entry)}\n\n`));
      } catch {
        write(`data: ${JSON.stringify({ seq: 0, event: { kind: "error", code: "chat_unavailable" } })}\n\n`);
        res.end();
      }
    })();
    return true;
  }

  type ChatSeedResolution =
    | { readonly ok: true; readonly seed: AgentChatSessionSeed }
    | { readonly ok: false; readonly status: number; readonly error: string };

  async function resolveChatSeed(node: OperationNode): Promise<ChatSeedResolution> {
    if (readPayloadString(node.payload, "cliId") !== CHAT_SUPPORTED_CLI_ID) {
      return { ok: false, status: 409, error: "chat_unsupported" };
    }
    const providerSession = readProviderSession(node.payload);
    if (!providerSession?.transcriptPath) return { ok: false, status: 409, error: "chat_transcript_missing" };
    const transcriptPath = await resolveTranscriptPath(providerSession.transcriptPath, node.ts.createdAt);
    if (!transcriptPath) return { ok: false, status: 409, error: "chat_transcript_missing" };
    const origin = ctx.host.server.origin();
    if (!origin) return { ok: false, status: 503, error: "chat_gateway_unavailable" };
    const cwd = readPayloadString(node.payload, "cwd") || ctx.host.paths.resolveTheaterPath(node.theaterId);
    if (!cwd) return { ok: false, status: 404, error: "theater_not_found" };
    // resume core와 같은 좌표 정책: launchModel이 없던 구세대 Operation은 native Opus 1M로 계속된다.
    const model = readPayloadString(node.payload, "launchModel") || "opus[1m]";
    const effort = chatEffortFromLaunchEffort(readPayloadString(node.payload, "launchEffort"));
    return {
      ok: true,
      seed: {
        baseUrl: resolveAnalysisGatewayBaseUrl(origin),
        model,
        ...(effort ? { effort } : {}),
        cwd,
        transcriptPath,
        onProviderSessionUpdate: (updated) => {
          const operation = ctx.host.operations.get(node.id);
          if (operation) ctx.host.operations.patch(node.id, { payload: { ...operation.payload, providerSession: updated } });
          observability.updateTerminalSessionProviderSession(node.id, updated);
        },
        reportActivity: (working) => {
          const updated = observability.setTerminalSessionChatWorking(node.id, working);
          // null은 이 세션이 채팅으로 인수되지 않았다는 뜻이다 — 축이 이 보고를 받을 자리가 없다.
          if (!updated) return false;
          observability.notifySessionUpdated(updated);
          return true;
        },
      },
    };
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
    const report = turnState === "ended" ? readBackgroundHookReport(body?.input, observability.getTerminalSessionSettledAgentIds(sessionId)) : undefined;
    const settled = report?.pending === undefined
      ? updated
      : observability.setTerminalSessionBackgroundPending(sessionId, report.pending, report.settledAgentIds) ?? updated;
    observability.notifySessionUpdated(settled);
    ctx.host.http.writeJson(res, 200, { ok: true });
    if (turnState === "ended") scheduleIdentityRefresh(sessionId);
    return true;
  }

  async function handleBackground(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string): Promise<boolean> {
    if (req.method !== "POST") return methodNotAllowed(res);
    if (!ctx.host.security.isLockAuthorized(req)) return unauthorized(res);
    const body = await ctx.host.http.readJsonBody<HookBackgroundBody>(req);
    const report = readBackgroundHookReport(body?.input, observability.getTerminalSessionSettledAgentIds(sessionId));
    if (report.pending === undefined) {
      // background_tasks를 읽어내지 못한 보고는 무의견이다. 상태를 건드리지 않고 조용히 수용한다.
      ctx.host.http.writeJson(res, 200, { ok: true });
      return true;
    }
    const updated = observability.setTerminalSessionBackgroundPending(sessionId, report.pending, report.settledAgentIds);
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
    const providerSession = readProviderSession(operation?.payload)?.sessionId;
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
        observability.notifySessionUpdated(dormant);
        const exitCwd = readPayloadString(ctx.host.operations.get(operationId)?.payload ?? {}, "cwd") ?? "";
        ctx.host.operations.patch(operationId, { payload: toOperationPayload(ctx.host.operations.get(operationId)?.payload, exitCwd, dormant, providerSession, observability.getDurableOperation(operationId)?.providerTitle) });
      }
    } else {
      observability.removeTerminalSession(operationId);
      // 재개 불가 종료는 Operation 삭제와 같은 결말이다 — 첨부의 수명이 Operation을 따르므로
      // 이 경로도 회수해야 플러그인 종료까지 파일이 눌러앉지 않는다(removeSession과 같은 계약).
      launchAttachments.releaseSession(operationId);
      ctx.host.operations.delete(operationId);
    }
  }

  function removeSession(sessionId: string): void {
    reminderWriter.cancel(sessionId);
    resetOscActivity(sessionId);
    void chatRegistry.dispose(sessionId);
    terminalRuntime.terminate(sessionId);
    pendingRuntimeSessions.delete(sessionId);
    observability.removeTerminalSession(sessionId);
    // 첨부 파일의 수명은 Operation을 따른다 — dormant·재개를 지나도 남고, 삭제와 함께 거둔다.
    launchAttachments.releaseSession(sessionId);
    ctx.host.operations.delete(sessionId);
  }

  async function cleanup(): Promise<void> {
    reminderWriter.cancelAll();
    unsubscribeRename();
    unsubscribeRestore();
    unsubscribeChatDelete();
    unsubscribePurge();
    unsubscribeTitle();
    await chatRegistry.disposeAll();
    for (const tracker of oscActivityTrackers.values()) tracker.reset();
    oscActivityTrackers.clear();
    launchAttachments.cleanup();
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
    const safeLabel = sanitizePtyMessageText(label.replace(/[\r\n\t]+/g, " ")).trim();
    if (safeLabel.length === 0) return;
    const policy = terminalRuntime.getMessagePolicy(sessionId) ?? {};
    // 리마인더와 동일한 세션 키/writer로 직렬화해 rename+리마인더 인터리브를 막는다.
    reminderWriter.enqueue(
      sessionId,
      (data) => terminalRuntime.write(sessionId, data),
      formatPtyMessage(policy, `${renameCommand} ${safeLabel}`, process.platform, CONSOLE_PTY_MESSAGE_DELIVERY),
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
      // 채팅이 인수한 Operation은 재시작을 건너서도 채팅이 인수한 상태다 — 마커는 payload에 남아
      // 있고 패널도 채팅 뷰로 복원되므로, 여기서 축을 되세우지 않으면 화면은 채팅을 띄운 채
      // 사이드바만 휴면이라고 말한다(이 결함의 재시작 판).
      if (operation.payload[CHAT_MODE_PAYLOAD_KEY] === true) {
        const adopted = observability.setTerminalSessionChatActive(operation.id, true);
        if (adopted) observability.notifySessionUpdated(adopted);
      }
      const cwd = readPayloadString(operation.payload, "cwd") || (ctx.host.paths.resolveTheaterPath(operation.theaterId) ?? "");
      ctx.host.operations.patch(operation.id, { payload: toOperationPayload(operation.payload, cwd, dormant, providerSession, observability.getDurableOperation(operation.id)?.providerTitle) });
    }
  }

  function backfillAgentOperationLaunchAxes(): void {
    for (const operation of ctx.host.operations.list()) {
      // 두 축을 같은 payload 위에 겹쳐 쌓아 한 번만 patch한다 — 축마다 patch하면
      // 뒤 patch가 읽는 payload가 앞 patch 이전 스냅숏이라 먼저 메운 축이 지워진다.
      const kindPatch = buildAgentLaunchKindBackfillPatch(operation);
      const payload = kindPatch?.payload ?? operation.payload;
      const providerPatch = buildAgentLaunchProviderBackfillPatch({ ...operation, payload });
      const next = providerPatch?.payload ?? kindPatch?.payload;
      if (next) ctx.host.operations.patch(operation.id, { payload: next });
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

// launch factory의 ultra는 wire effort가 아니라 하네스 능력이다 — SDK 턴에는 max로 옮긴다.
function chatEffortFromLaunchEffort(value: string): ClaudeGatewayEffort | undefined {
  if (value.length === 0) return undefined;
  if (value === "ultra") return "max";
  return (["low", "medium", "high", "xhigh", "max"] as readonly string[]).includes(value)
    ? value as ClaudeGatewayEffort
    : undefined;
}

function isOperationDeletedEventPayload(value: unknown): value is { readonly operationId: string; readonly pluginId: string } {
  if (!value || typeof value !== "object") return false;
  const event = value as { readonly operationId?: unknown; readonly pluginId?: unknown };
  return typeof event.operationId === "string" && typeof event.pluginId === "string";
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

// create와 resume는 같은 launch-option 오류 계약을 공유한다.
function gatewayLaunchOptionErrorStatus(error: GatewayLaunchOptionError): 400 | 409 {
  return error.code === "gateway_model_not_enabled" ? 409 : 400;
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


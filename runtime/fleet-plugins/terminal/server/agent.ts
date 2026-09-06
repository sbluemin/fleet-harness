import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { buildDisabledSkillOverrides, buildGatewayModelsToolSpec, createDelayedPtyWriter, createFleetGatewayAgentRuntimeLifecycle, formatPtyMessage, GATEWAY_DISABLED_CLAUDE_SKILLS, getAgentCliIds, getAgentCliMetadata, isHostSessionToolAllowed, LaunchPromptError, MAX_LAUNCH_PROMPT_CHARS, NATIVE_CLAUDE_EFFORTS, parseAgentCliId, resolveNativeClaudeModelAlias, sanitizeLaunchPrompt, sanitizePtyMessageText, writeGatewayModelCacheForHome, type AgentCliId, type PtyInputChunk } from "@dotobokuri/fleet-admiral";
import type { AgentToolSpec } from "@dotobokuri/core-agent";
import { ensureWorkspaceDirectory, withDirectoryLock, type GlobalOptionsService } from "@dotobokuri/core-infra";
import { createWikiWorkspaceResolver, getWikiToolSpecs } from "@dotobokuri/fleet-wiki";
import type { OperationGeometry, OperationLaunchKind, OperationNode, OperationPatchInput } from "@fleet-console/sdk/operations";
import { registerRouter } from "@fleet-console/sdk/plugin/node";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { readSocketRole, readTicketChannel } from "./shared/index.js";
import type { TerminalRuntime } from "./shared/index.js";

import { createDefaultAgentCliDetector, validateAgentCliPathForSave, type AgentCliDetector } from "./agent-api/agent-cli-detect.js";
import { buildAgentCliLaunchKinds } from "./agent-api/agent-cli-launch-kinds.js";
import { combineAgentCliLaunchMetadata, type AgentCliLaunchMetadata } from "./agent-api/agent-cli-launch-metadata.js";
import { AGENT_CLI_COMMANDS, createAgentCliPathStore, resolveAgentCliBinary } from "./agent-api/agent-cli-paths.js";
import type { AgentCliDiagnostics } from "./agent-api/agent-cli-types.js";
import { readConsoleQuotaSnapshot } from "./agent-api/gateway-loadout.js";
import { findGatewayModel, resolveAiGatewaySelection } from "@dotobokuri/core-ai-gateway";
import type { AiGatewayStoredSettings } from "@dotobokuri/core-ai-gateway";
import type { AiGatewayLaunchBinding } from "./agent-api/launch.js";
import { deriveOperationLabel } from "./agent-api/auto-name.js";
import { readBackgroundHookReport } from "./agent-api/background-report.js";
import { createAgentTerminalLaunchResolver, GatewayLaunchOptionError, isGatewayLaunchEffortAllowed, prepareChatClaudeSession, type ConsoleRuntimeSessionInfo } from "./agent-api/launch.js";
import { composeLaunchPromptWithAttachments, createLaunchAttachmentStore, LaunchAttachmentError, readLaunchAttachmentBody } from "./agent-api/launch-attachments.js";
import { createConsoleObservabilityStore } from "./agent-api/observability-store.js";
import { writeAgentSessionEvents } from "./agent-api/observability-routes.js";
import { createOscAgentActivityTracker, type OscAgentActivityTracker } from "./agent-api/osc-agent-activity.js";
import { mergeCapturedAgentSession, readAgentSession, readAnalysisProviderSession, readProviderSession, type AnalysisProviderSession } from "./agent-api/provider-session.js";
import { resolveChatLaunchEffort } from "./agent-api/chat-launch-effort.js";
import { AgentChatRegistry, type AgentChatSessionOrigin, type AgentChatSessionSeed, type CreateChatSdk } from "./agent-api/chat-session.js";
import { attachAgentChatSocket } from "./agent-api/chat-ws.js";
import { resolveAnalysisGatewayBaseUrl } from "./agent-api/analysis-types.js";
import { resolveTranscriptPath } from "./agent-api/transcript-path.js";
import { normalizeAttentionReason, type CapturedAgentSession, type AgentProviderTitleMarker, type AgentTerminalSessionInfo, type AgentLabelSource } from "./agent-api/types.js";
import { resolveClaudeCodeSystemPrompt } from "./settings-routes.js";
import { startIdleAgentDormantSweeper } from "./agent-idle-dormant-sweeper.js";
type SessionCreateBody = { readonly cliId?: unknown; readonly theaterId?: unknown; readonly model?: unknown; readonly effort?: unknown; readonly prompt?: unknown; readonly attachmentIds?: unknown; readonly viewMode?: unknown; readonly geometry?: unknown };
type HookTurnBody = { readonly phase?: unknown; readonly input?: unknown };
type HookBackgroundBody = { readonly input?: unknown };
type HookAttentionBody = { readonly input?: unknown; readonly reason?: unknown };
type HookAutoNameBody = { readonly input?: unknown; readonly prompt?: unknown };
type HookCaptureBody = { readonly provider?: unknown; readonly input?: unknown };
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
  /** 턴 종료 hook의 관찰자 — 실험 "세션 관찰"이 여기서 검토를 예약한다. */
  readonly onTurnEnded?: (operationId: string) => void;
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
/**
 * 이 Operation이 **채팅으로 태어났다**는 표식 — 터미널을 한 번도 띄우지 않았다는 뜻이고,
 * Quick Launch가 그 자리에서 첫 메시지를 받는 근거다.
 *
 * transcript 부재의 뜻을 가르는 데는 쓰지 않는다. 그것은 태생이 아니라 좌표가 한 번이라도
 * 심겼는지가 정하며(`resolveChatSeed`), 첫 턴 전이라면 어느 표면에서 태어났든 부재가 정상이다.
 */
const CHAT_BORN_PAYLOAD_KEY = "chatBorn";
/** Phase 1에서 Chat Mode를 지원하는 유일한 실행 종류. */
const CLAUDE_HARNESS_ID = "claude";
/**
 * 답변에 딸려 오는 자유 문장의 상한. 질문의 물리기 사유와 계획의 수정 요청이 같은 자리를 쓰며,
 * 그 문장은 자식에게 오류 결과로 전달된다 — 새 지시를 보내는 통로가 아니므로 길 필요가 없다.
 */
const MAX_CHAT_ANSWER_MESSAGE_CHARS = 2_000;

/**
 * 사용자의 실제 Claude 홈. 터미널로 띄운 CLI와 Chat Mode의 SDK가 **같이** 쓰는 한 곳이며,
 * 그래서 한 세션을 어느 표면으로 열든 같은 트랜스크립트가 자란다.
 *
 * 규칙은 자격증명 해석(core-ai-gateway `anthropic/credentials.ts`)과 같다 — 여기서 다르게 읽으면
 * 같은 사용자의 Claude 홈을 두 곳으로 갈라 보게 된다.
 */
function resolveClaudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  return configured && configured.length > 0 ? configured : path.join(os.homedir(), ".claude");
}

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
    { method: "GET", path: "/sessions/:sessionId/chat-stream", summary: "Removed — Chat Mode observation uses the ticketed WebSocket.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "POST", path: "/sessions/:sessionId/chat-answer", summary: "Answer a pending Agent chat question.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "POST", path: "/sessions/:sessionId/chat-stop", summary: "Stop the in-flight Agent chat turn.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "GET", path: "/sessions/:sessionId/chat-job", summary: "Read one Agent chat background job's detail.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "GET", path: "/sessions/:sessionId/chat-catalog", summary: "Read the Agent chat session's command, skill, and agent catalog.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
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
  const unbindChatAttach = terminalRuntime.bindChatAttach((socket, context) => {
    const sessionId = context.sessionId;
    attachAgentChatSocket(socket, async () => {
      const node = ctx.host.operations.get(sessionId);
      if (!node || node.pluginId !== ctx.pluginId || node.type !== AGENT_OPERATION_TYPE) {
        return { error: "session_not_found" };
      }
      if (node.payload[CHAT_MODE_PAYLOAD_KEY] !== true) return { error: "chat_not_active" };
      const seed = await resolveChatSeed(node);
      if (!seed.ok) return { error: seed.error };
      if (ctx.host.operations.get(sessionId)?.payload[CHAT_MODE_PAYLOAD_KEY] !== true) {
        return { error: "chat_not_active" };
      }
      try {
        return await chatRegistry.ensure(sessionId, () => seed.seed);
      } catch {
        return { error: "chat_unavailable" };
      }
    });
  });
  ctx.host.lifecycle.registerCleanup(unbindChatAttach);
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
      if (cliId !== "claude") return;
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
        const providerSession = readAnalysisProviderSession(operation.payload.session);
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
      const body = await ctx.host.http.readJsonBody<{ readonly operationId?: unknown; readonly colorScheme?: unknown; readonly role?: unknown; readonly channel?: unknown }>(req);
      if (typeof body?.operationId !== "string") {
        ctx.host.http.writeJson(res, 400, { error: "terminal_session_not_found" });
        return true;
      }
      const operation = ctx.host.operations.get(body.operationId);
      if (!operation) {
        ctx.host.http.writeJson(res, 404, { error: "terminal_session_not_found" });
        return true;
      }
      const channel = readTicketChannel(body?.channel);
      if (channel === "chat") {
        if (operation.payload[CHAT_MODE_PAYLOAD_KEY] !== true) {
          ctx.host.http.writeJson(res, 409, { error: "chat_not_active" });
          return true;
        }
        ctx.host.http.writeJson(res, 200, terminalRuntime.issueTicket({
          cwd: readPayloadString(operation.payload, "cwd") || (ctx.host.paths.resolveTheaterPath(operation.theaterId) ?? ""),
          sessionId: operation.id,
          operationId: operation.id,
          operationType: operation.type,
          pluginId: operation.pluginId,
          theaterId: operation.theaterId,
          channel: "chat",
        }));
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
      const cwd = readPayloadString(operation.payload, "cwd") || ctx.host.paths.resolveTheaterPath(operation.theaterId);
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
        cliId: CLAUDE_HARNESS_ID,
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
    const geometry = readOptionalGeometry(body?.geometry, res);
    if (geometry === false) return true;
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
    // 시작 표면. 생략은 터미널이고, 모르는 값은 조용히 접지 않고 거절한다 — 오타가 터미널로
    // 떨어지면 사용자는 자기가 채팅을 골랐다고 믿은 채 다른 것을 받는다.
    if (body?.viewMode !== undefined && body.viewMode !== "terminal" && body.viewMode !== "chat") {
      ctx.host.http.writeJson(res, 400, { error: "invalid_view_mode" });
      return true;
    }
    const chatBorn = body?.viewMode === "chat";
    if (chatBorn && cliId !== CLAUDE_HARNESS_ID) {
      ctx.host.http.writeJson(res, 409, { error: "chat_unsupported" });
      return true;
    }
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
        ...(chatBorn ? { chatBorn: true as const } : {}),
        ...(geometry ? { geometry } : {}),
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

  function readOptionalGeometry(value: unknown, res: Parameters<typeof handle>[0]["res"]): OperationGeometry | undefined | false {
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_geometry" });
      return false;
    }
    const candidate = value as Record<string, unknown>;
    const x = candidate.x;
    const y = candidate.y;
    const width = candidate.width;
    const height = candidate.height;
    const zIndex = candidate.zIndex;
    if (typeof x !== "number" || !Number.isFinite(x)
      || typeof y !== "number" || !Number.isFinite(y)
      || typeof width !== "number" || !Number.isFinite(width)
      || typeof height !== "number" || !Number.isFinite(height)
      || typeof zIndex !== "number" || !Number.isFinite(zIndex)) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_geometry" });
      return false;
    }
    return { x, y, width, height, zIndex };
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
    if (cliId !== "claude") {
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
    if (action === "chat-answer") return handleChatAnswer(req, res, sessionId);
    if (action === "chat-stop") return handleChatStop(req, res, sessionId);
    if (action === "chat-job") return handleChatJob(req, res, sessionId);
    if (action === "chat-catalog") return handleChatCatalog(req, res, sessionId);
    if (action === "chat-job-stop") return handleChatJobStop(req, res, sessionId);
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

  /**
   * 채팅으로 태어난 Operation을 세운다. PTY는 스폰하지 않는다 — 첫 프롬프트가 argv가 아니라
   * 첫 SDK 턴이 된다.
   *
   * 여기서 첫 턴의 **완주를 기다리지 않는다**. 응답이 모델을 기다리면 발사가 몇 분씩 멈추고,
   * 그동안 패널은 뜨지도 못한다. 대신 세션 등록과 첫 턴 큐잉까지만 확인하고 200을 돌려준 뒤,
   * 진행·실패는 채팅 저널이 스트림으로 말한다(전환 경로와 같은 계약).
   *
   * durable 고아를 막는 것은 응답 시점이 아니라 chatBorn 표식이다: 첫 되쓰기 전에 Console이
   * 죽어도 그 Operation은 "아직 시작하지 않은 채팅"으로 정상 복원되고, 다음 메시지가 첫 턴이 된다.
   */
  async function startChatBornSession(
    sessionId: string,
    res: Parameters<typeof handle>[0]["res"],
    launchOptions: { readonly prompt?: string; readonly attachmentIds?: readonly string[] },
  ): Promise<void> {
    const rollback = (status: number, error: string) => {
      if (launchOptions.attachmentIds && launchOptions.attachmentIds.length > 0) {
        launchAttachments.unreserve(launchOptions.attachmentIds);
      }
      // 빈 채팅 패널을 남기지 않는다 — 첫 턴을 걸지 못한 Operation은 존재하지 않는 편이 낫다.
      ctx.host.operations.delete(sessionId);
      observability.removeTerminalSession(sessionId);
      ctx.host.http.writeJson(res, status, { error });
    };
    const node = ctx.host.operations.get(sessionId);
    if (!node) return rollback(500, "session_not_found");
    // PTY가 없으므로 "스폰 중"이 아니다. 전환된 채팅이 PTY 종료 뒤 도달하는 상태(dormant +
    // chatActive)와 같은 자리에 세워, 활동축·복원 경로가 두 출신을 구별하지 않게 한다.
    observability.updateTerminalSessionStatus(sessionId, "dormant");
    const activated = observability.setTerminalSessionChatActive(sessionId, true);
    if (activated) observability.notifySessionUpdated(activated);
    const seed = await resolveChatSeed(node);
    if (!seed.ok) return rollback(seed.status, seed.error);
    let chat;
    try {
      chat = await chatRegistry.ensure(sessionId, () => seed.seed);
    } catch {
      return rollback(503, "chat_unavailable");
    }
    if (launchOptions.prompt) chat.send(launchOptions.prompt);
    if (launchOptions.attachmentIds && launchOptions.attachmentIds.length > 0) {
      launchAttachments.bind(sessionId, launchOptions.attachmentIds);
      if (!ctx.host.operations.get(sessionId)) launchAttachments.releaseSession(sessionId);
    }
    const created = observability.getTerminalSessionInfo(sessionId);
    if (created) observability.notifySessionUpdated(created);
    ctx.host.http.writeJson(res, 200, created ?? { sessionId });
  }

  async function createSession(
    cwd: string,
    theaterId: string,
    cliId: AgentCliId,
    res: Parameters<typeof handle>[0]["res"],
    launchOptions: { readonly model?: string; readonly effort?: string; readonly prompt?: string; readonly attachmentIds?: readonly string[]; readonly chatBorn?: true; readonly geometry?: OperationGeometry } = {},
  ): Promise<void> {
    const meta = (await buildAgentCliLaunchMetadata()).find((entry) => entry.id === cliId);
    if (!meta || !meta.available || !meta.signedIn) {
      // 이 preflight 거절은 unreserve가 있는 아래 try보다 앞이다 — 여기서 되돌리지 않으면
      // 예약이 영영 남아 재시도가 전부 attachment_not_found로 떨어진다.
      if (launchOptions.attachmentIds && launchOptions.attachmentIds.length > 0) {
        launchAttachments.unreserve(launchOptions.attachmentIds);
      }
      // 설치되지 않은 것과 로그인되지 않은 것은 사용자가 할 일이 서로 다르다. 여기서 이미
      // 둘을 구분해 알고 있으므로, 하나의 코드로 뭉개면 그 구분이 화면에서 사라진다.
      ctx.host.http.writeJson(res, 409, { error: meta && !meta.available ? "agent_cli_not_installed" : "agent_cli_signed_out" });
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
      payload: {
        ...toOperationPayload(undefined, cwd, namedSession),
        session: {
          harness: "claude-code",
          ...(launchOptions.model ? { model: launchOptions.model } : {}),
          ...(launchOptions.effort ? { effort: launchOptions.effort } : {}),
        },
        // 채팅으로 태어난 Operation은 두 마커를 함께 진다. chatMode가 뷰를 가르고, chatBorn이
        // "transcript 부재는 상실이 아니라 아직 첫 턴 전"이라는 뜻을 durable하게 남긴다.
        ...(launchOptions.chatBorn ? { [CHAT_MODE_PAYLOAD_KEY]: true, [CHAT_BORN_PAYLOAD_KEY]: true } : {}),
      },
      ...(launchOptions.geometry ? { geometry: launchOptions.geometry } : {}),
      createdAt: session.createdAt,
    });
    if (launchOptions.chatBorn) {
      await startChatBornSession(sessionId, res, launchOptions);
      return;
    }
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
      // 세션 좌표는 런치 시점에 이미 확정이다 — Fleet이 못박은 id이므로 capture hook을 기다리지
      // 않는다. 첫 프롬프트 없이 닫히는 패널도 자기 플러그인 트리를 걷을 수 있어야 한다.
      // 이미 좌표가 있으면 그것을 남긴다 — 재개 런치의 기존 기록이 트랜스크립트 경로까지 들고
      // 있고, 못박은 id는 그 기록과 같은 값이라 덮어써서 얻을 것이 없다.
      const launchedProviderSession = readProviderSession(ctx.host.operations.get(sessionId)?.payload)
        ?? (runtimeSession?.claudeSessionId
          ? {
            harness: "claude-code" as const,
            id: runtimeSession.claudeSessionId,
            capturedAt: new Date().toISOString(),
            source: "launch",
          }
          : undefined);
      ctx.host.operations.patch(sessionId, { payload: toOperationPayload(ctx.host.operations.get(sessionId)?.payload, cwd, created, launchedProviderSession, observability.getDurableOperation(sessionId)?.providerTitle) });
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
      // 실패의 종류만 내보낸다. spawn 오류 메시지에는 실행 파일의 절대 경로가 실려 있어
      // 그대로 실으면 경로가 브라우저 DTO로 새어 나간다 — errno는 경로를 담지 않는다.
      ctx.host.http.writeJson(res, 503, { error: classifyLaunchSpawnFailure(error) });
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
    if (!node || node.pluginId !== ctx.pluginId || node.type !== AGENT_OPERATION_TYPE) {
      ctx.host.http.writeJson(res, 404, { error: "session_not_found" });
      return true;
    }
    const payload = node.payload;
    const cliId = CLAUDE_HARNESS_ID;
    const providerSession = readProviderSession(payload);
    // 이어붙일 좌표가 없거나 launch 좌표뿐이면 재개는 정의상 **새 시작**이고, `fresh`와 같은
    // 경로다. launch 좌표는 플러그인 수명용으로 첫 prompt 전에 심은 id일 뿐 transcript가 있는
    // provider 세션의 증거가 아니다. 이를 --resume에 넘기면 첫 턴 전 Chat → CLI 복귀가 존재하지
    // 않는 세션을 재개하려다 실패한다.
    //
    // chat 여부로는 판단할 수 없다: 캡션의 복귀 버튼은 chat 마커를 먼저 걷고 이 라우트를 부르므로
    // 이 시점의 payload에는 이미 없다. 그래서 Chat 진입의 resolveChatSeed와 같은 source 판정을 쓴다.
    const startsFresh = fresh
      || !providerSession
      || providerSession.source === "launch";
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
      if (!startsFresh) resumeProviderSession = readProviderSession(resumeNode.payload) ?? providerSession;
    }
    const result = await resumeAgentSessionCore(resumeNode, sessionId, cliId, { fresh: startsFresh, providerSession: resumeProviderSession });
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
    options: { readonly fresh: boolean; readonly providerSession: CapturedAgentSession | undefined },
  ): Promise<{ ok: true; resumed: AgentTerminalSessionInfo } | { ok: false; status: number; error: string }> {
    const { fresh, providerSession } = options;
    // launchModel 도입 전 Operation은 복원할 정확한 좌표가 없으므로 Claude Gateway에만
    // 신규 Quick Launch와 같은 native Opus 1M 기본값을 적용한다. 다른 CLI에는 넘기지 않는다.
    const launchModel = readAgentSession(node.payload)?.model
      || (cliId === "claude" ? "opus[1m]" : undefined);
    const launchEffort = readAgentSession(node.payload)?.effort || undefined;
    // cwd 해석은 상태 전이 전에 끝낸다 — 'starting'으로 올린 뒤 404로 빠지면 catch의 dormant
    // 복귀를 건너뛰어 세션이 starting에 고착된다.
    const cwd = readPayloadString(node.payload, "cwd") || ctx.host.paths.resolveTheaterPath(node.theaterId);
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
        const launchSession = readAgentSession(node.payload);
        payloadWithoutProvider.session = {
          harness: "claude-code",
          ...(launchSession?.model ? { model: launchSession.model } : {}),
          ...(launchSession?.effort ? { effort: launchSession.effort } : {}),
        };
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
        ...(fresh ? {} : { resumeSessionId: providerSession?.id }),
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
      if (!readAgentSession(resumedPayload)?.model && launchModel) {
        resumedPayload.session = {
          ...(readAgentSession(resumedPayload) ?? { harness: "claude-code" }),
          model: launchModel,
          ...(launchEffort ? { effort: launchEffort } : {}),
        };
      }
      ctx.host.operations.patch(sessionId, { payload: resumedPayload });
      return { ok: true, resumed };
    } catch (error) {
      resetOscActivity(sessionId);
      if (fresh && providerSession) {
        // 실패 롤백: spawn 전에 떼어낸 payload providerSession과 observability 세션을
        // 복원한다 — payload의 providerSession이 resume과 Analyst transcript의 단일 권위다.
        const rollbackPayload = { ...(ctx.host.operations.get(sessionId)?.payload ?? {}) };
        rollbackPayload.session = providerSession;
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
        // 자식에게는 첨부 경로가 붙은 프롬프트를, 화면에는 사람이 쓴 문면을 준다 — 예약 칩이
        // 호스트 절대 경로를 브라우저로 실어 나르지 않게 하는 경계가 이 인자 둘이다.
        chat.send(composeLaunchPromptWithAttachments(text.trim(), attachmentPaths) as string, text.trim());
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
    const cliId = CLAUDE_HARNESS_ID;
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
      ctx.host.http.writeJson(res, 409, { error: "chat_convert_busy", reason: "starting" });
      return true;
    }
    const live = terminalRuntime.getSessionLastActivityAt(sessionId) !== null;
    if (live) {
      // Phase 1은 유휴 세션만 전환한다 — 진행 중 턴·입력 대기·턴 종료 후에도 살아 있는 백그라운드
      // 작업(backgroundPending) 중의 PTY를 접으면 그 작업을 잃는다(활동축 불변식과 같은 판정).
      //
      // 사유는 뭉뚱그리지 않는다. "지금은 안 됩니다"만 돌려주면 사용자가 무엇이 끝나기를
      // 기다려야 하는지 알 수 없고, 기다림의 대상이 셋(턴·내 답·백그라운드 작업)이라 그 차이가
      // 곧 다음 행동의 차이다. 우선순위는 활동축 해석과 같게 대기를 작업보다 앞세운다.
      const busyReason = info?.attentionPending === true
        ? "awaiting"
        : (info?.turnState === "running" || info?.modelActivity === "working")
          ? "turn"
          : info?.backgroundPending === true ? "background" : null;
      if (busyReason) {
        ctx.host.http.writeJson(res, 409, { error: "chat_convert_busy", reason: busyReason });
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

  /**
   * 대기 중인 질문에 답한다.
   *
   * 기존 message 라우트를 쓰지 않는 이유는 그쪽이 **새 턴을 큐에 넣는** 자리이기 때문이다.
   * 이 답은 진행 중 턴 안으로 들어가야 하므로, 붙들려 있는 권한 응답을 푸는 별도의 문이 필요하다.
   */
  async function handleChatAnswer(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string): Promise<boolean> {
    if (req.method !== "POST") return methodNotAllowed(res);
    if (!ctx.host.security.validateHost(req) || !ctx.host.security.isTerminalAuthorized(req)) return unauthorized(res);
    const node = ctx.host.operations.get(sessionId);
    if (!node || node.pluginId !== ctx.pluginId || node.type !== AGENT_OPERATION_TYPE) {
      ctx.host.http.writeJson(res, 404, { error: "session_not_found" });
      return true;
    }
    const chat = chatRegistry.get(sessionId);
    if (!chat) {
      ctx.host.http.writeJson(res, 409, { error: "chat_not_active" });
      return true;
    }
    const body = await ctx.host.http.readJsonBody<{
      readonly askId?: unknown;
      readonly answers?: unknown;
      readonly approve?: unknown;
      readonly message?: unknown;
    }>(req);
    const askId = typeof body?.askId === "string" ? body.askId : "";
    if (askId.length === 0) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_ask_id" });
      return true;
    }
    const answers = Array.isArray(body?.answers)
      ? body.answers.filter((value): value is string => typeof value === "string")
      : undefined;
    if (Array.isArray(body?.answers) && answers?.length !== body.answers.length) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_answer" });
      return true;
    }
    const result = chat.answer(askId, {
      ...(answers ? { answers } : {}),
      ...(body?.approve === true ? { approve: true } : {}),
      ...(typeof body?.message === "string" ? { message: body.message.slice(0, MAX_CHAT_ANSWER_MESSAGE_CHARS) } : {}),
    });
    if (!result.ok) {
      // 잘린 계획의 승인 거절은 409다 — 요청이 잘못된 것이 아니라, 보여 주지 못한 것을 승인할 수
      // 없다는 세션의 상태가 거절한다. 옛 번들이 이 문을 두드렸을 때 그 구별이 화면에 도움이 된다.
      const status = result.error === "ask_not_found" ? 404 : result.error === "plan_truncated" ? 409 : 400;
      ctx.host.http.writeJson(res, status, { error: result.error });
      return true;
    }
    ctx.host.http.writeJson(res, 200, { ok: true, outcome: result.outcome });
    return true;
  }

  /**
   * 도는 턴을 사용자가 끊는다.
   *
   * 끊을 것이 없으면 409다 — 200을 돌려주면 화면이 "멈췄다"를 그리는데 실제로는 아무것도
   * 멈추지 않는다. 이 문은 턴만 닫는다: 이미 태어난 백그라운드 작업은 계속 살고, 그 사실은
   * 잡 표면이 그대로 말한다.
   */
  async function handleChatStop(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string): Promise<boolean> {
    if (req.method !== "POST") return methodNotAllowed(res);
    if (!ctx.host.security.validateHost(req) || !ctx.host.security.isTerminalAuthorized(req)) return unauthorized(res);
    const node = ctx.host.operations.get(sessionId);
    if (!node || node.pluginId !== ctx.pluginId || node.type !== AGENT_OPERATION_TYPE) {
      ctx.host.http.writeJson(res, 404, { error: "session_not_found" });
      return true;
    }
    const chat = chatRegistry.get(sessionId);
    if (!chat) {
      ctx.host.http.writeJson(res, 409, { error: "chat_not_active" });
      return true;
    }
    if (!chat.stopTurn()) {
      ctx.host.http.writeJson(res, 409, { error: "chat_idle" });
      return true;
    }
    ctx.host.http.writeJson(res, 200, { ok: true });
    return true;
  }

  /**
   * 백그라운드 작업 하나를 사용자가 멈춘다 — 터미널에서 그 셸을 kill하는 것과 같은 자리다.
   *
   * 200은 "자식이 중단 요청을 받았다"까지다. 실제 결말은 자식이 내는 `stopped` 알림이 말하며,
   * 그 알림이 원장의 잡 줄을 닫는다 — 여기서 미리 닫으면 멈추지 않은 작업을 멈췄다고 그린다.
   */
  async function handleChatJobStop(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string): Promise<boolean> {
    if (req.method !== "POST") return methodNotAllowed(res);
    if (!ctx.host.security.validateHost(req) || !ctx.host.security.isTerminalAuthorized(req)) return unauthorized(res);
    const node = ctx.host.operations.get(sessionId);
    if (!node || node.pluginId !== ctx.pluginId || node.type !== AGENT_OPERATION_TYPE) {
      ctx.host.http.writeJson(res, 404, { error: "session_not_found" });
      return true;
    }
    const chat = chatRegistry.get(sessionId);
    if (!chat) {
      ctx.host.http.writeJson(res, 409, { error: "chat_not_active" });
      return true;
    }
    const body = await ctx.host.http.readJsonBody<{ readonly jobId?: unknown }>(req);
    const jobId = typeof body?.jobId === "string" ? body.jobId : "";
    if (jobId.length === 0) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_job_id" });
      return true;
    }
    if (!await chat.stopJob(jobId)) {
      ctx.host.http.writeJson(res, 409, { error: "job_stop_unavailable" });
      return true;
    }
    ctx.host.http.writeJson(res, 200, { ok: true });
    return true;
  }

  /**
   * 잡 하나의 상세를 읽는다 — 서브에이전트의 도구 발자국, 또는 셸이 남긴 출력의 꼬리.
   *
   * 스트림에 싣지 않고 별도의 문을 두는 이유는 비용이다. 전사록과 명령 출력은 잡 하나당 수백
   * KB까지 자라고(실측 438KB), 그것을 저널에 넣으면 재접속마다 전량이 다시 흐른다. 여기서는
   * 사용자가 그 잡을 열어 본 그때만, 잘라서 한 번 읽는다.
   */
  async function handleChatJob(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string): Promise<boolean> {
    if (req.method !== "GET") return methodNotAllowed(res);
    if (!ctx.host.security.validateHost(req) || !ctx.host.security.isTerminalAuthorized(req)) return unauthorized(res);
    const node = ctx.host.operations.get(sessionId);
    if (!node || node.pluginId !== ctx.pluginId || node.type !== AGENT_OPERATION_TYPE) {
      ctx.host.http.writeJson(res, 404, { error: "session_not_found" });
      return true;
    }
    const chat = chatRegistry.get(sessionId);
    if (!chat) {
      ctx.host.http.writeJson(res, 409, { error: "chat_not_active" });
      return true;
    }
    const jobId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("jobId");
    if (jobId === null || jobId.length === 0) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_job_id" });
      return true;
    }
    const detail = await chat.readJobDetail(jobId);
    if (!detail) {
      ctx.host.http.writeJson(res, 404, { error: "job_detail_unavailable" });
      return true;
    }
    ctx.host.http.writeJson(res, 200, detail);
    return true;
  }

  /**
   * 컴포저의 `/`·`@` 덱이 세울 목록을 읽는다.
   *
   * 이 문은 자식을 **열 수 있다**. 사용자가 `/`를 친 것이 곧 "이 세션은 무엇을 할 수 있나"를
   * 묻는 행위이고, 첫 전송까지 기다리면 갓 연 채팅의 첫 덱은 반드시 비기 때문이다. 여는 비용은
   * 어차피 다음 메시지에 치를 비용을 앞당긴 것뿐이다.
   *
   * 못 읽었을 때 200에 빈 목록을 싣지 않는다 — 화면이 "이 세션엔 아무것도 없다"와 "아직 모른다"를
   * 구분해야 하고, 빈 목록은 전자만 뜻해야 한다.
   */
  async function handleChatCatalog(req: Parameters<typeof handle>[0]["req"], res: Parameters<typeof handle>[0]["res"], sessionId: string): Promise<boolean> {
    if (req.method !== "GET") return methodNotAllowed(res);
    if (!ctx.host.security.validateHost(req) || !ctx.host.security.isTerminalAuthorized(req)) return unauthorized(res);
    const node = ctx.host.operations.get(sessionId);
    if (!node || node.pluginId !== ctx.pluginId || node.type !== AGENT_OPERATION_TYPE) {
      ctx.host.http.writeJson(res, 404, { error: "session_not_found" });
      return true;
    }
    // `get`이 아니라 `ensure`다 — 이 문은 세션을 **열 수 있어야** 한다. 사용자가 `/`를 친 것이
    // 곧 능력을 묻는 행위이고, 이미 도는 세션만 답하면 갓 연 채팅의 첫 덱은 반드시 빈다.
    // 잡 상세(`chat-job`)가 `get`을 쓰는 것은 그쪽이 이미 존재하는 잡의 좌표를 받기 때문이다.
    if (node.payload[CHAT_MODE_PAYLOAD_KEY] !== true) {
      ctx.host.http.writeJson(res, 409, { error: "chat_not_active" });
      return true;
    }
    const seed = await resolveChatSeed(node);
    if (!seed.ok) {
      ctx.host.http.writeJson(res, seed.status, { error: seed.error });
      return true;
    }
    // seed 해석의 await 동안 DELETE가 chat을 접었을 수 있다 — 메시지 경로와 같은 재검증이다.
    if (ctx.host.operations.get(sessionId)?.payload[CHAT_MODE_PAYLOAD_KEY] !== true) {
      ctx.host.http.writeJson(res, 409, { error: "chat_not_active" });
      return true;
    }
    let chat;
    try {
      chat = await chatRegistry.ensure(sessionId, () => seed.seed);
    } catch {
      ctx.host.http.writeJson(res, 503, { error: "chat_unavailable" });
      return true;
    }
    const catalog = await chat.readCatalog();
    if (!catalog) {
      ctx.host.http.writeJson(res, 409, { error: "chat_catalog_unavailable" });
      return true;
    }
    ctx.host.http.writeJson(res, 200, catalog);
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
    ctx.host.http.writeJson(res, 410, { error: "chat_stream_moved" });
    return true;
  }

  type ChatSeedResolution =
    | { readonly ok: true; readonly seed: AgentChatSessionSeed }
    | { readonly ok: false; readonly status: number; readonly error: string };

  async function resolveChatSeed(node: OperationNode): Promise<ChatSeedResolution> {
    if (!readAgentSession(node.payload)) {
      return { ok: false, status: 409, error: "chat_unsupported" };
    }
    const providerSession = readProviderSession(node.payload);
    const transcriptPath = providerSession?.transcriptPath
      ? await resolveTranscriptPath(providerSession.transcriptPath, node.ts.createdAt)
      : null;
    // transcript 부재는 두 가지 뜻일 수 있고, 그것을 가르는 것은 태생이 아니라 **좌표가 한 번
    // 이라도 심겼는지**다.
    //
    // 첫 턴 전에도 launch resolver가 플러그인 트리 회수를 위해 세션 id를 미리 심는다. 그 좌표는
    // source:"launch"이고 아직 transcript를 만들었다는 증거가 아니다 — 사용자가 아무 말도 하지 않은
    // 채 터미널에서 Chat으로 넘어오는 정상 경로가 정확히 이 상태다.
    //
    // UserPromptSubmit capture가 한 번 지나면 source가 실제 hook 값으로 바뀌고 transcript 경로도
    // 알려진다. 그 뒤 파일이 사라진 경우에만 과거의 상실이다. 이때 fresh로 떨어뜨리면 지워진
    // 트랜스크립트가 조용히 무관한 새 세션으로 바뀌고 이전 정체성을 덮어쓰므로 거절한다.
    const neverStarted = !providerSession || providerSession.source === "launch";
    if (!transcriptPath && !neverStarted) return { ok: false, status: 409, error: "chat_transcript_missing" };
    const sessionOrigin: AgentChatSessionOrigin = transcriptPath
      ? { kind: "resume", transcriptPath }
      : { kind: "fresh" };
    const origin = ctx.host.server.origin();
    if (!origin) return { ok: false, status: 503, error: "chat_gateway_unavailable" };
    const cwd = readPayloadString(node.payload, "cwd") || ctx.host.paths.resolveTheaterPath(node.theaterId);
    if (!cwd) return { ok: false, status: 404, error: "theater_not_found" };
    // resume core와 같은 좌표 정책: launchModel이 없던 구세대 Operation은 native Opus 1M로 계속된다.
    const model = readAgentSession(node.payload)?.model || "opus[1m]";
    const launchEffort = resolveChatLaunchEffort(readAgentSession(node.payload)?.effort ?? "");
    // Chat Mode는 표면만 다른 같은 Operation이다 — 터미널에서 열었을 때 CLI가 받는 것과 같은
    // doctrine, 같은 Fleet 도구를 받아야 한다. 프롬프트 모드도 PTY 경로와 같은 전역 설정을 읽는다.
    const claudeConfigDir = resolveClaudeConfigDir();
    const gatewayBaseUrl = resolveAnalysisGatewayBaseUrl(origin);
    // 공유 홈의 discovery 캐시는 호스트 소유다 — SDK 쪽은 이 홈에 쓰지 않으므로 여기서 세운다.
    // 노출 목록 전체를 쓰는 이유는 같은 홈을 PTY 자식이 함께 읽기 때문이다.
    try {
      const gatewaySelection = deps.readAiGatewaySettings
        ? resolveAiGatewaySelection(deps.readAiGatewaySettings())
        : undefined;
      writeGatewayModelCacheForHome({
        baseUrl: gatewayBaseUrl,
        configDir: claudeConfigDir,
        ...(gatewaySelection ? { models: gatewaySelection.models } : {}),
      });
    } catch {
      // 캐시를 세우지 못해도 네이티브 모델 세션은 뜬다. 게이트웨이 별칭 세션만 첫 턴에 드러난다.
    }
    // 카탈로그가 이 좌표의 실제 창을 아는 유일한 자리다. 게이트웨이가 usage를 투영할 때 읽는
    // 것과 같은 조회이므로 두 쪽이 같은 수를 쓴다.
    const gatewayModel = findGatewayModel(model);
    const gatewayContextWindow = typeof gatewayModel?.contextWindow === "number"
      && Number.isFinite(gatewayModel.contextWindow)
      && gatewayModel.contextWindow > 0
      ? gatewayModel.contextWindow
      : undefined;
    const gatewayCompactCeiling = gatewayContextWindow === undefined
      ? undefined
      : (deps.readAiGatewaySettings?.().compactCeiling ?? null);
    // 터미널 런치와 같은 설정을 읽는다. 이 값이 두 표면에서 어떤 인자·옵션이 되는지는
    // admiral이 정한다 — CLI는 끌 때만 플래그를 싣고 SDK는 켤 때만 preset을 싣는, 서로 뒤집힌
    // 표현이라 호스트가 각자 사상하면 한쪽만 따라온다.
    const chatClaudeCodeSystemPrompt = resolveClaudeCodeSystemPrompt(deps.globalOptionsService.load());
    const mcpTokenLabel = `chat:${node.id}`;
    return {
      ok: true,
      seed: {
        baseUrl: gatewayBaseUrl,
        compactHookToken: deps.aiGateway?.compactHookToken,
        model,
        // 자식은 창이 500k인 모델도 자기 200k 좌표로 재고, 그 좌표를 물어보는 모든 표면에 그대로
        // 말한다. 실제 창과 투영에 쓰인 압축 정책을 함께 실어야 세션이 그것을 되돌릴 수 있다.
        // 네이티브 Claude 모델은 카탈로그에 없으므로 두 값 없이 지나가고 오늘의 숫자를 유지한다.
        ...(gatewayContextWindow === undefined ? {} : { contextWindow: gatewayContextWindow }),
        ...(gatewayCompactCeiling === undefined ? {} : { compactCeiling: gatewayCompactCeiling }),
        ...(launchEffort ? { effort: launchEffort.effort } : {}),
        cwd,
        claudeConfigDir,
        origin: sessionOrigin,
        resolveFleetMcpServers: async () => {
          const endpoint = await runtime.dedicatedMcpSession.getEndpoint();
          const tokens = await runtime.dedicatedMcpSession.issueSessionToken({
            cwd,
            // PTY 주입과 같은 필터다. 이 세션에 허용된 호스트 도구만 실린다.
            includeTool: (toolId) => isHostSessionToolAllowed(toolId),
            label: mcpTokenLabel,
          });
          return endpoint.servers.map((server) => {
            const token = tokens.find((entry) => entry.name === server.name)?.token;
            if (!token) throw new Error(`Dedicated MCP token missing for ${server.name}`);
            return {
              name: server.name,
              url: server.url,
              headers: [{ name: "Authorization", value: `Bearer ${token}` }],
            };
          });
        },
        releaseFleetMcpServers: () => runtime.dedicatedMcpSession.releaseSessionToken(mcpTokenLabel),
        ...(launchEffort?.ultracode ? { ultracode: true } : {}),
        // 터미널 런치와 같은 함수에서 같은 옵션으로 받는다 — 두 표면이 한 세션의 두 얼굴이다.
        // 새로 태어나는 세션은 Operation id를 그대로 Claude 세션 id로 못박아, Operation의
        // 좌표와 Claude의 좌표가 태어날 때 하나가 된다. 이어 붙이는 세션은 그 id를 고를 수
        // 없으므로 트랜스크립트가 말하는 id를 그대로 쓴다.
        resolveClaudeSession: () => prepareChatClaudeSession({
          cwd,
          dataDir: ctx.host.paths.fleetDataDir,
          claudeCodeSystemPrompt: chatClaudeCodeSystemPrompt,
          origin: sessionOrigin.kind === "resume"
            ? { kind: "resume", sessionId: path.basename(sessionOrigin.transcriptPath, ".jsonl") }
            : { kind: "new", preferredSessionId: node.id },
          ...(deps.readAiGatewaySettings ? { readAiGatewaySettings: deps.readAiGatewaySettings } : {}),
        }),
        onProviderSessionUpdate: (updated) => {
          const operation = ctx.host.operations.get(node.id);
          if (operation) ctx.host.operations.patch(node.id, { payload: { ...operation.payload, session: mergeCapturedAgentSession(operation.payload, updated) } });
          observability.updateTerminalSessionProviderSession(node.id, updated);
        },
        canReportActivity: () => observability.getTerminalSessionInfo(node.id)?.chatActive === true,
        // 채팅 턴의 끝은 Stop hook 대신 세션이 직접 알린다 — 세션 관찰이 두 얼굴 모두에서 돈다.
        onTurnEnded: () => deps.onTurnEnded?.(node.id),
        reportActivity: (working) => {
          const updated = observability.setTerminalSessionChatWorking(node.id, working);
          // null은 이 세션이 채팅으로 인수되지 않았다는 뜻이다 — 축이 이 보고를 받을 자리가 없다.
          if (!updated) return false;
          observability.notifySessionUpdated(updated);
          return true;
        },
        reportAwaiting: (awaiting) => {
          const updated = observability.setTerminalSessionChatAwaiting(node.id, awaiting);
          if (updated) observability.notifySessionUpdated(updated);
        },
        reportBackgroundPending: (pending) => {
          // 같은 값인지는 축을 가진 쪽이 판단한다 — 세션이 따로 기억해 두면 표면이 바뀌며 비워진 축을
          // 모른 채 다음 보고를 삼킨다. 대신 여기서 이전 값을 읽어, 실제로 달라졌을 때만 방송한다.
          const before = observability.getTerminalSessionInfo(node.id)?.backgroundPending === true;
          // null은 축이 이 세션의 것이 아니라는 뜻이다 — 세션 정리와 보고가 경합해도 이미 다른
          // 소유자가 채우는 같은 필드를 덮지 않게 setter가 막는다.
          const updated = observability.setTerminalSessionChatBackgroundPending(node.id, pending);
          if (updated && before !== pending) observability.notifySessionUpdated(updated);
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
    if (turnState === "ended") {
      scheduleIdentityRefresh(sessionId);
      deps.onTurnEnded?.(sessionId);
    }
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
        ctx.host.operations.patch(sessionId, { payload: { ...operation.payload, session: mergeCapturedAgentSession(operation.payload, providerSession) } });
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
    const cliId = operation ? CLAUDE_HARNESS_ID : undefined;
    const providerSession = readProviderSession(operation?.payload)?.id;
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
        ctx.host.operations.patch(operationId, {
          payload: {
            ...toOperationPayload(ctx.host.operations.get(operationId)?.payload, exitCwd, dormant, providerSession, observability.getDurableOperation(operationId)?.providerTitle),
            restoredDormant: true,
          },
        });
      }
    } else if (ctx.host.operations.get(operationId)?.payload[CHAT_MODE_PAYLOAD_KEY] === true) {
      // 채팅이 인수한 세션의 PTY 종료는 재개 불가 종료가 아니라 **표면 전환**이다. 첫 턴 전에
      // 넘어왔다면 좌표가 아직 없을 뿐이고, 여기서 아래 정리로 떨어뜨리면 방금 전환한 Operation이
      // 그 자리에서 사라진다 — 스트림은 session_not_found를 받고 터미널로 돌아갈 곳도 없어진다.
      //
      // 관측 세션은 지우지 않고 dormant로 세운다. 지우면 활동축이 사라져 첫 메시지가 보고할
      // 자리를 잃고 chat_activity_unavailable로 거절된다.
      const parked = observability.updateTerminalSessionStatus(operationId, "dormant");
      if (parked) {
        terminalRuntime.invalidateTicketsForSession(operationId);
        observability.notifySessionUpdated(parked);
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
    void chatRegistry.dispose(sessionId).catch(() => undefined);
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
    const providerSessionId = readProviderSession(operation?.payload)?.id;
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
        if (!title || !current || readProviderSession(current.payload)?.id !== providerSessionId) return;
        const applied = observability.applyTerminalSessionProviderIdentity(sessionId, title);
        if (!applied?.renamed) return;
        observability.notifySessionUpdated(applied.session);
        const operation = ctx.host.operations.get(sessionId);
        if (!operation || readProviderSession(operation.payload)?.id !== providerSessionId) return;
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
    const cwd = readPayloadString(operation.payload, "cwd") || (ctx.host.paths.resolveTheaterPath(operation.theaterId) ?? "");
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
      createdAt: operation.ts.createdAt,
      ...(readProviderSession(operation.payload) ? { session: readProviderSession(operation.payload)! } : {}),
    });
  }

  function rehydrateDormantAgentOperations(): void {
    for (const operation of ctx.host.operations.list()) {
      if (operation.pluginId !== ctx.pluginId || operation.type !== AGENT_OPERATION_TYPE) continue;
      const providerSession = readProviderSession(operation.payload);
      // 채팅 표면에 있는 Operation은 첫 턴 전에는 providerSession이 없다 — 채팅으로 태어났든
      // 첫 턴 전에 터미널에서 넘어왔든 마찬가지다. 여기서 걸러 내면 그 Operation은 관측 세션
      // 없이 남아 활동 보고를 받을 자리가 사라지고, 첫 메시지가 chat_activity_unavailable로
      // 거절된다(영영 시작하지 못하는 패널).
      const onChatSurface = operation.payload[CHAT_BORN_PAYLOAD_KEY] === true
        || operation.payload[CHAT_MODE_PAYLOAD_KEY] === true;
      if (observability.getTerminalSessionInfo(operation.id)) continue;
      if (!providerSession && !onChatSurface) {
        ctx.host.operations.patch(operation.id, { payload: { ...operation.payload, restoredDormant: true } });
        continue;
      }
      const dormant = injectOperation(operation);
      // 채팅이 인수한 Operation은 재시작을 건너서도 채팅이 인수한 상태다 — 마커는 payload에 남아
      // 있고 패널도 채팅 뷰로 복원되므로, 여기서 축을 되세우지 않으면 화면은 채팅을 띄운 채
      // 사이드바만 휴면이라고 말한다(이 결함의 재시작 판).
      if (operation.payload[CHAT_MODE_PAYLOAD_KEY] === true) {
        const adopted = observability.setTerminalSessionChatActive(operation.id, true);
        if (adopted) observability.notifySessionUpdated(adopted);
      }
      const cwd = readPayloadString(operation.payload, "cwd") || (ctx.host.paths.resolveTheaterPath(operation.theaterId) ?? "");
      ctx.host.operations.patch(operation.id, {
        payload: {
          ...toOperationPayload(operation.payload, cwd, dormant, providerSession, observability.getDurableOperation(operation.id)?.providerTitle),
          restoredDormant: true,
        },
      });
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

function toOperationPayload(existing: Record<string, unknown> | undefined, cwd: string, runtimeSession: AgentTerminalSessionInfo, capturedSession?: CapturedAgentSession | AnalysisProviderSession, providerTitle?: AgentProviderTitleMarker): Record<string, unknown> {
  const payload = { ...(existing ?? {}) };
  for (const key of ["cwd", "cliId", "launchKindId", "cliLabel", "launchProvider", "launchModel", "launchEffort", "providerSession", "labelSource", "providerTitle", "restoredDormant"]) {
    delete payload[key];
  }
  const session = capturedSession
    ? capturedSession.harness === "codex"
      ? capturedSession
      : mergeCapturedAgentSession(existing, capturedSession)
    : readAgentSession(existing);
  return {
    ...payload,
    cwd,
    ...(session ? { session } : {}),
    ...(runtimeSession.labelSource ? { labelSource: runtimeSession.labelSource } : {}),
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

function parseCaptureHookInput(provider: string, input: string): CapturedAgentSession | undefined {
  try {
    if (provider !== "claude") throw new Error("invalid_provider");
    const parsed = JSON.parse(input) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid_hook_input");
    const candidate = parsed as { readonly session_id?: unknown; readonly transcript_path?: unknown; readonly source?: unknown };
    if (typeof candidate.session_id !== "string" || candidate.session_id.length === 0) throw new Error("missing_provider_session_id");
    return {
      harness: "claude-code",
      id: candidate.session_id,
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


/**
 * spawn 실패를 브라우저가 문장으로 옮길 수 있는 코드로 분류한다.
 *
 * 원본 메시지를 그대로 실으면 실행 파일의 절대 경로가 따라 나가므로 errno만 읽는다.
 * 분류되지 않는 실패는 예전과 같은 `terminal_unavailable`로 남는다 — 새 어휘를 추측으로
 * 넓히면 화면이 사실이 아닌 원인을 말하게 된다.
 */
function classifyLaunchSpawnFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "agent_cli_binary_missing";
  if (code === "EACCES" || code === "EPERM") return "agent_cli_not_executable";
  return "terminal_unavailable";
}

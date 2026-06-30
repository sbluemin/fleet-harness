import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";

import { createCarrierResultReminderRouter, createFleetAgentRuntimeLifecycle, formatCarrierResultReminderMessage, getAgentCliMetadata, parseAgentCliId, sanitizeCarrierResultReminder, type AgentCliId } from "@dotobokuri/fleet-admiral";
import type { GlobalOptionsService } from "@dotobokuri/fleet-infra";
import { resolveAuthEnv, type AuthService } from "@dotobokuri/fleet-infra/auth";
import { getWikiToolSpecs } from "@dotobokuri/fleet-wiki";
import type { OperationLaunchKind, OperationNode } from "@fleet-console/sdk/operations";
import { registerRouter } from "@fleet-console/sdk/plugin/node";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { createWorkspaceChangeScanner } from "./shared/index.js";
import type { TerminalRuntime } from "./shared/index.js";

import { createDefaultAgentCliDetector } from "./agent-api/agent-cli-detect.js";
import { combineAgentCliLaunchMetadata, type AgentCliLaunchMetadata } from "./agent-api/agent-cli-launch-metadata.js";
import { deriveOperationLabel } from "./agent-api/auto-name.js";
import { normalizeAttentionReason } from "./agent-api/attention-hook.js";
import { captureSession, readProviderSessionCapture, unlinkProviderSessionCapture, type ProviderSession } from "./agent-api/session-capture.js";
import { createAgentTerminalLaunchResolver, type ConsoleRuntimeSessionInfo } from "./agent-api/launch.js";
import { createConsoleObservabilityStore } from "./agent-api/observability-store.js";
import { writeAggregateObserverEvents } from "./agent-api/observability-routes.js";
import type { AgentTerminalSessionInfo, AgentLabelSource } from "./agent-api/types.js";
import { buildModelAuthState } from "./model-auth-state.js";

type SessionCreateBody = { readonly cliId?: unknown; readonly theaterId?: unknown };
type SessionPatchBody = { readonly label?: unknown };
type HookTurnBody = { readonly phase?: unknown };
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
  readonly authService: AuthService;
  readonly globalOptionsService: GlobalOptionsService;
}

const AGENT_OPERATION_TYPE = "agent";
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

function createAgentApi(ctx: FleetPluginServerContext, terminalRuntime: TerminalRuntime, deps: AgentRouteDeps) {
  const dataDir = ctx.host.paths.dataDir;
  const authEnvResolver = (cli: Parameters<typeof resolveAuthEnv>[0]) => resolveAuthEnv(cli, { authService: deps.authService });
  const runtime = createFleetAgentRuntimeLifecycle({
    authEnvResolver,
    dataDir,
    onMcpServerStartError: (error) => {
      console.error("[fleet-console] Failed to start MCP server", error);
    },
    workspaceChangeScanner: createWorkspaceChangeScanner(),
    wikiToolSpecs: getWikiToolSpecs(),
  });
  const observability = createConsoleObservabilityStore({
    canonicalizeTheaterPath: ctx.host.paths.canonicalizeTheaterPath,
    workspaceHash: ctx.host.paths.workspaceHash,
  });
  const detector = createDefaultAgentCliDetector();
  const pendingRuntimeSessions = new Map<string, ConsoleRuntimeSessionInfo>();
  const jobOriginById = new Map<string, string>();
  const launchResolver = createAgentTerminalLaunchResolver({
    agentRuntime: runtime,
    dataDir,
    infraServices: deps,
    onRuntimeSessionStart: (session) => {
      pendingRuntimeSessions.set(session.sessionId, session);
    },
  });
  const unsubscribeStream = runtime.carrierRuntime.jobs.streaming.register((event) => {
    const sessionId = resolveCarrierEventOrigin(event as { readonly jobId: string; readonly type: string; readonly originSessionId?: string }, jobOriginById);
    if (!sessionId) return;
    observability.appendTerminalRuntimeEvent(sessionId, event);
  });
  const unsubscribeReminder = createCarrierResultReminderRouter({
    streamRegister: runtime.carrierRuntime.jobs.streaming.register,
    resolveSink: (event) => {
      const sessionId = resolveCarrierEventOrigin(event as { readonly jobId: string; readonly type: string; readonly originSessionId?: string }, jobOriginById);
      return sessionId ? { write: (data) => terminalRuntime.write(sessionId, data) } : undefined;
    },
    resolvePolicy: (event) => {
      const sessionId = resolveCarrierEventOrigin(event as { readonly jobId: string; readonly type: string; readonly originSessionId?: string }, jobOriginById);
      return sessionId ? terminalRuntime.getMessagePolicy(sessionId) ?? {} : {};
    },
  });
  const unsubscribeRename = ctx.host.events.subscribe(OPERATION_RENAMED_EVENT_CHANNEL, (payload) => {
    if (!isOperationRenamedEvent(payload)) return;
    if (payload.pluginId !== TERMINAL_PLUGIN_ID || payload.type !== AGENT_OPERATION_TYPE) return;
    injectRenameCommand(payload.operationId, payload.title);
  });
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
    if (req.method === "PATCH") {
      const body = await ctx.host.http.readJsonBody<SessionPatchBody>(req);
      if (!body || (body.label !== undefined && typeof body.label !== "string")) {
        ctx.host.http.writeJson(res, 400, { error: "invalid_session_label" });
        return true;
      }
      const updated = observability.renameTerminalSession(sessionId, body.label ?? "");
      if (!updated) {
        ctx.host.http.writeJson(res, 404, { error: "session_not_found" });
        return true;
      }
      observability.notifySessionUpdated(updated);
      const renamedCwd = readPayloadString(ctx.host.operations.get(sessionId)?.payload ?? {}, "cwd") ?? updated.cwdLabel;
      ctx.host.operations.patch(sessionId, { title: updated.label ?? path.basename(renamedCwd) });
      injectRenameCommand(sessionId, updated.label);
      ctx.host.http.writeJson(res, 200, updated);
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
      payload: toOperationPayload(cwd, session),
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
      ctx.host.operations.patch(sessionId, { payload: toOperationPayload(cwd, created) });
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
      ctx.host.operations.patch(sessionId, { payload: toOperationPayload(cwd, resumed, providerSession) });
      ctx.host.http.writeJson(res, 200, resumed);
    } catch {
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
    const [detected, modelAuth] = await Promise.all([
      detector.detect(),
      buildModelAuthState(deps.authService),
    ]);
    return combineAgentCliLaunchMetadata(metadata, detected, modelAuth.providers);
  }

  async function buildLaunchKinds(): Promise<readonly OperationLaunchKind[]> {
    const metadata = await buildAgentCliLaunchMetadata();
    return metadata.map((cli) => {
      const disabled = !cli.available || !cli.signedIn;
      return {
        id: cli.id,
        type: AGENT_OPERATION_TYPE,
        title: cli.label,
        ...(disabled ? { disabled: true, disabledReason: !cli.available ? "Not installed" : "Sign in required" } : {}),
      };
    });
  }

  function launch(cwd: string | undefined, context: { readonly operationId?: string } | undefined) {
    const operationId = context?.operationId ?? "";
    const operation = ctx.host.operations.get(operationId);
    const cliId = typeof operation?.payload.cliId === "string" ? operation.payload.cliId : undefined;
    const providerSession = readProviderSession(operation?.payload)?.sessionId;
    return launchResolver(cwd, { sessionId: operationId, operationId, operationType: AGENT_OPERATION_TYPE, pluginId: ctx.pluginId, cliId, resumeSessionId: providerSession });
  }

  async function handleExit(operationId: string): Promise<void> {
    pendingRuntimeSessions.delete(operationId);
    const providerSession = readProviderSessionCapture(operationId, { capturesDir: ctx.host.paths.capturesDir }) ?? readProviderSession(ctx.host.operations.get(operationId)?.payload);
    if (providerSession) {
      observability.updateTerminalSessionProviderSession(operationId, providerSession);
      const dormant = observability.transitionTerminalSessionToDormant(operationId, providerSession);
      if (dormant) {
        observability.notifySessionUpdated(dormant);
        const exitCwd = readPayloadString(ctx.host.operations.get(operationId)?.payload ?? {}, "cwd") ?? "";
        ctx.host.operations.patch(operationId, { payload: toOperationPayload(exitCwd, dormant, providerSession) });
      }
    } else {
      observability.removeTerminalSession(operationId);
      ctx.host.operations.delete(operationId);
    }
  }

  function removeSession(sessionId: string): void {
    terminalRuntime.terminate(sessionId);
    pendingRuntimeSessions.delete(sessionId);
    observability.removeTerminalSession(sessionId);
    ctx.host.operations.delete(sessionId);
    unlinkProviderSessionCapture(sessionId, { capturesDir: ctx.host.paths.capturesDir });
  }

  async function cleanup(): Promise<void> {
    unsubscribeRename();
    unsubscribeReminder();
    unsubscribeStream();
    await runtime.cleanup();
  }

  function injectRenameCommand(sessionId: string, label: string | undefined): void {
    if (!label) return;
    const renameCommand = terminalRuntime.getRenameCommand(sessionId);
    if (!renameCommand) return;
    const safeLabel = sanitizeCarrierResultReminder(label.replace(/[\r\n\t]+/g, " ")).trim();
    if (safeLabel.length === 0) return;
    const policy = terminalRuntime.getMessagePolicy(sessionId) ?? {};
    for (const chunk of formatCarrierResultReminderMessage(policy, `${renameCommand} ${safeLabel}`)) {
      terminalRuntime.write(sessionId, chunk);
    }
  }

  function injectOperation(operation: OperationNode): AgentTerminalSessionInfo {
    const cwd = readPayloadString(operation.payload, "cwd") ?? ctx.host.paths.resolveTheaterPath(operation.theaterId) ?? "";
    return observability.injectDormantOperation({
      sessionId: operation.id,
      theaterId: operation.theaterId,
      cwd,
      ...(readPayloadString(operation.payload, "labelSource") ? { label: operation.title, labelSource: readPayloadString(operation.payload, "labelSource") as AgentLabelSource } : {}),
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
      ctx.host.operations.patch(operation.id, { payload: { ...operation.payload, ...toOperationPayload(cwd, dormant, providerSession) } });
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

function toOperationPayload(cwd: string, session: AgentTerminalSessionInfo, providerSession?: ProviderSession): Record<string, unknown> {
  return {
    cwd,
    ...(session.cliId ? { cliId: session.cliId } : {}),
    ...(session.cliLabel ? { cliLabel: session.cliLabel } : {}),
    ...(providerSession ? { providerSession } : {}),
    ...(session.labelSource ? { labelSource: session.labelSource } : {}),
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

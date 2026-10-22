import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { claudeGatewayModelPolicy } from "@fleet-console/ai-gateway";
import { createClaudeExecutionEventDecoder, type ClaudeGatewayInput, type ClaudeGatewayServedMcpServer } from "@fleet-console/agent-runtime/claude";
import type { AgentInput, AgentEvent } from "@fleet-console/sdk/agent";
import type { PluginMcpTool } from "@fleet-console/sdk/mcp";
import type { AgentSessionHostDeps, InternalAgentSession, InternalSessionOptions } from "../agent/agent-session.js";
import { stripConsoleInternalEnv } from "../terminal/launch-env.js";
import type { HostedToolGroup, SessionCheckpoint } from "./contracts.js";
import { createHostedSdk } from "./sdk-proxy.js";

export function hostedPluginPrefix(owner: string, logical: string): string {
  return `plugin:${createHash("sha256").update(`${owner}:${logical}`).digest("hex").slice(0, 40)}:`;
}

/** General plugin sessions use a live key, never provider resume or a persisted transcript. */
export async function createHostedPluginSession(deps: AgentSessionHostDeps, options: InternalSessionOptions, resources?: { cwd: string; scratch: string; resident: boolean; autoCompactWindow?: number; release(): Promise<void> }): Promise<InternalAgentSession> {
  const execution = deps.hostedExecution!;
  if (!deps.pluginId) throw new Error("agent_owner_missing");
  if (options.liveKey !== undefined && !/^[A-Za-z0-9:_-]{1,128}$/.test(options.liveKey)) throw new Error("agent_live_key_invalid");
  const logical = options.liveKey ?? randomUUID();
  const prefix = hostedPluginPrefix(deps.pluginId, logical);
  const candidates = execution.inventory().filter((s) => s.sessionKey.startsWith(prefix) && s.state === "live");
  if (candidates.length > 1) throw new Error("agent_live_key_ambiguous");
  const previous = candidates[0];
  const key = previous?.sessionKey ?? `${prefix}${randomUUID()}`;
  const descriptor = previous ? await execution.describe(key) : null;
  if (descriptor && descriptor.kind !== "sdk") throw new Error("agent_live_kind_invalid");
  if (descriptor && resources) await resources.release();
  const scratch = descriptor?.kind === "sdk" ? (descriptor.sdk.tempRoot ?? (descriptor.sdk.home && "configDir" in descriptor.sdk.home ? path.dirname(descriptor.sdk.home.configDir!) : undefined)) : resources?.scratch;
  const ownedScratch = scratch ?? await fs.mkdtemp(path.join(tmpdir(), "fleet-hosted-agent-"));
  const cwd = descriptor?.kind === "sdk" ? descriptor.request.cwd! : resources?.cwd ?? ownedScratch;
  const releaseResources = descriptor || !resources ? () => fs.rm(ownedScratch, { recursive: true, force: true }) : () => resources.release();
  let closed = false;
  let active = previous?.runtime.turnOpen === true;
  const lifetime = new AbortController();
  let turnController = new AbortController();
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") return value.split(cwd).join("[workspace]");
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
    return value;
  };
  const groups: HostedToolGroup[] = [];
  const unbind: (() => void)[] = [];
  const cleanup: (() => void | Promise<void>)[] = [];
  const served: ClaudeGatewayServedMcpServer[] = [];
  const extraAllowed: string[] = [];
  let oneshotFinished = false;
  let successor: InternalAgentSession | undefined;
  let successorFlight: Promise<InternalAgentSession> | undefined;
  const steered = new Map<string, string>();
  let pendingResult: Extract<AgentEvent, { kind: "result" }> | null = null;
  let turnDeadline: number | null = null;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let watchdogClosing = false;
  let consoleConnection: ReturnType<AgentSessionHostDeps["consoleUse"]["connect"]> | undefined;
  let computerConnection: ReturnType<NonNullable<AgentSessionHostDeps["computerUseMcp"]>["connectPlugin"]> | undefined;
  let browserConnection: ReturnType<NonNullable<AgentSessionHostDeps["browserMcp"]>["connectPlugin"]> | undefined;
  const bind = (name: string, tools: readonly PluginMcpTool[]) => {
    const port = `${key}:custom:${name}`;
    const validators = new Map(tools.map((tool) => [tool.name, z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0])]));
    unbind.push(execution.bind(port, async (call) => {
      if (closed || !active || lifetime.signal.aborted || call.sessionKey !== key) throw new Error("agent_tool_session_unavailable");
      const body = call.body as { server: string; tool: string; args: Record<string, unknown> };
      const tool = tools.find((tool) => tool.name === body.tool);
      const parsed = validators.get(body.tool)?.safeParse(body.args);
      if (body.server !== name || !tool || !parsed?.success) throw new Error("agent_tool_arguments_invalid");
      return tool.execute(parsed.data as Record<string, unknown>, { cwd, signal: AbortSignal.any([lifetime.signal, turnController.signal]), toolCallId: call.requestId });
    }));
    groups.push({ name, port, tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  };
  let removeFlush = () => {};
  try {
  for (const group of options.tools?.custom ?? []) bind(group.name, group.tools);
  if (options.tools?.consoleUse) {
    const policy = options.tools.consoleUse;
    consoleConnection = deps.consoleUse.connect({ ...policy, enabled: () => !closed && active && policy.enabled?.() !== false });
    cleanup.push(() => consoleConnection!.dispose());
    extraAllowed.push(...(consoleConnection.toolNames?.() ?? policy.tools ?? []).map((name) => `mcp__fleet-console-use__${name}`));
    const endpoints = await consoleConnection.getEndpoint();
    const tokens = await consoleConnection.issueSessionToken({ cwd, label: key });
    for (const token of tokens) {
      const endpoint = endpoints.servers.find((server) => server.name === token.name);
      if (!endpoint) throw new Error("agent_console_endpoint_missing");
      served.push({ name: token.name, url: endpoint.url, headers: [{ name: "Authorization", value: `Bearer ${token.token}` }] });
    }
  }
  if (options.tools?.computerUse && deps.computerUseMcp) {
    const policy = options.tools.computerUse;
    computerConnection = deps.computerUseMcp.connectPlugin({ ...policy, enabled: () => !closed && active && policy.enabled() });
    if (computerConnection) {
      if (!computerConnection.businessTools) throw new Error("agent_computer_business_port_missing");
      bind("fleet-computer-use", computerConnection.businessTools);
      cleanup.push(() => computerConnection!.dispose());
    }
  }
  if (options.tools?.browser) {
    if (!deps.browserMcp) throw new Error("agent_browser_unavailable");
    browserConnection = deps.browserMcp.connectPlugin({ scopeId: options.tools.browser.scopeId, enabled: () => !closed && active });
    if (!browserConnection.businessTools) throw new Error("agent_browser_business_port_missing");
    bind("fleet-browser", browserConnection.businessTools);
    cleanup.push(() => browserConnection!.dispose());
  }
  const checkpoint = previous?.checkpoint as SessionCheckpoint | null | undefined;
  let cursor = checkpoint?.lastConsumedSeq ?? 0;
  if (checkpoint) {
    const state = checkpoint.state as { schema?: number; active?: boolean; turnDeadline?: number | null; orchestration?: unknown; steered?: [string, string][]; pendingResult?: Extract<AgentEvent, { kind: "result" }> | null };
    if (state?.schema !== 1) throw new Error("agent_live_checkpoint_incompatible");
    if (state.orchestration !== undefined) options.orchestration?.restore(state.orchestration);
    for (const [messageId, id] of state.steered ?? []) steered.set(messageId, id);
    pendingResult = state.pendingResult ?? null;
    if (state.active === true) active = true;
    turnDeadline = state.turnDeadline ?? null;
  }
  const decoder = createClaudeExecutionEventDecoder();
  let resolveTurn: (() => void) | undefined;
  let rejectTurn: ((error: Error) => void) | undefined;
  let turn: Promise<void> = active ? new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; }) : Promise.resolve();
  void turn.catch(() => {});
  const flush = async (requireAdmission = false) => {
    const snapshot = await execution.refresh(key);
    if (requireAdmission && active && snapshot.runtime.turnOpen !== true && !(snapshot.runtime.pendingInputs as unknown[] | undefined)?.length) throw new Error("agent_input_admission_pending");
    if (requireAdmission) for (const messageId of steered.keys()) if (!snapshot.commands.some((record) => record.commandId === messageId)) throw new Error("agent_steer_admission_pending");
    await execution.checkpoint(key, { lastConsumedSeq: cursor, activeCommandId: typeof snapshot.runtime.activeCommandId === "string" ? snapshot.runtime.activeCommandId : null, pendingInputs: Array.isArray(snapshot.runtime.pendingInputs) ? snapshot.runtime.pendingInputs : [], pendingAsks: [], jobs: Array.isArray(snapshot.runtime.jobs) ? snapshot.runtime.jobs : [], queuedWakes: [], state: { schema: 1, active, turnDeadline, steered: [...steered], pendingResult, orchestration: options.orchestration?.capture() } });
  };
  removeFlush = execution.beforeUpdate(() => flush(true));
  const env = stripConsoleInternalEnv(execution.environment); delete env.FLEET_CONSOLE_SESSION_ID;
  const executablePath = await deps.resolveExecutablePath?.();
  const sdk = createHostedSdk(execution, { baseUrl: deps.baseUrl()!, modelPolicy: claudeGatewayModelPolicy, models: [options.model], env, ...(resources?.resident ? { home: { kind: "persistent", configDir: path.join(ownedScratch, "claude") } } : { tempRoot: ownedScratch }), ...(resources?.autoCompactWindow ? { autoCompactWindow: resources.autoCompactWindow } : {}), ...(executablePath ? { executablePath } : {}) }, { key, launchFingerprint: options.launchFingerprint, tools: groups, observer: { afterSeq: cursor, consumed: async (event) => { cursor = event.seq; await flush(); }, gap: () => { throw new Error("agent_live_replay_gap"); } } });
  const builtins = options.tools?.builtins ?? [];
  const session = await sdk.openSession({ model: options.model, ...(options.effort ? { effort: options.effort } : {}), systemPrompt: { mode: "replace", text: options.systemPrompt }, cwd, sessionName: options.sessionName, tools: builtins, allowedTools: [...builtins, ...extraAllowed, ...groups.flatMap((group) => group.tools.map((tool) => `mcp__${group.name}__${tool.name}`))], servedMcpServers: served, permissionMode: "dontAsk", includePartialMessages: true, maxTurns: options.maxTurns, maxBudgetUsd: options.maxBudgetUsd });
  const scheduleWatchdog = () => {
    clearTimeout(watchdog);
    if (turnDeadline === null) return;
    watchdog = setTimeout(() => {
      if (closed || !active || execution.isDetached) return;
      watchdogClosing = true;
      void (async () => {
        await sdk.dispose(); oneshotFinished = true; removeFlush(); active = false; turnController.abort();
        for (const release of unbind) release();
        for (const dispose of cleanup) await dispose();
        options.onEvent?.({ kind: "result", isError: true, source: "watchdog", detail: "The agent turn exceeded its deadline." });
        rejectTurn?.(new Error("agent_turn_timeout")); resolveTurn = undefined; rejectTurn = undefined;
      })().catch((error) => rejectTurn?.(error instanceof Error ? error : new Error("agent_turn_timeout")));
    }, Math.max(1, turnDeadline - Date.now())); watchdog.unref();
  };
  scheduleWatchdog();
  const consume = async (event: AgentEvent) => {
    options.onEvent?.(redact(event) as typeof event);
    if (event.kind !== "result") return;
    active = false; turnDeadline = null; clearTimeout(watchdog); browserConnection?.endTurn(); computerConnection?.revoke(); turnController.abort();
    if (options.continuation === "oneshot") {
      await sdk.dispose(); oneshotFinished = true; removeFlush();
      for (const release of unbind) release();
      for (const dispose of cleanup) await dispose();
    }
    resolveTurn?.(); resolveTurn = undefined; rejectTurn = undefined;
  };
  void (async () => {
    try {
      for await (const message of session) {
        if (closed || execution.isDetached) return;
        if (message.type === "command_lifecycle" && typeof message.command_uuid === "string") {
          const id = steered.get(message.command_uuid);
          if (id && (message.state === "started" || message.state === "cancelled")) {
            steered.delete(message.command_uuid);
            await consume({ kind: message.state === "started" ? "input-started" : "input-cancelled", id });
            if (message.state === "started") pendingResult = null;
            else if (!steered.size && pendingResult) { const result = pendingResult; pendingResult = null; await consume(result); }
          }
        }
        for (const event of decoder.decode(message)) {
          if (event.kind === "result" && steered.size) { pendingResult = event; continue; }
          await consume(event);
        }
      }
      if (active && !closed && !execution.isDetached && !watchdogClosing) await consume({ kind: "result", isError: true, source: "incomplete", detail: "The agent session ended without a result." });
    } catch (error) { if (!execution.isDetached && !watchdogClosing) rejectTurn?.(error instanceof Error ? error : new Error("agent_live_session_lost")); }
  })();
  let tail: Promise<void> = turn.catch(() => {});
  return {
    attached: previous !== undefined,
    launchFingerprint: execution.get(key)?.launchFingerprint ?? null,
    waitForTurn: () => turn,
    ...(resources?.resident ? {
      steer(input: AgentInput, id: string) {
        if (closed || !active || execution.isUpdating || execution.isDetached) return false;
        const messageId = randomUUID(); steered.set(messageId, id);
        session.send(input as ClaudeGatewayInput, { messageId });
        return true;
      },
    } : {}),
    send(input: AgentInput) {
      const work = tail.then(async () => {
        if (closed || execution.isDetached) throw new Error("agent_session_unavailable");
        if (oneshotFinished) {
          successorFlight ??= createHostedPluginSession(deps, options, { cwd, scratch: ownedScratch, resident: resources?.resident ?? false, release: releaseResources }).then((created) => (successor = created));
          return (await successorFlight).send(input);
        }
        active = true; turnController = new AbortController();
        turnDeadline = options.settlement === "result-required" && options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : null;
        scheduleWatchdog();
        turn = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
        session.send(input as ClaudeGatewayInput, { messageId: randomUUID() });
        await turn;
      });
      tail = work.catch(() => {}); return work;
    },
    cancel() {
      if (successor) { successor.cancel(); return; }
      if (!closed && active) { turnController.abort(); browserConnection?.endTurn(); computerConnection?.revoke(); void session.interrupt().catch((error) => execution.failure("agent_interrupt_failed", error)); }
    },
    revokeComputerUse() { successor?.revokeComputerUse?.(); computerConnection?.revoke(); },
    async dispose() {
      if (closed) return; closed = true; lifetime.abort(); removeFlush(); clearTimeout(watchdog);
      if (execution.isDetached) { for (const release of unbind) release(); for (const dispose of cleanup) await dispose(); return; }
      await successorFlight?.catch(() => undefined);
      await successor?.dispose();
      for (const release of unbind) release();
      rejectTurn?.(new Error("agent_session_disposed"));
      await sdk.dispose();
      for (const dispose of cleanup) await dispose();
      await releaseResources();
    },
  };
  } catch (error) {
    lifetime.abort(); clearTimeout(watchdog); removeFlush(); execution.releaseBindings(key);
    await Promise.allSettled(cleanup.map(async (dispose) => dispose()));
    // A rejected successor must not delete the still-running old runner's scratch tree.
    if (!descriptor) await releaseResources();
    if (previous) execution.failSession(key, error);
    throw error;
  }
}

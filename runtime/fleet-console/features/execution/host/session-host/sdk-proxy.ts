import { randomUUID } from "node:crypto";
import type { ClaudeGatewayCanUseTool, ClaudeGatewayMessage, ClaudeGatewaySdk, ClaudeGatewaySdkOptions, ClaudeGatewaySession, ClaudeGatewaySessionRequest, ClaudeGatewayServedMcpServer } from "@fleet-console/agent-runtime/claude";
import type { SessionBusinessCall, SessionHostEvent, SessionSnapshot, SessionLaunchFingerprint } from "@fleet-console/protocol/session-host";
import type { HostedToolGroup } from "./contracts.js";
import type { HostedExecution } from "./adapters.js";
import { hostedGatewayUrl } from "./gateway-proxy.js";

type RemoteObserver = {
  afterSeq: number;
  consumed(event: SessionHostEvent): Promise<void>;
  gap(snapshot: SessionSnapshot): void;
};
export interface HostedSdkBinding {
  readonly key: string;
  readonly launchFingerprint?: SessionLaunchFingerprint;
  readonly tools?: readonly HostedToolGroup[];
  readonly hookPolicyPort?: string;
  readonly observer?: RemoteObserver;
}

async function mcp(server: ClaudeGatewayServedMcpServer, method: string, params?: unknown): Promise<unknown> {
  const response = await fetch(server.url, { method: "POST", headers: { ...Object.fromEntries((server.headers ?? []).map(({ name, value }) => [name, value])), "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, ...(params ? { params } : {}) }) });
  if (!response.ok) throw new Error(`session_mcp_backend_${response.status}`);
  const text = await response.text();
  const payload = JSON.parse(response.headers.get("content-type")?.includes("text/event-stream") ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1)! : text) as { error?: unknown; result?: unknown };
  if (payload.error) throw new Error("session_mcp_backend_error");
  return payload.result;
}

/** Converts session-scoped served MCP endpoints to frozen runner fronts and replaceable business handlers. */
export async function bindServedTools(execution: HostedExecution, key: string, servers: readonly ClaudeGatewayServedMcpServer[]): Promise<HostedToolGroup[]> {
  return Promise.all(servers.map(async (server) => {
    const initialized = await mcp(server, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fleet-session-host", version: "1" } }) as { instructions?: string; capabilities?: { resources?: Record<string, unknown> } };
    const listed = await mcp(server, "tools/list") as { tools: HostedToolGroup["tools"] };
    // Resources are optional in MCP. Tool-only Console endpoints reject resources/list.
    const resourceList = initialized.capabilities?.resources
      ? await mcp(server, "resources/list") as { resources?: HostedToolGroup["resources"] }
      : {};
    if (!Array.isArray(listed.tools)) throw new Error("session_mcp_schema_invalid");
    const port = `${key}:mcp:${server.name}`;
    execution.bind(port, async (call) => {
      if (call.sessionKey !== key) throw new Error("session_mcp_scope");
      const body = call.body as { server: string; tool: string; args: unknown; resource?: string };
      if (body.server === server.name && body.resource && resourceList.resources?.some((resource) => resource.uri === body.resource)) {
        const read = await mcp(server, "resources/read", { uri: body.resource }) as { contents?: { text?: string }[] };
        if (typeof read.contents?.[0]?.text !== "string") throw new Error("session_mcp_resource_invalid");
        return read.contents[0].text;
      }
      if (body.server !== server.name || !listed.tools.some((tool) => tool.name === body.tool)) throw new Error("session_mcp_tool_denied");
      return mcp(server, "tools/call", { name: body.tool, arguments: body.args });
    });
    return { name: server.name, port, tools: listed.tools, ...(initialized.instructions ? { instructions: initialized.instructions } : {}), ...(resourceList.resources?.length ? { resources: resourceList.resources } : {}) };
  }));
}

/** The proxy never owns a child, iterator, PTY, or upstream stream. */
export function createHostedSdk(execution: HostedExecution, options: ClaudeGatewaySdkOptions, binding: HostedSdkBinding): ClaudeGatewaySdk {
  const key = binding.key;
  let current = execution.get(key);
  let closed = false;
  let opened: ClaudeGatewaySession | null = null;
  let closeWork: Promise<unknown> | null = null;
  let failSend!: (error: Error) => void;
  const sendFailed = new Promise<never>((_resolve, reject) => { failSend = reject; });
  void sendFailed.catch(() => {});
  const configDir = () => String(current?.runtime.configDir ?? (options.home && options.home.kind !== "isolated" && "configDir" in options.home ? options.home.configDir : options.tempRoot ?? ""));
  const command = <T>(kind: string, body?: unknown) => execution.command<T>(key, kind, body);
  const permissionPort = `${key}:permission`;
  let permission: ClaudeGatewayCanUseTool | undefined;
  const pendingControllers = new Set<AbortController>();
  const invokePermission = (call: SessionBusinessCall) => {
    if (call.sessionKey !== key || !permission) throw new Error("session_permission_binding_unavailable");
    const body = call.body as { tool: string; input: Record<string, unknown>; toolUseId: string };
    const controller = new AbortController(); pendingControllers.add(controller);
    const answer = permission(body.tool, body.input, { signal: controller.signal, toolUseId: body.toolUseId });
    return { answer, controller, body };
  };
  execution.bind(permissionPort, (call) => {
    const { answer, controller, body } = invokePermission(call);
    // Fast non-interactive decisions remain ordinary drained business calls.
    if (!answer || typeof (answer as Promise<unknown>).then !== "function") { pendingControllers.delete(controller); return answer; }
    const permissionEpoch = execution.client.epoch;
    const lifetime = body.tool === "AskUserQuestion" || body.tool === "ExitPlanMode" ? { lifetime: "turn" as const, expiresAt: null } : { lifetime: "deadline" as const, expiresAt: Date.now() + 5 * 60_000 };
    void Promise.resolve(answer).then(async (value) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await execution.client.answerBusiness(call.requestId, permissionEpoch, value);
    }).catch((error) => execution.failure("session_permission_answer_failed", error)).finally(() => pendingControllers.delete(controller));
    return { $sessionHostDeferred: true, turnId: String(current?.runtime.activeCommandId ?? body.toolUseId), permissionEpoch, ...lifetime, presentation: body };
  });
  return {
    get configDir() { return configDir(); },
    models: options.models,
    async openSession(request) {
      if (closed || opened) throw new Error("session_proxy_already_open");
      permission = request.canUseTool;
      const served = await bindServedTools(execution, key, request.servedMcpServers ?? []);
      const { canUseTool: _permission, mcpServers: opaque, abortController: _abort, stderr: _stderr, servedMcpServers: _served, ...wireRequest } = request;
      if (opaque && Object.keys(opaque).length && !binding.tools?.length) throw new Error("session_embedded_tools_require_business_ports");
      const { modelPolicy: _policy, spawnProcess: _spawn, ...wireSdk } = options;
      if (execution.get("gateway:console")) {
        wireSdk.baseUrl = hostedGatewayUrl(execution, wireSdk.baseUrl);
        const env = { ...wireSdk.env };
        for (const name of ["FLEET_COMPACT_BASE_URL", "FLEET_MOD_BASE_URL"]) if (env[name]) env[name] = hostedGatewayUrl(execution, env[name]!);
        wireSdk.env = env;
      }
      const tools = [...(binding.tools ?? []), ...served];
      if (current?.state === "live") {
        const original = await execution.describe(key);
        if (original.kind !== "sdk") throw new Error("session_sdk_kind_conflict");
        const expected = original.embeddedTools ?? [];
        if (JSON.stringify(expected) !== JSON.stringify(tools)) throw new Error("session_tool_schema_incompatible");
      }
      current = await execution.open({ sessionKey: key, kind: "sdk", generation: execution.client.generation, launchFingerprint: binding.launchFingerprint, sdk: wireSdk, request: wireRequest, embeddedTools: [...(binding.tools ?? []), ...served], ...(permission ? { permissionPort } : {}), hookPolicyPort: binding.hookPolicyPort ?? "execution:agent-policy" });
      const pending = current.runtime.pendingBusiness as readonly (SessionBusinessCall & { deferred?: { permissionEpoch: number } })[] | undefined;
      // Rebind permission callbacks without executing a previously dispatched mutation.
      for (const entry of pending ?? []) {
        if (entry.port !== permissionPort || !entry.deferred) continue;
        const { answer, controller } = invokePermission({ ...entry, sessionKey: key });
        void Promise.resolve(answer).then((value) => execution.client.answerBusiness(entry.requestId, entry.deferred!.permissionEpoch, value)).catch((error) => execution.failure("session_permission_rebind_failed", error)).finally(() => pendingControllers.delete(controller));
      }
      const session: ClaudeGatewaySession = {
        send(input, sendOptions) {
          const messageId = sendOptions?.messageId ?? randomUUID();
          void execution.waitForAdmission().then(() => execution.command(key, "send", { input, messageId }, messageId)).catch((error) => {
            if (execution.isDetached) return;
            failSend(error instanceof Error ? error : new Error("session_send_failed"));
            execution.failure("session_send_failed", error);
          });
        },
        interrupt: () => command<void>("interrupt"),
        stopTask: (taskId) => command<void>("stopTask", { taskId }),
        backgroundTasks: (toolUseId) => command<boolean>("backgroundTasks", { toolUseId }),
        getContextUsage: () => command("getContextUsage"),
        supportedCommands: () => command("supportedCommands"),
        supportedAgents: () => command("supportedAgents"),
        reloadSkills: () => command("reloadSkills"),
        setModel: (model) => command<void>("setModel", { model }),
        applySessionSettings: (settings) => command<void>("applySessionSettings", settings),
        close() { if (closed) return; closed = true; for (const controller of pendingControllers) controller.abort(); closeWork = command("close"); void closeWork.catch((error) => execution.failure("session_close_failed", error)); },
        async *[Symbol.asyncIterator]() {
          const observer = new AbortController();
          const events = execution.events(key, binding.observer?.afterSeq ?? 0, binding.observer?.gap, observer.signal);
          try {
            while (!closed) {
              const next = await Promise.race([events.next(), sendFailed]);
              if (next.done || closed) return;
              const event = next.value;
              if (event.kind === "sdk-error") throw new Error(String(event.data));
              if (event.kind === "sdk-message") yield event.data as ClaudeGatewayMessage;
              await binding.observer?.consumed(event);
            }
          } finally { observer.abort(); void events.return(undefined).catch(() => {}); }
        },
      };
      opened = session;
      return session;
    },
    async startTurn() { throw new Error("session_proxy_requires_resident_session"); },
    async dispose() { opened?.close(); await closeWork; },
  };
}

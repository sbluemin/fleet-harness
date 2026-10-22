import { randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createClaudeGatewaySdk, createEmbeddedMcpServer, defineTool, type ClaudeGatewayMcpServer, type ClaudeGatewaySession, type ClaudeGatewaySdk, type ClaudeGatewayToolPermission } from "@fleet-console/agent-runtime/claude";
import { assertInternalMcpTokensNotShared, createExecutorSessionManager, createServedMcpEndpoint } from "@fleet-console/agent-runtime/mcp";
import { createMcpToolRegistry, createMcpToolSnapshotStore } from "@fleet-console/agent-runtime/tools";
import { claudeGatewayModelPolicy, createAiGatewayRouter, type AiGatewayRouteDeps, type AiGatewayRouter } from "@fleet-console/ai-gateway";
import { createOwnedProcessRegistry, startConsoleReaper, type ConsoleReaperLink, type ProcessContainmentPort, type ProcessGroupContainment, type OwnedProcessGroup } from "@fleet-console/lifecycle";
import { authenticateSessionPeer, connectSessionRpc, type SessionRpcPeer } from "@fleet-console/lifecycle/session-host";
import { CONSOLE_STOP_DEADLINE_MS, OWNED_GROUP_TERM_GRACE_MS } from "@fleet-console/protocol/lifecycle";
import { SESSION_ATTACH_POLL_MS, SESSION_HOST_WIRE, SESSION_RUNNER_WIRE, SESSION_REPLAY_MAX_BYTES, type SessionBusinessCall, type SessionGeneration, type SessionCommand } from "@fleet-console/protocol/session-host";
import { z } from "zod";
import { startTerminalShell } from "../terminal/pty.js";
import { createTerminalModeTracker } from "../terminal/terminal-mode-tracker.js";
import type { TerminalPtyHandle } from "../terminal/terminal-types.js";
import type { HostedSessionLaunch, HostedToolGroup } from "./contracts.js";

interface Runtime {
  launch: HostedSessionLaunch;
  sdk?: ClaudeGatewaySdk;
  session?: ClaudeGatewaySession;
  pty?: TerminalPtyHandle;
  gateway?: AiGatewayRouter;
  server?: http.Server;
  jobs: Map<string, unknown>;
  pending: Map<string, SessionBusinessCall>;
  inputs: { commandId: string; messageId: string; state: string }[];
  data: Record<string, unknown>;
  cleanup: (() => void | Promise<void>)[];
  closed: boolean;
}
export interface SessionRunnerBoot {
  readonly socket: string;
  readonly runnerCapability: string;
  readonly generation: SessionGeneration;
  readonly hostId: string;
}

/** Runner lifetime, not Console lifetime, owns SDK streams, PTY masters, and upstream fetches. */
export async function runSessionRunner(boot: SessionRunnerBoot, containment?: ProcessContainmentPort): Promise<void> {
  const peer = await connectSessionRpc(boot.socket);
  const runtimes = new Map<string, Runtime>();
  let reaper: ConsoleReaperLink | null = null;
  const ptyGroups = new Map<number, OwnedProcessGroup>();
  const registry = createOwnedProcessRegistry({ ...(containment ? { containment } : {}), onRegistered: (g) => reaper?.registered(g), onLeaderExited: (g) => reaper?.leaderExited(g), onRemoved: (g) => reaper?.removed(g) });
  if (process.platform !== "win32") reaper = startConsoleReaper({ script: boot.generation.reaper, env: process.env, instance: { consolePid: process.pid, lockFile: path.join(path.dirname(path.dirname(boot.generation.root)), `runner-${process.pid}.lock`), lockStartedAt: Date.now() }, groups: () => { const registered = registry.groups(); const ids = new Set(registered.map((g) => g.pgid)); return [...registered, ...[...ptyGroups.values()].filter((g) => !ids.has(g.pgid))]; } });
  let stopping = false;
  const emit = (r: Runtime, kind: string, data: unknown) => peer.call("event", { sessionKey: r.launch.sessionKey, kind, data });
  const snapshot = (r: Runtime) => {
    const { scrollback: _scrollback, ...metadata } = r.data;
    return { ...metadata, runnerWire: SESSION_RUNNER_WIRE, pendingInputs: r.inputs, pendingRequests: [...r.pending.values()], jobs: [...r.jobs.values()] };
  };
  const changed = (r: Runtime) => { void emit(r, "runtime", snapshot(r)).catch(() => {}); };
  async function business(r: Runtime, port: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    if (r.closed || signal?.aborted) throw new Error("session_request_cancelled");
    const call: SessionBusinessCall = { requestId: randomUUID(), sessionKey: r.launch.sessionKey, port, body };
    r.pending.set(call.requestId, call); changed(r);
    const abort = () => { void peer.call("cancel-business", { sessionKey: r.launch.sessionKey, requestId: call.requestId }).catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try { return await peer.call("business", call, 0); }
    finally { signal?.removeEventListener("abort", abort); r.pending.delete(call.requestId); changed(r); }
  }
  async function close(r: Runtime): Promise<void> {
    if (r.closed) return;
    r.closed = true;
    r.session?.close();
    try { r.pty?.kill(); } catch { /* Reaper/job containment is the final defense. */ }
    r.gateway?.dispose();
    if (r.server) { r.server.closeAllConnections(); r.server.close(); }
    await r.sdk?.dispose();
    await Promise.allSettled(r.cleanup.map(async (cleanup) => cleanup()));
    await emit(r, "ended", null).catch(() => {});
  }
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => { registry.killAll(); process.exit(1); }, CONSOLE_STOP_DEADLINE_MS); deadline.unref();
    registry.beginStop(() => false, OWNED_GROUP_TERM_GRACE_MS);
    await Promise.allSettled([...runtimes.values()].map(close));
    const ptyUntil = performance.now() + OWNED_GROUP_TERM_GRACE_MS;
    while ([...runtimes.values()].some((r) => r.pty && !r.data.ptyExited) && performance.now() < ptyUntil) await new Promise((resolve) => setTimeout(resolve, SESSION_ATTACH_POLL_MS));
    const flushUntil = performance.now() + CONSOLE_STOP_DEADLINE_MS - OWNED_GROUP_TERM_GRACE_MS;
    while (registry.groups().some((g) => g.leaderExitedAt === null) && performance.now() < flushUntil) await new Promise((resolve) => setTimeout(resolve, SESSION_ATTACH_POLL_MS));
    if (process.platform === "win32") {
      registry.killAll();
      while (registry.groups().length > 0) await new Promise((resolve) => setTimeout(resolve, SESSION_ATTACH_POLL_MS));
    } else await reaper?.drain();
    peer.close();
  }
  async function toolGroups(r: Runtime, groups: readonly HostedToolGroup[]): Promise<{ embedded: Record<string, ClaudeGatewayMcpServer>; served: { name: string; url: string; headers: { name: string; value: string }[] }[] }> {
    const embedded: Record<string, ClaudeGatewayMcpServer> = {};
    const served: { name: string; url: string; headers: { name: string; value: string }[] }[] = [];
    for (const group of groups) {
      const registry = createMcpToolRegistry(); const store = createMcpToolSnapshotStore();
      const tools = group.tools.map((tool) => {
        const schema = z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
        if (!(schema instanceof z.ZodObject)) throw new Error("session_tool_schema_invalid");
        const run = async (args: unknown) => {
          const parsed = schema.safeParse(args);
          if (!parsed.success) return { content: [{ type: "text", text: "Invalid tool arguments" }], isError: true };
          const result = await business(r, group.port, { server: group.name, tool: tool.name, args: parsed.data }) as { content?: readonly Readonly<Record<string, unknown>>[]; isError?: boolean } | null;
          if (!result || !Array.isArray(result.content)) throw new Error("session_tool_result_invalid");
          return { ...result, content: result.content, isError: result.isError === true };
        };
        registry.registerAgentTool({ id: tool.name, tag: tool.name, title: tool.name, description: tool.description, promptSnippet: "", whenToUse: [], whenNotToUse: [], usageGuidelines: [], parameters: tool.inputSchema, execute: run });
        return defineTool(tool.name, tool.description, schema.shape, run);
      });
      const resources = group.resources?.map((resource) => ({ ...resource, read: async () => {
        const value = await business(r, group.port, { server: group.name, resource: resource.uri });
        if (typeof value !== "string") throw new Error("session_resource_result_invalid");
        return value;
      } }));
      embedded[group.name] = createEmbeddedMcpServer({ name: group.name, instructions: group.instructions, tools, resources });
      const server = createServedMcpEndpoint({ serverInfo: { name: group.name }, instructions: group.instructions, toolSnapshotStore: store, resources });
      const manager = createExecutorSessionManager({ runtimes: [{ name: group.name, runtime: { registry, snapshotStore: store, server, resources } }] });
      const endpoint = await manager.getEndpoint();
      const [token] = manager.issueSessionToken({ cwd: r.launch.kind === "sdk" ? r.launch.request.cwd ?? process.cwd() : r.launch.kind === "pty" ? r.launch.launch.cwd : process.cwd(), label: r.launch.sessionKey });
      if (!token || !endpoint.servers[0]) throw new Error("session_mcp_unavailable");
      served.push({ name: group.name, url: endpoint.servers[0].url, headers: [{ name: "Authorization", value: `Bearer ${token.token}` }] });
      r.cleanup.push(async () => { manager.cleanup(); await server.stop(); });
    }
    return { embedded, served };
  }
  async function ingress(r: Runtime): Promise<void> {
    const token = randomUUID() + randomUUID();
    const server = http.createServer(async (req, res) => {
      const auth = req.headers.authorization ?? "";
      if (req.headers.origin || req.headers.host !== `127.0.0.1:${req.socket.localPort}` || req.method !== "POST" || Buffer.byteLength(auth) !== Buffer.byteLength(`Bearer ${token}`) || !timingSafeEqual(Buffer.from(auth), Buffer.from(`Bearer ${token}`))) { res.writeHead(403).end(); return; }
      try {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) { const b = Buffer.from(chunk); bytes += b.length; if (bytes > 1024 * 1024) throw new Error("session_hook_limit"); chunks.push(b); }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        await emit(r, "hook", { path: req.url, body });
        const policyPort = r.launch.hookPolicyPort;
        const result = policyPort && req.url === "/agent-call" ? await business(r, policyPort, { path: req.url, body }) : { accepted: true };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
      } catch { res.writeHead(503).end(); }
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("session_hook_bind");
    r.data.hookIngress = { origin: `http://127.0.0.1:${address.port}`, token };
    r.cleanup.push(() => { server.closeAllConnections(); server.close(); });
  }
  peer.bind(async (method, raw) => {
    if (method === "shutdown") { setImmediate(() => { void shutdown(); }); return true; }
    if (method === "open") {
      const launch = raw as HostedSessionLaunch;
      if (launch.generation.id !== boot.generation.id || stopping || runtimes.has(launch.sessionKey)) throw new Error("session_runner_launch_conflict");
      const r: Runtime = { launch, jobs: new Map(), pending: new Map(), inputs: [], data: { activeCommandId: null, turnOpen: false }, cleanup: [], closed: false }; runtimes.set(launch.sessionKey, r);
      try {
        await ingress(r);
        if (launch.kind === "sdk") {
          const groups = await toolGroups(r, launch.embeddedTools ?? []);
          assertInternalMcpTokensNotShared([...groups.served, ...(launch.request.servedMcpServers ?? [])].map((s) => ({ ...s, type: "http" as const })), groups.served.map((s) => ({ serverName: s.name, token: s.headers[0]!.value.slice(7) })));
          const hook = r.data.hookIngress as { origin: string; token: string };
          r.sdk = await createClaudeGatewaySdk({ ...launch.sdk, env: { ...launch.sdk.env, FLEET_SESSION_HOOK_ORIGIN: hook.origin, FLEET_SESSION_HOOK_TOKEN: hook.token }, modelPolicy: claudeGatewayModelPolicy, spawnProcess: (request) => {
            const child = registry.spawn(request);
            if (child.pid !== undefined) ptyGroups.delete(child.pid);
            if (process.platform === "win32" && !registry.groups().some((g) => g.pgid === child.pid)) { child.kill("SIGKILL"); throw new Error("session_agent_containment_failed"); }
            r.data.pid = child.pid; changed(r); return child;
          } });
          r.session = await r.sdk.openSession({ ...launch.request, ...(Object.keys(groups.embedded).length ? { mcpServers: groups.embedded } : {}), ...(launch.permissionPort ? { canUseTool: async (tool, input, context) => await business(r, launch.permissionPort!, { tool, input, toolUseId: context.toolUseId }, context.signal) as ClaudeGatewayToolPermission } : {}) });
          r.data.configDir = r.sdk.configDir; r.data.models = r.sdk.models; r.data.mcpServers = groups.served;
          void (async () => {
            try {
              for await (const message of r.session!) {
                if (message.session_id) r.data.providerSessionId = message.session_id;
                if (message.type === "command_lifecycle" && typeof message.command_uuid === "string") {
                  const input = r.inputs.find((i) => i.messageId === message.command_uuid);
                  if (input && typeof message.state === "string") {
                    input.state = message.state;
                    if (message.state === "started") { r.data.activeCommandId = input.commandId; r.data.turnOpen = true; }
                    if (message.state === "completed" || message.state === "cancelled") r.inputs = r.inputs.filter((i) => i !== input);
                  }
                }
                if (message.type === "stream_event" && (message.event as { type?: string } | undefined)?.type === "message_start") {
                  r.data.turnOpen = true;
                  if (!r.data.activeCommandId) r.data.activeCommandId = r.inputs[0]?.commandId ?? null;
                }
                if (message.type === "result") {
                  r.inputs = r.inputs.filter((i) => i.commandId !== r.data.activeCommandId);
                  r.data.turnOpen = false; r.data.activeCommandId = null;
                }
                const taskId = message.task_id;
                if (typeof taskId === "string") { if (message.status === "completed" || message.status === "failed" || message.status === "stopped") r.jobs.delete(taskId); else r.jobs.set(taskId, message); }
                await emit(r, "sdk-message", message); changed(r);
              }
            } catch (error) { await emit(r, "sdk-error", error instanceof Error ? error.message : "session_stream_failed").catch(() => {}); }
            finally { await close(r); }
          })();
        } else if (launch.kind === "pty") {
          const groups = await toolGroups(r, launch.mcpTools ?? []); r.data.mcpServers = groups.served;
          const finalLaunch = launch.launchPort ? await business(r, launch.launchPort, { launch: launch.launch, mcpServers: groups.served, hookIngress: r.data.hookIngress }) as typeof launch.launch : launch.launch;
          if (groups.served.length) {
            const index = finalLaunch.args.indexOf("--mcp-config");
            const arg = finalLaunch.args[index + 1];
            if (index < 0 || !arg) throw new Error("session_pty_mcp_config_missing");
            const config = JSON.parse(arg.trimStart().startsWith("{") ? arg : fs.readFileSync(arg, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
            const servers = Object.entries(config.mcpServers).map(([name, value]) => ({ ...value, name })) as unknown as import("@fleet-console/agent-runtime/mcp").McpServerConfig[];
            assertInternalMcpTokensNotShared(servers, groups.served.map((s) => ({ serverName: s.name, token: s.headers[0]!.value.slice(7) })));
          }
          const hook = r.data.hookIngress as { origin: string; token: string };
          const at = Date.now(); r.pty = startTerminalShell({ ...finalLaunch, env: { ...finalLaunch.env, FLEET_SESSION_HOOK_ORIGIN: hook.origin, FLEET_SESSION_HOOK_TOKEN: hook.token } }, launch.size); r.data.pid = r.pty.pid; r.data.scrollback = ""; r.data.size = launch.size;
          const ptyPid = r.pty.pid;
          if (ptyPid === undefined) throw new Error("session_pty_pid_missing");
          // PTY leaders are created by node-pty, not child_process.spawn. Register their group with the runner's reaper.
          if (process.platform !== "win32") {
            const group = { pgid: ptyPid, spawnedAt: at, leaderExitedAt: null };
            ptyGroups.set(ptyPid, group); reaper?.registered(group);
          }
          let job: ProcessGroupContainment | null = null;
          if (process.platform === "win32") { job = containment?.contain(ptyPid) ?? null; if (!job) throw new Error("session_pty_containment_unavailable"); }
          if (job) r.cleanup.push(() => { job!.terminate(); if (!job!.hasMembers()) job!.close(); });
          const modes = createTerminalModeTracker(); r.data.modes = modes.snapshot();
          let output = Promise.resolve<unknown>(undefined); let buffered = 0;
          r.pty.onData((data) => {
            modes.push(Buffer.from(data)); const nextModes = modes.snapshot(); const modeChanged = JSON.stringify(nextModes) !== JSON.stringify(r.data.modes); r.data.modes = nextModes;
            r.data.scrollback = (String(r.data.scrollback) + data).slice(-SESSION_REPLAY_MAX_BYTES / 2);
            buffered += 1; r.pty?.pause?.();
            output = output.then(async () => { await emit(r, "pty-data", data); if (modeChanged) await emit(r, "pty-modes", nextModes); }).catch(() => {}).finally(() => { buffered -= 1; if (!buffered && !r.closed) r.pty?.resume?.(); });
          });
          r.pty.onExit(() => {
            r.data.ptyExited = true;
            if (process.platform !== "win32" && ptyGroups.get(ptyPid)?.spawnedAt === at) { const group = { pgid: ptyPid, spawnedAt: at, leaderExitedAt: Date.now() }; ptyGroups.set(ptyPid, group); reaper?.leaderExited(group); }
            void emit(r, "pty-exit", null).finally(() => close(r)).catch(() => {});
          });
        } else {
          const ports = launch.ports;
          const call = (name: keyof typeof ports, body?: unknown) => { const port = ports[name]; return port ? business(r, port, body) : Promise.resolve(null); };
          const liveOptions = { ...launch.options }; r.data.gatewayOptions = liveOptions;
          const deps: AiGatewayRouteDeps = { originator: "fleet-console", readAuth: async () => await call("readAuth") as Awaited<ReturnType<AiGatewayRouteDeps["readAuth"]>>, readAiGatewaySettings: () => liveOptions.settings!, readModelOverride: () => liveOptions.modelOverride, compactionHookToken: launch.options.compactHookToken, modHookToken: launch.options.modHookToken, maxUpstreamInFlight: launch.options.maxUpstreamInFlight };
          for (const name of ["readCursorToken", "readXaiToken", "readAntigravityToken", "renewAntigravityToken"] as const) if (ports[name]) Object.assign(deps, { [name]: () => call(name) });
          if (ports.readMuseCodeAuth) Object.assign(deps, { readMuseCodeAuth: () => call("readMuseCodeAuth") });
          if (ports.renewMuseCodeAuth) Object.assign(deps, { renewMuseCodeAuth: (key: string) => call("renewMuseCodeAuth", key) });
          if (ports.assignRouting) Object.assign(deps, { assignRouting: (request: unknown) => call("assignRouting", request) });
          r.gateway = createAiGatewayRouter(deps);
          r.server = http.createServer((req, res) => {
            if (req.headers.origin || req.headers.host !== `127.0.0.1:${req.socket.localPort}`) { res.writeHead(403).end(); return; }
            void Promise.resolve(r.gateway!.handle({ req, res, pathname: new URL(req.url ?? "/", `http://${req.headers.host}`).pathname })).then((handled) => { if (!handled) res.writeHead(404).end(); }, () => { if (!res.headersSent) res.writeHead(502); res.end(); });
          });
          await new Promise<void>((resolve, reject) => { r.server!.once("error", reject); r.server!.listen(0, "127.0.0.1", resolve); });
          const address = r.server.address(); if (!address || typeof address === "string") throw new Error("session_gateway_bind");
          r.data.origin = `http://127.0.0.1:${address.port}`;
        }
        return snapshot(r);
      } catch (error) { await close(r); throw error; }
    }
    if (method !== "command") throw new Error("session_runner_method_denied");
    const command = raw as SessionCommand; const r = runtimes.get(command.sessionKey);
    if (!r || r.closed) throw new Error("session_closed");
    const body = (command.body ?? {}) as Record<string, unknown>;
    if (command.kind === "close") { await close(r); return true; }
    if (r.session) {
      switch (command.kind) {
        case "send": {
          if (r.inputs.length >= 256) throw new Error("session_input_capacity");
          const messageId = typeof body.messageId === "string" ? body.messageId : randomUUID();
          r.session.send(body.input as Parameters<ClaudeGatewaySession["send"]>[0], { messageId });
          r.inputs.push({ commandId: command.commandId, messageId, state: "queued" }); changed(r); return { messageId };
        }
        case "interrupt": return r.session.interrupt();
        case "stopTask": return r.session.stopTask(String(body.taskId));
        case "backgroundTasks": return r.session.backgroundTasks(body.toolUseId as string | undefined);
        case "getContextUsage": return r.session.getContextUsage();
        case "supportedCommands": return r.session.supportedCommands();
        case "supportedAgents": return r.session.supportedAgents();
        case "reloadSkills": return r.session.reloadSkills();
        case "setModel": return r.session.setModel(String(body.model));
        case "applySessionSettings": return r.session.applySessionSettings(body as Parameters<ClaudeGatewaySession["applySessionSettings"]>[0]);
      }
    }
    if (r.gateway && command.kind === "configureGateway") {
      const options = r.data.gatewayOptions as { settings?: unknown; modelOverride?: unknown };
      if ("settings" in body) options.settings = body.settings;
      if ("modelOverride" in body) options.modelOverride = body.modelOverride;
      changed(r); return true;
    }
    if (r.pty) {
      if (command.kind === "write") { r.pty.write(String(body.data)); return true; }
      if (command.kind === "resize") { const cols = Number(body.cols); const rows = Number(body.rows); if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1_000 || rows > 1_000) throw new Error("session_pty_size"); r.pty.resize(cols, rows); r.data.size = { cols, rows }; changed(r); return true; }
    }
    throw new Error("session_command_unsupported");
  });
  peer.onClose(() => { void shutdown(); });
  await authenticateSessionPeer(peer, { wire: SESSION_HOST_WIRE, runnerWire: SESSION_RUNNER_WIRE, role: "runner", hostId: boot.hostId, generation: boot.generation.id }, boot.runnerCapability);
  process.on("SIGTERM", () => { void shutdown(); }); process.on("SIGINT", () => { void shutdown(); });
  process.on("uncaughtException", () => process.exit(1));
}

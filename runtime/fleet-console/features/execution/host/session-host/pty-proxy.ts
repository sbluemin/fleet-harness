import fs from "node:fs";
import type { ClaudeGatewayServedMcpServer } from "@fleet-console/agent-runtime/claude";
import type { TerminalLaunchSpec, TerminalPtyHandle, TerminalTicketContext } from "../terminal/terminal-types.js";
import type { HostedExecution } from "./adapters.js";
import { bindServedTools } from "./sdk-proxy.js";
import { hostedGatewayUrl } from "./gateway-proxy.js";
import type { SessionCheckpoint } from "./contracts.js";

/** All PTY handles below are observers; no native master FD crosses the Console boundary. */
export async function openHostedPty(execution: HostedExecution, context: TerminalTicketContext, launch: TerminalLaunchSpec, size: { cols: number; rows: number }, consoleOrigin: string): Promise<TerminalPtyHandle> {
  const key = `pty:${context.sessionId}`;
  const previous = execution.get(key);
  const args = [...launch.args];
  const index = args.indexOf("--mcp-config");
  let config: { mcpServers: Record<string, { type?: string; url?: string; headers?: Record<string, string> }> } | undefined;
  if (index >= 0 && args[index + 1]) {
    const value = args[index + 1]!;
    config = JSON.parse(value.trimStart().startsWith("{") ? value : fs.readFileSync(value, "utf8"));
  }
  const internal: ClaudeGatewayServedMcpServer[] = [];
  for (const [name, server] of Object.entries(config?.mcpServers ?? {})) {
    if (server.type !== "http" || !server.url) continue;
    const url = new URL(server.url);
    if (url.origin !== consoleOrigin || !url.pathname.startsWith("/mcp/")) continue;
    internal.push({ name, url: server.url, headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })) });
  }
  const tools = await bindServedTools(execution, key, internal);
  const port = `${key}:launch`;
  const { cleanup: _cleanup, sessionIdentityResolver: _identity, launchFingerprint, ...wireLaunch } = launch;
  wireLaunch.env = { ...wireLaunch.env };
  for (const name of ["ANTHROPIC_BASE_URL", "FLEET_COMPACT_BASE_URL", "FLEET_MOD_BASE_URL"]) if (wireLaunch.env[name] && execution.get("gateway:console")) wireLaunch.env[name] = hostedGatewayUrl(execution, wireLaunch.env[name]!);
  execution.bind(port, (call) => {
    if (call.sessionKey !== key) throw new Error("session_pty_launch_scope");
    const body = call.body as { mcpServers: ClaudeGatewayServedMcpServer[] };
    const mcpServers = { ...(config?.mcpServers ?? {}) };
    for (const server of body.mcpServers) mcpServers[server.name] = { type: "http", url: server.url, headers: Object.fromEntries((server.headers ?? []).map(({ name, value }) => [name, value])) };
    const finalArgs = [...args];
    if (body.mcpServers.length) {
      if (index < 0) throw new Error("session_pty_mcp_config_missing");
      finalArgs[index + 1] = JSON.stringify({ mcpServers });
    }
    return { ...wireLaunch, args: finalArgs };
  });
  if (previous?.state === "live") {
    const original = await execution.describe(key);
    if (original.kind !== "pty" || JSON.stringify(original.mcpTools ?? []) !== JSON.stringify(tools)) throw new Error("session_pty_schema_incompatible");
  }
  const snapshot = await execution.open({ sessionKey: key, kind: "pty", generation: execution.client.generation, ...(launchFingerprint ? { launchFingerprint: { ...launchFingerprint } } : {}), launch: wireLaunch, size, mcpTools: tools, launchPort: port, hookPolicyPort: "execution:agent-policy" });
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<() => void>();
  let stopped = false;
  let cursor = (snapshot.checkpoint as SessionCheckpoint | null)?.lastConsumedSeq ?? 0;
  const flush = async () => { if (!stopped && !execution.isDetached) await execution.checkpoint(key, { lastConsumedSeq: cursor, activeCommandId: null, pendingInputs: [], pendingAsks: [], jobs: [], queuedWakes: [], state: null }); };
  const removeFlush = execution.beforeUpdate(flush);
  let paused = false;
  let wake: (() => void) | undefined;
  const command = (kind: string, body?: unknown) => {
    if (stopped || execution.isDetached) throw new Error("terminal_observer_detached");
    void execution.command(key, kind, body).catch((error) => execution.failure("terminal_host_command_failed", error));
  };
  const ready = new Promise<void>((resolve) => { wake = resolve; });
  void (async () => {
    await ready;
    const scrollback = snapshot.runtime.scrollback;
    if (typeof scrollback === "string" && scrollback) for (const listener of dataListeners) listener(scrollback);
    for await (const event of execution.events(key, cursor, (fresh) => {
      cursor = fresh.seq;
      const scrollback = fresh.runtime.scrollback;
      if (typeof scrollback !== "string") throw new Error("terminal_host_snapshot_invalid");
      for (const listener of dataListeners) listener(`\x1bc${scrollback}`);
    })) {
      while (paused && !execution.isDetached && !stopped) await new Promise((resolve) => setTimeout(resolve, 25));
      if (stopped || execution.isDetached) return;
      if (event.kind === "pty-data" && event.seq > snapshot.seq) for (const listener of dataListeners) listener(String(event.data));
      cursor = event.seq; await flush();
      if (event.kind === "pty-exit" || event.kind === "lost") { removeFlush(); for (const listener of exitListeners) listener(); return; }
    }
  })().catch((error) => { if (!execution.isDetached) execution.failure("terminal_host_stream_failed", error); });
  return {
    pid: typeof snapshot.runtime.pid === "number" ? snapshot.runtime.pid : undefined,
    onData(callback) { dataListeners.add(callback); queueMicrotask(() => wake?.()); return { dispose: () => dataListeners.delete(callback) }; },
    onExit(callback) { exitListeners.add(callback); return { dispose: () => exitListeners.delete(callback) }; },
    write(data) { command("write", { data: typeof data === "string" ? data : data.toString("utf8") }); },
    resize(cols, rows) { command("resize", { cols, rows }); },
    pause() { paused = true; },
    resume() { paused = false; },
    kill() { if (stopped) return; if (execution.get(key)?.state === "live") command("close"); stopped = true; removeFlush(); },
    destroy() { if (stopped) return; if (execution.get(key)?.state === "live") command("close"); stopped = true; removeFlush(); },
  };
}

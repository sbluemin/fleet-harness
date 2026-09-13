import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeGatewayMessage, ClaudeGatewaySdk, ClaudeGatewayTurn } from "@dotobokuri/core-agent/claude";
import { createPluginAgentHost } from "../core/host/agent/plugin-agent.js";
import type { AgentEvent } from "@fleet-console/sdk/agent";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const consoleUse = { connect: () => { throw new Error("unexpected Console read access"); } };
const aiGatewayMcp = { connect: () => { throw new Error("unexpected gateway resource access"); } };

async function directory() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-plugin-agent-")); roots.push(root); return root; }
function sdk(startTurn: (turn: ClaudeGatewayTurn) => Promise<unknown>) { return { startTurn: vi.fn(startTurn), dispose: vi.fn(async () => undefined) } as unknown as ClaudeGatewaySdk; }
function run(messages: readonly ClaudeGatewayMessage[]) { return { close() {}, getContextUsage: async () => null, async *[Symbol.asyncIterator]() { yield* messages; } }; }
const options = { model: "sonnet", systemPrompt: "test", continuation: "conversation" as const, settlement: "result" as const };

describe("Console-owned plugin Agent", () => {
  it("owns isolated execution, tool scope, continuation, redaction and cleanup", async () => {
    const root = await directory(); const events: AgentEvent[] = []; const turns: ClaudeGatewayTurn[] = [];
    const engine = sdk(async turn => { turns.push(turn); return run([
      { type: "system", subtype: "init", session_id: "private-child" },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: `Read ${turn.cwd}/file` } } },
      { type: "result", is_error: false },
    ]); });
    const connection = { embeddedServer: { type: "sdk", name: "fleet-console-use", instance: {} }, dispose: vi.fn(async () => undefined) };
    const connect = vi.fn(() => connection as never);
    const gateway = { embeddedServer: { type: "sdk", name: "fleet-ai-gateway", instance: {} }, dispose: vi.fn(async () => undefined) };
    const host = createPluginAgentHost({ dataDir: root, baseUrl: () => "http://127.0.0.1:1/api/v1/ai-gateway", consoleUse: { connect }, aiGatewayMcp: { connect: () => gateway as never }, createSdk: async () => engine });
    const session = await host.createSession({ ...options, tools: { consoleUse: { tools: ["console_launch"], allowControl: true }, aiGateway: true, builtins: ["WebFetch"], custom: [{ name: "draft", tools: [{ name: "read", description: "Read only this draft", inputSchema: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: [{ type: "text", text: "draft" }] }) }] }] }, onEvent: event => events.push(event) });
    await session.send("one"); await session.send("two");
    // 게이트웨이는 리소스뿐이라 도구 이름은 늘지 않고, 그 리소스를 읽을 내장 도구 둘만 함께 열린다.
    expect(turns[0]).toMatchObject({ tools: ["WebFetch", "ListMcpResourcesTool", "ReadMcpResourceTool"], allowedTools: ["WebFetch", "ListMcpResourcesTool", "ReadMcpResourceTool", "mcp__draft__read", "mcp__fleet-console-use__console_launch"], permissionMode: "dontAsk" });
    expect(Object.keys(turns[0]!.mcpServers!)).toEqual(["draft", "fleet-console-use", "fleet-ai-gateway"]);
    expect(connect).toHaveBeenCalledWith({ tools: ["console_launch"], allowControl: true, enabled: expect.any(Function) });
    expect(turns[1]!.resume).toBe("private-child");
    expect(turns[0]!.cwd).toContain(root);
    expect(JSON.stringify(events)).not.toContain(root);
    expect(JSON.stringify(events)).not.toContain("private-child");
    await host.dispose(); await session.dispose();
    expect(connection.dispose).toHaveBeenCalledOnce();
    expect(gateway.dispose).toHaveBeenCalledOnce();
    expect(await fs.readdir(root)).toEqual([]);
    await expect(host.createSession(options)).rejects.toThrow("agent_host_disposed");
  });

  it("cancels a live turn without completing it, then allows another turn", async () => {
    const root = await directory(); const events: AgentEvent[] = []; let started!: () => void;
    const entered = new Promise<void>(r => { started = r; }); let release!: () => void;
    const held = new Promise<void>(r => { release = r; }); let calls = 0;
    const engine = sdk(async () => ++calls === 1 ? { close: release, getContextUsage: async () => null, async *[Symbol.asyncIterator]() { started(); await held; yield { type: "result", is_error: false }; } } : run([{ type: "result", is_error: false }]));
    const host = createPluginAgentHost({ dataDir: root, baseUrl: () => "http://127.0.0.1:1", consoleUse, aiGatewayMcp, createSdk: async () => engine });
    const session = await host.createSession({ ...options, onEvent: event => events.push(event) });
    const first = session.send("one"); await entered; session.cancel(); await first;
    expect(events).toEqual([{ kind: "cancelled" }]);
    await session.send("two"); expect(events.at(-1)).toMatchObject({ kind: "result", isError: false });
    await host.dispose();
  });

  it("rejects unavailable gateways and rolls back SDK creation racing host disposal", async () => {
    const root = await directory(); const unavailable = createPluginAgentHost({ dataDir: root, baseUrl: () => null, consoleUse, aiGatewayMcp });
    await expect(unavailable.createSession(options)).rejects.toThrow("agent_gateway_unavailable");
    let release!: (value: ClaudeGatewaySdk) => void; let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; }); const gate = new Promise<ClaudeGatewaySdk>(r => { release = r; });
    const engine = sdk(async () => run([]));
    const host = createPluginAgentHost({ dataDir: root, baseUrl: () => "http://127.0.0.1:1", consoleUse, aiGatewayMcp, createSdk: () => { entered(); return gate; } });
    const creating = host.createSession(options); const rejected = expect(creating).rejects.toThrow("disposed");
    await started; const disposing = host.dispose(); release(engine); await rejected; await disposing;
    expect(engine.dispose).toHaveBeenCalledOnce(); expect(await fs.readdir(root)).toEqual([]);
  });
});

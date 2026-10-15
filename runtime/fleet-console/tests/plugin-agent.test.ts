import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeGatewayMessage, ClaudeGatewaySdk, ClaudeGatewayTurn } from "@fleet-console/agent-runtime/claude";
import { createPluginAgentHost } from "../features/execution/host/agent/plugin-agent.js";
import type { AgentEvent } from "@fleet-console/sdk/agent";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

function sdk(startTurn: (turn: ClaudeGatewayTurn) => Promise<unknown>) { return { startTurn: vi.fn(startTurn), dispose: vi.fn(async () => undefined) } as unknown as ClaudeGatewaySdk; }
function run(messages: readonly ClaudeGatewayMessage[]) { return { close() {}, getContextUsage: async () => null, async *[Symbol.asyncIterator]() { yield* messages; } }; }
const options = { model: "sonnet", systemPrompt: "test", continuation: "conversation" as const, settlement: "result" as const };

describe("Console-owned plugin Agent", () => {
  it("owns isolated execution, tool scope, continuation, redaction and cleanup", async () => {
    let root!: string; let executable: string | undefined; let autoCompactWindow: number | undefined; const events: AgentEvent[] = []; const turns: ClaudeGatewayTurn[] = [];
    const engine = sdk(async turn => { turns.push(turn); return run([
      { type: "system", subtype: "init", session_id: "private-child" },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: `Read ${turn.cwd}/file` } } },
      // 같은 세션 안의 압축 — 경계가 이벤트로 나가고, 대화 크기는 턴 합계가 아니라 마지막 호출의 입력이다.
      { type: "assistant", message: { content: [], usage: { input_tokens: 10, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0 } } },
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 90_010, post_tokens: 3_000 } },
      { type: "assistant", message: { content: [], usage: { input_tokens: 4_000 } } },
      { type: "result", is_error: false, usage: { input_tokens: 94_010, output_tokens: 5 } },
    ]); });
    const host = createPluginAgentHost({ baseUrl: () => "http://127.0.0.1:1/api/v1/ai-gateway", resolveExecutablePath: async () => "/installed/claude", createSdk: async (sdkOptions) => { root = sdkOptions.tempRoot!; executable = sdkOptions.executablePath; autoCompactWindow = sdkOptions.autoCompactWindow; roots.push(root); return engine; } });
    const session = await host.createSession({ ...options, compactAt: 150_000, tools: { builtins: ["WebFetch"], custom: [{ name: "draft", tools: [{ name: "read", description: "Read only this draft", inputSchema: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: [{ type: "text", text: "draft" }] }) }] }] }, onEvent: event => events.push(event) });
    await session.send("one");
    const imageInput = [{ type: "text" as const, text: "two" }, { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "iVBORw0KGgo=" } }];
    await session.send(imageInput);
    expect(turns[1]!.prompt).toEqual(imageInput);
    await expect(session.send([{ type: "image", source: { type: "url", url: "file:///private" } }] as never)).rejects.toThrow("Message required");
    expect(turns[0]).toMatchObject({ tools: ["WebFetch"], allowedTools: ["WebFetch", "mcp__draft__read"], permissionMode: "dontAsk" });
    expect(Object.keys(turns[0]!.mcpServers!)).toEqual(["draft"]);
    expect(turns[1]!.resume).toBe("private-child");
    expect(turns[0]!.cwd).toBe(root);
    expect(turns[1]!.cwd).toBe(root);
    // SDK 동봉 바이너리가 아니라 설치된 Claude Code로 뜬다 — 새 모델은 동봉본이 모르는 버전에서 400이 난다.
    expect(executable).toBe("/installed/claude");
    // 압축 지점은 자식의 자동 압축 창으로 옮겨진다 — Claude Code는 창에서 출력 예약 20k와 여유 13k를 빼고 압축한다.
    expect(autoCompactWindow).toBe(183_000);
    expect(events).toContainEqual({ kind: "compacted", trigger: "auto", preTokens: 90_010, postTokens: 3_000 });
    expect(events).toContainEqual(expect.objectContaining({ kind: "result", usage: { inputTokens: 94_010, outputTokens: 5, contextTokens: 4_000 } }));
    expect((await fs.stat(root)).isDirectory()).toBe(true);
    expect(JSON.stringify(events)).not.toContain(root);
    expect(JSON.stringify(events)).not.toContain("private-child");

    // Gateway 모델(272k)은 압축 지점을 Gateway 정책이 정한다 — 창을 덮지 않고, 자식이 말한 Claude 좌표(200k)의 토큰을
    // 공급자 토큰으로 되돌려 실제 압축 지점(272k − 16k)과 같은 단위로 싣는다.
    const gatewayEvents: AgentEvent[] = [];
    const gatewayEngine = sdk(async () => run([
      { type: "assistant", message: { content: [], usage: { input_tokens: 100_000 } } },
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 167_100, post_tokens: 3_000 } },
      { type: "result", is_error: false, usage: { input_tokens: 100_000, output_tokens: 5 } },
    ]));
    let gatewayWindow: number | undefined = -1;
    const gatewayHost = createPluginAgentHost({ baseUrl: () => "http://127.0.0.1:1", createSdk: async (sdkOptions) => { roots.push(sdkOptions.tempRoot!); gatewayWindow = sdkOptions.autoCompactWindow; return gatewayEngine; } });
    const gatewaySession = await gatewayHost.createSession({ ...options, model: "codex--gpt-6-luna", compactAt: 204_000, onEvent: event => gatewayEvents.push(event) });
    await gatewaySession.send("one");
    expect(gatewayWindow).toBeUndefined();
    expect(gatewayEvents).toContainEqual({ kind: "compacted", trigger: "auto", preTokens: 254_629, postTokens: 4_571 });
    expect(gatewayEvents).toContainEqual(expect.objectContaining({ kind: "result", usage: { inputTokens: 100_000, outputTokens: 5, contextTokens: 4_571, context: { window: 272_000, compactAt: 256_000 } } }));
    await gatewayHost.dispose();

    await host.dispose(); await session.dispose();
    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(host.createSession(options)).rejects.toThrow("agent_host_disposed");
  });

  it("cancels a live turn without completing it, then allows another turn", async () => {
    let root!: string; const events: AgentEvent[] = []; let started!: () => void;
    const entered = new Promise<void>(r => { started = r; }); let release!: () => void;
    const held = new Promise<void>(r => { release = r; }); let calls = 0;
    const engine = sdk(async () => ++calls === 1 ? { close: release, getContextUsage: async () => null, async *[Symbol.asyncIterator]() { started(); await held; yield { type: "result", is_error: false }; } } : run([{ type: "result", is_error: false }]));
    const host = createPluginAgentHost({ baseUrl: () => "http://127.0.0.1:1", createSdk: async ({ tempRoot }) => { root = tempRoot!; roots.push(root); return engine; } });
    const session = await host.createSession({ ...options, onEvent: event => events.push(event) });
    const first = session.send("one"); await entered; session.cancel(); await first;
    expect(events).toEqual([{ kind: "cancelled" }]);
    await session.send("two"); expect(events.at(-1)).toMatchObject({ kind: "result", isError: false });
    await host.dispose();
  });

  it("rejects unavailable gateways and rolls back SDK creation racing host disposal", async () => {
    let root!: string; const unavailable = createPluginAgentHost({ baseUrl: () => null });
    await expect(unavailable.createSession(options)).rejects.toThrow("agent_gateway_unavailable");
    let release!: (value: ClaudeGatewaySdk) => void; let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; }); const gate = new Promise<ClaudeGatewaySdk>(r => { release = r; });
    const engine = sdk(async () => run([]));
    const host = createPluginAgentHost({ baseUrl: () => "http://127.0.0.1:1", createSdk: ({ tempRoot }) => { root = tempRoot!; roots.push(root); entered(); return gate; } });
    const creating = host.createSession(options); const rejected = expect(creating).rejects.toThrow("disposed");
    await started; const disposing = host.dispose(); release(engine); await rejected; await disposing;
    expect(engine.dispose).toHaveBeenCalledOnce(); await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

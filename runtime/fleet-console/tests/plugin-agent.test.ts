import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeGatewayMessage, ClaudeGatewaySdk, ClaudeGatewayTurn } from "@fleet-console/agent-runtime/claude";
import { createPluginAgentHost } from "../features/execution/host/agent/plugin-agent.js";
import type { AgentEvent } from "@fleet-console/sdk/agent";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const consoleUse = { connect: () => { throw new Error("unexpected Console read access"); } };

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
    const connection = { embeddedServer: { type: "sdk", name: "fleet-console-use", instance: {} }, dispose: vi.fn(async () => undefined) };
    const connect = vi.fn(() => connection as never);
    const host = createPluginAgentHost({ baseUrl: () => "http://127.0.0.1:1/api/v1/ai-gateway", consoleUse: { connect }, resolveExecutablePath: async () => "/installed/claude", createSdk: async (sdkOptions) => { root = sdkOptions.tempRoot!; executable = sdkOptions.executablePath; autoCompactWindow = sdkOptions.autoCompactWindow; roots.push(root); return engine; } });
    const session = await host.createSession({ ...options, compactAt: 150_000, tools: { consoleUse: { tools: ["console_launcher"], allowControl: true }, builtins: ["WebFetch"], custom: [{ name: "draft", tools: [{ name: "read", description: "Read only this draft", inputSchema: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: [{ type: "text", text: "draft" }] }) }] }] }, onEvent: event => events.push(event) });
    await session.send("one");
    const imageInput = [{ type: "text" as const, text: "two" }, { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "iVBORw0KGgo=" } }];
    await session.send(imageInput);
    expect(turns[1]!.prompt).toEqual(imageInput);
    await expect(session.send([{ type: "image", source: { type: "url", url: "file:///private" } }] as never)).rejects.toThrow("Message required");
    expect(turns[0]).toMatchObject({ tools: ["WebFetch"], allowedTools: ["WebFetch", "mcp__draft__read", "mcp__fleet-console-use__console_launcher"], permissionMode: "dontAsk" });
    expect(Object.keys(turns[0]!.mcpServers!)).toEqual(["draft", "fleet-console-use"]);
    expect(connect).toHaveBeenCalledWith({ tools: ["console_launcher"], allowControl: true, enabled: expect.any(Function) });
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
    const gatewayHost = createPluginAgentHost({ baseUrl: () => "http://127.0.0.1:1", consoleUse, createSdk: async (sdkOptions) => { roots.push(sdkOptions.tempRoot!); gatewayWindow = sdkOptions.autoCompactWindow; return gatewayEngine; } });
    const gatewaySession = await gatewayHost.createSession({ ...options, model: "codex--gpt-6-luna", compactAt: 204_000, onEvent: event => gatewayEvents.push(event) });
    await gatewaySession.send("one");
    expect(gatewayWindow).toBeUndefined();
    expect(gatewayEvents).toContainEqual({ kind: "compacted", trigger: "auto", preTokens: 254_629, postTokens: 4_571 });
    expect(gatewayEvents).toContainEqual(expect.objectContaining({ kind: "result", usage: { inputTokens: 100_000, outputTokens: 5, contextTokens: 4_571, context: { window: 272_000, compactAt: 256_000 } } }));
    await gatewayHost.dispose();

    await host.dispose(); await session.dispose();
    expect(connection.dispose).toHaveBeenCalledOnce();
    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(host.createSession(options)).rejects.toThrow("agent_host_disposed");
  });

  it("cancels a live turn without completing it, then allows another turn", async () => {
    let root!: string; const events: AgentEvent[] = []; let started!: () => void;
    const entered = new Promise<void>(r => { started = r; }); let release!: () => void;
    const held = new Promise<void>(r => { release = r; }); let calls = 0;
    const engine = sdk(async () => ++calls === 1 ? { close: release, getContextUsage: async () => null, async *[Symbol.asyncIterator]() { started(); await held; yield { type: "result", is_error: false }; } } : run([{ type: "result", is_error: false }]));
    const host = createPluginAgentHost({ baseUrl: () => "http://127.0.0.1:1", consoleUse, createSdk: async ({ tempRoot }) => { root = tempRoot!; roots.push(root); return engine; } });
    const session = await host.createSession({ ...options, onEvent: event => events.push(event) });
    const first = session.send("one"); await entered; session.cancel(); await first;
    expect(events).toEqual([{ kind: "cancelled" }]);
    await session.send("two"); expect(events.at(-1)).toMatchObject({ kind: "result", isError: false });
    await host.dispose();
  });

  it("keeps a persisted resident conversation: steers a running turn, resumes after host restart, and forgets on request", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-plugin-persist-")); roots.push(dataRoot);
    const opened: Record<string, unknown>[] = []; const homes: unknown[] = []; let push: (message: ClaudeGatewayMessage) => void = () => undefined; let closeChild = () => {}; let dieChild = () => {};
    // 자식 하나 — 보낸 말마다 스크립트가 답한다. 트랜스크립트는 Claude Code처럼 홈의 projects 아래에 쌓인다.
    let reply: (text: string, messageId?: string) => void = () => undefined;
    // 실제 SDK처럼 한 인스턴스의 슬롯은 하나이고 `close()`로만 돌아온다 — 스스로 끝난 자식도 닫지 않으면 다음 자식이 막힌다.
    const engine = (configDir: string) => { let slot = false; return { configDir, dispose: vi.fn(async () => undefined), openSession: vi.fn(async (request: Record<string, unknown>) => {
      if (slot) throw new Error("A turn or session is already running on this instance.");
      slot = true;
      opened.push(request);
      const id = (request.resume ?? request.sessionId) as string;
      await fs.mkdir(path.join(configDir, "projects", "-cwd"), { recursive: true }); await fs.writeFile(path.join(configDir, "projects", "-cwd", `${id}.jsonl`), "{}\n");
      const queue: ClaudeGatewayMessage[] = []; let wake: (() => void) | null = null; let done = false;
      push = (message) => { queue.push(message); wake?.(); }; closeChild = () => { done = true; slot = false; wake?.(); }; dieChild = () => { done = true; wake?.(); };
      return { send: (input: unknown, options?: { messageId?: string }) => reply(typeof input === "string" ? input : JSON.stringify(input), options?.messageId), close: () => closeChild(),
        async *[Symbol.asyncIterator]() { for (;;) { while (queue.length) yield queue.shift()!; if (done) return; await new Promise<void>((r) => { wake = r; }); wake = null; } } };
    }) } as unknown as ClaudeGatewaySdk; };
    const hostFor = () => createPluginAgentHost({ baseUrl: () => "http://127.0.0.1:1", consoleUse, persistRoot: () => dataRoot, createSdk: async (sdkOptions) => { homes.push(sdkOptions.home); return engine((sdkOptions.home as { configDir: string }).configDir); } });
    const persist = { key: "commodore:t1" };
    const events: AgentEvent[] = [];
    const host = hostFor();
    const session = await host.createSession({ ...options, persist, onEvent: (event) => events.push(event) });
    await expect(host.createSession({ ...options, persist })).rejects.toThrow("agent_persist_busy");
    expect(session.resumed).toBe(false);
    expect(homes[0]).toMatchObject({ kind: "persistent", configDir: expect.stringContaining(dataRoot) });

    // 턴 중 건넨 말 — 턴이 그 말을 집기 전에 닫히려 하면 결말을 쥐고, 집힌 뒤의 결말과 합쳐 한 턴으로 낸다.
    let steered: string | undefined;
    reply = (text, messageId) => {
      if (messageId) { steered = messageId; return; }
      push({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: `on ${text}` } } });
      queueMicrotask(() => {
        expect(session.steer!("also this", "m1")).toBe(true);
        push({ type: "result", is_error: false, total_cost_usd: 0.1, usage: { input_tokens: 10, output_tokens: 1 } });
        queueMicrotask(() => {
          push({ type: "command_lifecycle", command_uuid: steered, state: "started" });
          push({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "and that" } } });
          push({ type: "result", is_error: false, total_cost_usd: 0.25, usage: { input_tokens: 20, output_tokens: 2 } });
        });
      });
    };
    await session.send("first");
    expect(session.steer!("late", "m2")).toBe(false);
    expect(events.filter((event) => event.kind === "result")).toEqual([expect.objectContaining({ isError: false, usage: expect.objectContaining({ inputTokens: 30, outputTokens: 3, costUsd: 0.25 }) })]);
    expect(events.findIndex((event) => event.kind === "input-started" && event.id === "m1")).toBeLessThan(events.findIndex((event) => event.kind === "text" && event.text === "and that"));
    expect(opened[0]).toMatchObject({ sessionId: expect.any(String) });
    expect(opened[0]).not.toHaveProperty("resume");
    expect(JSON.stringify(events)).not.toContain(dataRoot);

    // 중지는 자식을 접고, 집히지 않은 말은 호출자에게 돌려준다.
    reply = (_text, messageId) => { if (!messageId) queueMicrotask(() => expect(session.steer!("never read", "m3")).toBe(true)); };
    const stopped = session.send("second"); await new Promise((r) => setTimeout(r, 0)); session.cancel(); await stopped;
    expect(events.at(-1)).toEqual({ kind: "cancelled" });
    expect(events).toContainEqual({ kind: "input-cancelled", id: "m3" });

    // Console 재시작 — 같은 key는 같은 대화를 resume한다. 자리는 폐기가 지우지 않는다.
    await host.dispose();
    const restarted = hostFor();
    const resumed = await restarted.createSession({ ...options, persist, onEvent: () => undefined });
    expect(resumed.resumed).toBe(true);
    reply = () => push({ type: "result", is_error: false });
    await resumed.send("third");
    expect(opened.at(-1)).toEqual(expect.objectContaining({ resume: (opened[0] as { sessionId: string }).sessionId }));
    // 자식이 스스로 죽었다(close 없이 스트림이 끝남) — 다음 턴은 슬롯을 되찾아 같은 대화를 다시 resume한다.
    dieChild(); await new Promise((r) => setTimeout(r, 0));
    const before = opened.length;
    await resumed.send("after a crash");
    expect(opened).toHaveLength(before + 1);
    expect(opened.at(-1)).toEqual(expect.objectContaining({ resume: (opened[0] as { sessionId: string }).sessionId }));
    // 버리기 — 열린 세션을 닫고 자리를 지운다. 다음은 새 대화다.
    await restarted.forget!(persist.key);
    const fresh = await restarted.createSession({ ...options, persist });
    expect(fresh.resumed).toBe(false);
    await restarted.dispose();
  });

  it("shares only opted-in peer registries while preserving isolated history and safe forget", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-plugin-peers-")); roots.push(dataRoot);
    const homes: string[] = []; const requests: Record<string, unknown>[] = [];
    const host = createPluginAgentHost({ baseUrl: () => "http://127.0.0.1:1", consoleUse, persistRoot: () => dataRoot,
      createSdk: async ({ home }) => {
        const configDir = (home as { configDir: string }).configDir; homes.push(configDir); await fs.mkdir(configDir, { recursive: true });
        return { configDir, dispose: async () => undefined, openSession: async (request: Record<string, unknown>) => {
          requests.push(request); let close!: () => void; let sent!: () => void;
          const closed = new Promise<void>((resolve) => { close = resolve; }); const input = new Promise<void>((resolve) => { sent = resolve; });
          return { send: sent, close, async *[Symbol.asyncIterator]() { await input; yield { type: "result", is_error: false }; await closed; } };
        } } as unknown as ClaudeGatewaySdk;
      },
    });
    try {
      // 이미 쓰던 대화: 등록부가 생기기 전의 projects 와 로컬 등록부를 남긴다.
      const a = { key: "commodore:a" }; const old = await host.createSession({ ...options, persist: a }); await old.send("first");
      const firstHome = homes[0]!;
      const history = path.join(firstHome, "projects", "-cwd", `${requests[0]!.sessionId}.jsonl`);
      await fs.mkdir(path.dirname(history), { recursive: true }); await fs.writeFile(history, "history\n");
      await fs.mkdir(path.join(firstHome, "sessions")); await fs.writeFile(path.join(firstHome, "sessions", "stale.json"), "old registry");
      await old.dispose();
      const tools = { builtins: ["SendMessage", "ListAgents"] as const };
      const first = await host.createSession({ ...options, persist: a, sessionName: "commodore-a", tools });
      expect(first.resumed).toBe(true); await first.send("after upgrade");
      expect(requests.at(-1)).toMatchObject({ sessionName: "commodore-a", tools: ["SendMessage", "ListAgents"], allowedTools: ["SendMessage", "ListAgents"], permissionMode: "dontAsk", resume: requests[0]!.sessionId });
      const second = await host.createSession({ ...options, persist: { key: "commodore:b" }, sessionName: "commodore-b", tools });
      const secondHome = homes.at(-1)!;
      const plain = await host.createSession({ ...options, persist: { key: "plain" } }); const plainHome = homes.at(-1)!; await plain.send("ordinary");
      expect(requests.at(-1)).toMatchObject({ tools: [], allowedTools: [] }); expect(requests.at(-1)).not.toHaveProperty("sessionName");
      expect(firstHome).not.toBe(secondHome);
      expect(await fs.realpath(path.join(firstHome, "sessions"))).toBe(await fs.realpath(path.join(secondHome, "sessions")));
      await expect(fs.lstat(path.join(plainHome, "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(history, "utf8")).toBe("history\n");
      const backup = (await fs.readdir(firstHome)).find((entry) => entry.startsWith("sessions.isolated-"))!;
      expect(await fs.readFile(path.join(firstHome, backup, "stale.json"), "utf8")).toBe("old registry");
      await fs.writeFile(path.join(secondHome, "sessions", "peer.json"), "peer remains");
      await host.forget!(a.key);
      expect(await fs.readFile(path.join(secondHome, "sessions", "peer.json"), "utf8")).toBe("peer remains");
      const shared = await fs.realpath(path.join(secondHome, "sessions"));
      await second.dispose(); await host.createSession({ ...options, persist: { key: "commodore:b" } });
      expect((await fs.lstat(path.join(secondHome, "sessions"))).isSymbolicLink()).toBe(false);
      expect(await fs.readFile(path.join(shared, "peer.json"), "utf8")).toBe("peer remains");
      // 모르는 목적지를 가리키는 기존 링크는 덮거나 따라가 공유 등록부로 삼지 않는다.
      await plain.dispose(); const outside = path.join(dataRoot, "outside"); await fs.mkdir(outside);
      await fs.symlink(outside, path.join(plainHome, "sessions"), process.platform === "win32" ? "junction" : "dir");
      await expect(host.createSession({ ...options, persist: { key: "plain" }, tools })).rejects.toThrow("agent_peer_registry_conflict");
      expect(await fs.realpath(path.join(plainHome, "sessions"))).toBe(await fs.realpath(outside));
    } finally { await host.dispose(); }
  });

  it("rejects unavailable gateways and rolls back SDK creation racing host disposal", async () => {
    let root!: string; const unavailable = createPluginAgentHost({ baseUrl: () => null, consoleUse });
    await expect(unavailable.createSession(options)).rejects.toThrow("agent_gateway_unavailable");
    let release!: (value: ClaudeGatewaySdk) => void; let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; }); const gate = new Promise<ClaudeGatewaySdk>(r => { release = r; });
    const engine = sdk(async () => run([]));
    const host = createPluginAgentHost({ baseUrl: () => "http://127.0.0.1:1", consoleUse, createSdk: ({ tempRoot }) => { root = tempRoot!; roots.push(root); entered(); return gate; } });
    const creating = host.createSession(options); const rejected = expect(creating).rejects.toThrow("disposed");
    await started; const disposing = host.dispose(); release(engine); await rejected; await disposing;
    expect(engine.dispose).toHaveBeenCalledOnce(); await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

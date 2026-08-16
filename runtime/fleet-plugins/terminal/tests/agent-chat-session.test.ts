import { mkdirSync, mkdtempSync, promises as nodeFs, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentChatRegistry, type AgentChatSessionSeed } from "../server/agent-api/chat-session.js";
import type { AgentChatJournalEvent } from "../server/agent-api/chat-events.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

/** 원 세션 트랜스크립트 픽스처 — <홈>/projects/<인코딩 cwd>/<sid>.jsonl 모양 그대로. */
function writeTranscript(sessionId: string, lines: readonly unknown[]): string {
  const root = tempDir("chat-origin-");
  const projectDir = path.join(root, "projects", "-tmp-workspace");
  mkdirSync(projectDir, { recursive: true });
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, lines.map((line) => JSON.stringify(line)).join("\n"));
  return transcriptPath;
}

/** 트랜스크립트가 앉은 Claude 홈. `<홈>/projects/<프로젝트>/<sid>.jsonl`을 세 번 되짚는다. */
function homeOf(transcriptPath: string): string {
  return path.dirname(path.dirname(path.dirname(transcriptPath)));
}

type FakeTurn = { readonly messages: readonly Record<string, unknown>[]; readonly failAfter?: number };

function createFakeSdkFactory(turns: FakeTurn[]) {
  const configDir = tempDir("chat-sdk-");
  const startTurn = vi.fn(async (_turn: unknown) => {
    const script = turns.shift() ?? { messages: [] };
    const close = vi.fn();
    let index = 0;
    return {
      close,
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (script.failAfter !== undefined && index >= script.failAfter) throw new Error("provider exploded");
            if (index >= script.messages.length) return { done: true as const, value: undefined };
            return { done: false as const, value: script.messages[index++] };
          },
        };
      },
    };
  });
  const dispose = vi.fn(async () => {});
  const factory = vi.fn(async ({ models }: { readonly baseUrl: string; readonly models: readonly string[] }) => ({
    configDir,
    models,
    startTurn,
    dispose,
  }));
  return { factory: factory as never, startTurn, dispose, configDir };
}

function seedFor(transcriptPath: string, onProviderSessionUpdate: AgentChatSessionSeed["onProviderSessionUpdate"] = () => {}): AgentChatSessionSeed {
  return {
    baseUrl: "http://127.0.0.1:9/gateway",
    model: "opus[1m]",
    effort: "high",
    cwd: "/tmp/workspace",
    claudeConfigDir: homeOf(transcriptPath),
    origin: { kind: "resume", transcriptPath },
    onProviderSessionUpdate,
    reportActivity: () => true,
    canReportActivity: () => true,
    reportAwaiting: () => {},
  };
}

/** 채팅으로 태어난 세션의 시드 — 이어붙일 트랜스크립트가 없고 홈만 안다. */
function freshSeedFor(claudeConfigDir: string, onProviderSessionUpdate: AgentChatSessionSeed["onProviderSessionUpdate"] = () => {}): AgentChatSessionSeed {
  return {
    baseUrl: "http://127.0.0.1:9/gateway",
    model: "opus[1m]",
    effort: "high",
    cwd: "/tmp/workspace",
    claudeConfigDir,
    origin: { kind: "fresh" },
    onProviderSessionUpdate,
    reportActivity: () => true,
    canReportActivity: () => true,
    reportAwaiting: () => {},
  };
}

async function drainTurn(registry: AgentChatRegistry, operationId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(registry.isBusy(operationId)).toBe(false);
  });
}

function kinds(events: readonly AgentChatJournalEvent[]): readonly string[] {
  return events.map((entry) => entry.event.kind);
}

describe("AgentChatRegistry — chat-born sessions", () => {
  it("starts the first turn without a resume coordinate and replays nothing", async () => {
    const home = tempDir("chat-home-");
    const { factory, startTurn } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 10 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => freshSeedFor(home));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    // 되돌려줄 과거가 없다는 것은 "읽지 못했다"와 다르다 — replay 이벤트도 오류도 내지 않는다.
    expect(kinds(events)).toEqual([]);

    session.send("let us talk about the render path");
    await drainTurn(registry, "op-1");

    const turn = startTurn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(turn.prompt).toBe("let us talk about the render path");
    expect("resume" in turn).toBe(false);
    await registry.disposeAll();
  });

  it("publishes the coordinate of the transcript the sdk grew in the shared home", async () => {
    const home = tempDir("chat-home-");
    const updates: unknown[] = [];
    const { configDir } = createFakeSdkFactory([]);
    // 실제 SDK처럼 공유 홈 안에 트랜스크립트를 만든다 — 옮겨 올 사본이 없고, 좌표만 확정된다.
    const startTurn = vi.fn(async () => {
      const projectDir = path.join(home, "projects", "-tmp-workspace");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(path.join(projectDir, "born-1.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }));
      const messages = [
        { type: "system", subtype: "init", session_id: "born-1" },
        { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
      ];
      let index = 0;
      return {
        close: () => {},
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (index >= messages.length) return { done: true as const, value: undefined };
              return { done: false as const, value: messages[index++] };
            },
          };
        },
      };
    });
    const bornFactory = (vi.fn(async () => ({ configDir, startTurn, dispose: async () => {} })) as never);
    const registry = new AgentChatRegistry(bornFactory);
    const session = await registry.ensure("op-1", () => freshSeedFor(home, (providerSession) => updates.push(providerSession)));
    session.send("hello");
    await drainTurn(registry, "op-1");

    // cwd 인코딩을 재구현하지 않는다 — 세션 id로 홈 안을 훑어 우리 파일을 찾는다.
    expect(updates).toEqual([expect.objectContaining({
      provider: "claude",
      sessionId: "born-1",
      transcriptPath: path.join(home, "projects", "-tmp-workspace", "born-1.jsonl"),
      source: "chat-mode",
    })]);
    await registry.disposeAll();
  });

  it("hands the sdk the shared home so the transcript grows where the terminal reads it", async () => {
    const home = tempDir("chat-home-");
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 3 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-home", () => freshSeedFor(home));
    session.send("go");
    await drainTurn(registry, "op-home");

    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      home: { kind: "shared", configDir: home },
    }));
    await registry.disposeAll();
  });

  // 스킬·게이트웨이 정체성·정책 훅은 플러그인 한 벌로 실린다. 설정 층까지 같아야 같은 세션을
  // 터미널로 열었을 때와 능력이 갈리지 않는다.
  it("loads the Fleet plugin and reads the same setting layers the terminal reads", async () => {
    const home = tempDir("chat-home-");
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 3 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-plugin", () => ({
      ...freshSeedFor(home),
      resolveFleetPluginRoots: async () => ["/fleet/marketplace/plugins/fleet-gateway"],
    }));
    session.send("go");
    await drainTurn(registry, "op-plugin");

    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      plugins: [{ path: "/fleet/marketplace/plugins/fleet-gateway" }],
      settingSources: ["user", "project", "local"],
      allowAmbientMcpServers: true,
    }));
    await registry.disposeAll();
  });

  // doctrine 주입은 모델에게 물어서 확인할 수 없다 — 같은 지시를 `--append-system-prompt`로
  // 받는 터미널 세션조차 "그런 문자열은 없다"고 답한다(2026-08-16 실측, cursor-auto). 그래서
  // 전달 자체를 여기서 고정한다.
  it("passes the Admiral doctrine through to the turn", async () => {
    const home = tempDir("chat-home-");
    const { factory, startTurn } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 3 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-doctrine", () => ({
      ...freshSeedFor(home),
      systemPrompt: { mode: "append", text: "## Mission Anchor Standing Order" },
    }));
    session.send("go");
    await drainTurn(registry, "op-doctrine");

    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: { mode: "append", text: "## Mission Anchor Standing Order" },
    }));
    await registry.disposeAll();
  });

  // Console 자신이 Fleet 터미널에서 떴다면 그 세션 id를 상속하고 있다. 자식에게 따라가면
  // 자식의 훅이 남의 세션 축에 턴을 보고한다.
  it("keeps the inherited terminal session id out of the sdk child", async () => {
    const home = tempDir("chat-home-");
    const previous = process.env.FLEET_CONSOLE_SESSION_ID;
    process.env.FLEET_CONSOLE_SESSION_ID = "someone-elses-session";
    try {
      const { factory } = createFakeSdkFactory([
        { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 3 }] },
      ]);
      const registry = new AgentChatRegistry(factory);
      const session = await registry.ensure("op-env", () => freshSeedFor(home));
      session.send("go");
      await drainTurn(registry, "op-env");

      expect(factory).toHaveBeenCalledWith(expect.objectContaining({
        env: expect.not.objectContaining({ FLEET_CONSOLE_SESSION_ID: expect.anything() }),
      }));
      await registry.disposeAll();
    } finally {
      if (previous === undefined) delete process.env.FLEET_CONSOLE_SESSION_ID;
      else process.env.FLEET_CONSOLE_SESSION_ID = previous;
    }
  });

  // 플러그인을 못 실은 세션은 터미널로 열었을 때와 능력이 다르다. 그 차이는 화면 어디에도
  // 드러나지 않으므로 저널이 말해야 한다.
  it("surfaces an error and still starts the turn when the Fleet plugin cannot be rendered", async () => {
    const home = tempDir("chat-home-");
    const { factory, startTurn } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 3 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-plugin-fail", () => ({
      ...freshSeedFor(home),
      resolveFleetPluginRoots: async () => { throw new Error("render failed"); },
    }));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    session.send("go");
    await drainTurn(registry, "op-plugin-fail");

    expect(events.some((entry) => entry.event.kind === "error" && entry.event.code === "chat_fleet_plugin_unavailable")).toBe(true);
    expect(startTurn).toHaveBeenCalled();
    await registry.disposeAll();
  });
});

describe("AgentChatRegistry", () => {
  it("replays the origin transcript into the journal on ensure", async () => {
    const transcriptPath = writeTranscript("sid-1", [
      { type: "user", message: { role: "user", content: "first order" } },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
    ]);
    const { factory } = createFakeSdkFactory([]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => seedFor(transcriptPath));

    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    expect(kinds(events)).toEqual(["replay-start", "dispatch", "text", "replay-end"]);
    await registry.disposeAll();
  });

  // 재생 턴에는 SDK result가 없다 — 소요 시간은 트랜스크립트 줄의 시각에서 나온다.
  // 이것이 없으면 접힘 줄이 과거 턴에서만 시간을 잃고 "작업함"으로 주저앉는다.
  it("derives each replayed turn's duration from its transcript timestamps", async () => {
    const transcriptPath = writeTranscript("sid-dur", [
      { type: "user", timestamp: "2026-08-15T01:00:00.000Z", message: { role: "user", content: "first order" } },
      { type: "assistant", timestamp: "2026-08-15T01:00:12.500Z", message: { content: [{ type: "text", text: "done" }] } },
      { type: "user", timestamp: "2026-08-15T01:05:00.000Z", message: { role: "user", content: "second order" } },
      { type: "assistant", timestamp: "2026-08-15T01:05:03.000Z", message: { content: [{ type: "text", text: "done again" }] } },
    ]);
    const { factory } = createFakeSdkFactory([]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-dur", () => seedFor(transcriptPath));

    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    const ends = events.map((entry) => entry.event).filter((event) => event.kind === "turn-end");
    expect(ends).toEqual([
      { kind: "turn-end", ok: true, durationMs: 12_500 },
      { kind: "turn-end", ok: true, durationMs: 3_000 },
    ]);
    await registry.disposeAll();
  });

  // 시각이 없는 트랜스크립트에서 0초짜리 턴을 지어내지 않는다.
  it("stays silent about duration when the transcript carries no timestamps", async () => {
    const transcriptPath = writeTranscript("sid-nodur", [
      { type: "user", message: { role: "user", content: "first order" } },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
    ]);
    const { factory } = createFakeSdkFactory([]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-nodur", () => seedFor(transcriptPath));

    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));
    expect(kinds(events)).not.toContain("turn-end");
    await registry.disposeAll();
  });

  it("resumes with the session id the origin transcript's file name carries", async () => {
    const transcriptPath = writeTranscript("sid-2", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const { factory, startTurn } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 10 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => seedFor(transcriptPath));
    session.send("continue");
    await drainTurn(registry, "op-1");

    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "continue",
      resume: "sid-2",
      model: "opus[1m]",
      effort: "high",
      cwd: "/tmp/workspace",
      permissionMode: "bypassPermissions",
      // 글자 단위 스트리밍의 전제 — text_delta는 부분 메시지에만 실린다.
      includePartialMessages: true,
    }));
    await registry.disposeAll();
  });

  // 델타는 라이브 전용이다 — 저널(cap 2000)에 실으면 즉시 소진되므로, 재접속 리플레이는
  // 완성 text 이벤트(병합본)로 같은 내용을 복원한다.
  it("streams deltas to live subscribers but keeps them out of the journal", async () => {
    const transcriptPath = writeTranscript("sid-d", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const { factory } = createFakeSdkFactory([
      { messages: [
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } },
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } },
        { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
        { type: "result", subtype: "success", is_error: false, duration_ms: 4, result: "Hello" },
      ] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-delta", () => seedFor(transcriptPath));
    const live: AgentChatJournalEvent[] = [];
    const unsubscribe = session.subscribe((entry) => live.push(entry));
    session.send("go");
    await drainTurn(registry, "op-delta");
    unsubscribe();

    expect(kinds(live).filter((kind) => kind === "text-delta")).toHaveLength(2);
    expect(live.map((entry) => entry.event)).toContainEqual({ kind: "turn-end", ok: true, durationMs: 4, answer: "Hello" });

    const replayed: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => replayed.push(entry))();
    expect(kinds(replayed)).not.toContain("text-delta");
    expect(replayed.map((entry) => entry.event)).toContainEqual({ kind: "text", text: "Hello" });
    await registry.disposeAll();
  });

  it("reports the provider session for the transcript the sdk grew in place", async () => {
    const transcriptPath = writeTranscript("sid-3", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const updates: unknown[] = [];
    // 공유 홈에서는 SDK가 원본 파일을 그대로 키운다 — 복사해 들어갈 사본도, 되쓸 목적지도 없다.
    const factory = (async () => ({
      configDir: homeOf(transcriptPath),
      models: ["opus[1m]"],
      startTurn: async () => {
        writeFileSync(transcriptPath, `${readFileSync(transcriptPath, "utf8")}\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "grown" }] } })}`);
        const messages = [
          { type: "system", subtype: "init", session_id: "sid-3" },
          { type: "result", subtype: "success", is_error: false },
        ];
        let index = 0;
        return {
          close: () => {},
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (index >= messages.length) return { done: true as const, value: undefined };
                return { done: false as const, value: messages[index++] };
              },
            };
          },
        };
      },
      dispose: async () => {},
    })) as never;
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => seedFor(transcriptPath, (providerSession) => updates.push(providerSession)));

    session.send("continue");
    await drainTurn(registry, "op-1");

    expect(readFileSync(transcriptPath, "utf8")).toContain("grown");
    expect(updates.at(-1)).toEqual(expect.objectContaining({
      provider: "claude",
      sessionId: "sid-3",
      transcriptPath,
      source: "chat-mode",
    }));
    await registry.disposeAll();
  });

  it("releases the turn slot on provider failure and keeps accepting sends", async () => {
    const transcriptPath = writeTranscript("sid-4", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const { factory, startTurn } = createFakeSdkFactory([
      { messages: [{ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }], failAfter: 1 },
      { messages: [{ type: "result", subtype: "success", is_error: false }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("first");
    await drainTurn(registry, "op-1");
    expect(kinds(events)).toContain("error");
    expect(events.some((entry) => entry.event.kind === "turn-end" && entry.event.ok === false)).toBe(true);

    session.send("second");
    await drainTurn(registry, "op-1");
    expect(startTurn).toHaveBeenCalledTimes(2);
    await registry.disposeAll();
  });

  // 이 결함이 조용했던 이유는 턴이 도는데 활동축이 그것을 모르는 상태가 성립했기 때문이다.
  // 축이 보고를 받지 못하면 일을 시작하지 않는 쪽을 고른다 — 그래야 실패가 시끄럽다.
  it("refuses to start a turn when the activity axis cannot take the report", async () => {
    const transcriptPath = writeTranscript("sid-activity", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const { factory, startTurn } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => ({ ...seedFor(transcriptPath), reportActivity: () => false, canReportActivity: () => false }));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    expect(session.canReportActivity()).toBe(false);
    session.send("first");
    await drainTurn(registry, "op-1");

    expect(startTurn).not.toHaveBeenCalled();
    expect(events.some((entry) => entry.event.kind === "error" && entry.event.code === "chat_activity_unavailable")).toBe(true);
    expect(events.some((entry) => entry.event.kind === "turn-end" && entry.event.ok === false)).toBe(true);
    await registry.disposeAll();
  });

  it("probes the activity axis without writing a transition", async () => {
    const transcriptPath = writeTranscript("sid-probe", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false }] },
    ]);
    const reported: boolean[] = [];
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => ({
      ...seedFor(transcriptPath),
      reportActivity: (working: boolean) => { reported.push(working); return true; },
      canReportActivity: () => true,
    }));

    expect(session.canReportActivity()).toBe(true);
    // 확인만으로는 축에 아무것도 쓰이지 않아야 한다 — 쓰면 진행 중인 턴이 유휴로 방송된다.
    expect(reported).toEqual([]);
    await registry.disposeAll();
  });

  it("reports working around the SDK turn and clears it on both success and failure", async () => {
    const transcriptPath = writeTranscript("sid-pulse", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false }] },
      { messages: [{ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }], failAfter: 1 },
    ]);
    const reported: boolean[] = [];
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => ({
      ...seedFor(transcriptPath),
      reportActivity: (working: boolean) => { reported.push(working); return true; },
      canReportActivity: () => true,
    }));

    session.send("first");
    await drainTurn(registry, "op-1");
    expect(reported).toEqual([true, false]);

    // 실패한 턴도 종료 pulse 를 남긴다 — 남기지 않으면 축이 영영 running 으로 굳는다.
    session.send("second");
    await drainTurn(registry, "op-1");
    expect(reported).toEqual([true, false, true, false]);
    await registry.disposeAll();
  });

  it("skips the provider session update when no transcript carries the session id", async () => {
    const transcriptPath = writeTranscript("sid-6", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const updates: unknown[] = [];
    const factory = (async () => ({
      configDir: homeOf(transcriptPath),
      models: ["opus[1m]"],
      startTurn: async () => {
        // 턴은 돌았지만 그 세션의 파일이 홈 어디에도 없다 — 밖에서 치워진 상황이다. 없는 파일을
        // durable 권위로 심으면 터미널 복귀와 Analyst가 조용히 세션을 잃는다.
        rmSync(path.dirname(transcriptPath), { recursive: true, force: true });
        const messages = [{ type: "result", subtype: "success", is_error: false }];
        let index = 0;
        return {
          close: () => {},
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (index >= messages.length) return { done: true as const, value: undefined };
                return { done: false as const, value: messages[index++] };
              },
            };
          },
        };
      },
      dispose: async () => {},
    })) as never;
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => seedFor(transcriptPath, (providerSession) => updates.push(providerSession)));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("continue");
    await drainTurn(registry, "op-1");

    expect(updates).toEqual([]);
    expect(events.some((entry) => entry.event.kind === "error")).toBe(false);
    await registry.disposeAll();
  });

  it("dispose waits for an in-flight ensure so no chat session survives it", async () => {
    const transcriptPath = writeTranscript("sid-7", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const sdkDispose = vi.fn(async () => {});
    const factory = (async () => ({
      configDir: tempDir("chat-sdk-"),
      models: ["opus[1m]"],
      startTurn: async () => { throw new Error("unused"); },
      dispose: sdkDispose,
    })) as never;
    const registry = new AgentChatRegistry(factory);

    const ensureFlight = registry.ensure("op-1", () => seedFor(transcriptPath));
    await registry.dispose("op-1");

    await ensureFlight.catch(() => undefined);
    expect(registry.has("op-1")).toBe(false);
    await registry.disposeAll();
  });

  it("dispose closes a stalled active turn instead of waiting for it", async () => {
    const transcriptPath = writeTranscript("sid-8", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    // 닫히기 전에는 영원히 다음 메시지를 내지 않는 런 — close()가 유일한 탈출구다(실 SDK 계약).
    let closed = false;
    let wake: () => void = () => {};
    const run = {
      close: () => {
        closed = true;
        wake();
      },
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (!closed) await new Promise<void>((resolve) => { wake = resolve; });
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const factory = (async () => ({
      configDir: tempDir("chat-sdk-"),
      models: ["opus[1m]"],
      startTurn: async () => run,
      dispose: async () => { run.close(); },
    })) as never;
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => seedFor(transcriptPath));
    session.send("stalls forever");
    await vi.waitFor(() => {
      expect(registry.isBusy("op-1")).toBe(true);
    });

    // 순서가 뒤집혀 있으면(턴 완주 대기 → sdk.dispose) 여기서 영원히 멈춘다.
    await registry.dispose("op-1");
    expect(registry.has("op-1")).toBe(false);
  });

  it("rejects a new ensure while disposal is in progress", async () => {
    const transcriptPath = writeTranscript("sid-9", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    let releaseDispose: () => void = () => {};
    const factory = (async () => ({
      configDir: tempDir("chat-sdk-"),
      models: ["opus[1m]"],
      startTurn: async () => { throw new Error("unused"); },
      dispose: async () => new Promise<void>((resolve) => { releaseDispose = resolve; }),
    })) as never;
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => seedFor(transcriptPath));
    // sdk를 실제로 만들어 두어야 dispose가 sdk.dispose에서 머문다.
    session.send("boot the sdk");
    await drainTurn(registry, "op-1");

    const disposal = registry.dispose("op-1");
    await expect(registry.ensure("op-1", () => seedFor(transcriptPath))).rejects.toThrow("chat_session_disposing");
    releaseDispose();
    await disposal;
    // dispose가 끝난 뒤에는 다시 만들 수 있다(모드 재진입).
    const recreated = await registry.ensure("op-1", () => seedFor(transcriptPath));
    expect(recreated).toBeTruthy();
    await registry.disposeAll();
  });

  it("reports busy while a turn is in flight", async () => {
    const transcriptPath = writeTranscript("sid-5", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const configDir = tempDir("chat-sdk-");
    const factory = (async () => ({
      configDir,
      models: ["opus[1m]"],
      startTurn: async () => ({
        close: () => {},
        [Symbol.asyncIterator]() {
          let done = false;
          return {
            async next() {
              if (done) return { done: true as const, value: undefined };
              await gate;
              done = true;
              return { done: false as const, value: { type: "result", subtype: "success", is_error: false } };
            },
          };
        },
      }),
      dispose: async () => {},
    })) as never;
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-1", () => seedFor(transcriptPath));
    session.send("long turn");
    await vi.waitFor(() => {
      expect(registry.isBusy("op-1")).toBe(true);
    });
    release();
    await drainTurn(registry, "op-1");
    await registry.disposeAll();
  });
});

describe("AgentChatRegistry — background follow-up turns", () => {
  it("closes the follow-up turn when the stream ends without a second result", async () => {
    // 백그라운드 작업이 끝나 모델이 다시 말하기 시작했지만, 두 번째 result가 오기 전에 스트림이
    // 끝난다. 이때 아무도 그 턴을 닫지 않으면 원장에 영원히 도는 스피너가 남는다.
    const transcriptPath = writeTranscript("sid-follow-1", []);
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "result", subtype: "success", is_error: false, duration_ms: 10 },
          { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "the workflow finished" }] } },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-follow-1", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("go");
    await drainTurn(registry, "op-follow-1");

    const live = kinds(events).slice(kinds(events).indexOf("dispatch"));
    expect(live).toEqual(["dispatch", "turn-start", "turn-end", "turn-start", "text", "turn-end"]);
    await registry.disposeAll();
  });

  it("closes the follow-up turn when the stream throws after it opened", async () => {
    const transcriptPath = writeTranscript("sid-follow-2", []);
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "result", subtype: "success", is_error: false, duration_ms: 10 },
          { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "the workflow finished" }] } },
        ],
        failAfter: 2,
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-follow-2", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("go");
    await drainTurn(registry, "op-follow-2");

    const live = kinds(events).slice(kinds(events).indexOf("dispatch"));
    expect(live).toEqual(["dispatch", "turn-start", "turn-end", "turn-start", "text", "error", "turn-end"]);
    const last = events.at(-1)?.event;
    expect(last).toEqual({ kind: "turn-end", ok: false });
    await registry.disposeAll();
  });

  it("does not close a turn twice when the stream ends right after its result", async () => {
    const transcriptPath = writeTranscript("sid-follow-3", []);
    const { factory } = createFakeSdkFactory([
      { messages: [{ type: "result", subtype: "success", is_error: false, duration_ms: 10 }] },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-follow-3", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("go");
    await drainTurn(registry, "op-follow-3");

    const live = kinds(events).slice(kinds(events).indexOf("dispatch"));
    expect(live).toEqual(["dispatch", "turn-start", "turn-end"]);
    await registry.disposeAll();
  });

  it("does not open a turn for background pulses that arrive after the turn closed", async () => {
    // 맥박은 턴이 닫힌 뒤에도 계속 흐르는 것이 정상이다 — 그것으로 턴을 열면 빈 턴이 선다.
    const transcriptPath = writeTranscript("sid-follow-4", []);
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "result", subtype: "success", is_error: false, duration_ms: 10 },
          { type: "system", subtype: "task_progress", task_id: "w1", usage: { total_tokens: 5, tool_uses: 0, duration_ms: 9 } },
          { type: "system", subtype: "task_notification", task_id: "w1", status: "completed", summary: "done" },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-follow-4", () => seedFor(transcriptPath));
    const events: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => events.push(entry));

    session.send("go");
    await drainTurn(registry, "op-follow-4");

    const live = kinds(events).slice(kinds(events).indexOf("dispatch"));
    expect(live).toEqual(["dispatch", "turn-start", "turn-end", "job-progress", "job-end"]);
    await registry.disposeAll();
  });
});

describe("AgentChatRegistry — journal weight", () => {
  it("keeps only the latest progress snapshot per job in the replayed journal", async () => {
    // 맥박은 스냅숏이다 — 겹겹이 쌓으면 재접속이 이미 지나간 단계 트리를 되재생하고, 상한에
    // 걸린 세션에서는 그 무게가 되돌릴 수 없는 이력을 앞에서부터 밀어낸다.
    const transcriptPath = writeTranscript("sid-pulse-1", []);
    const pulse = (id: string, tokens: number) => ({
      type: "system", subtype: "task_progress", task_id: id,
      usage: { total_tokens: tokens, tool_uses: 0, duration_ms: tokens },
    });
    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "w1", description: "one", task_type: "local_workflow" },
          { type: "system", subtype: "task_started", task_id: "w2", description: "two", task_type: "local_workflow" },
          pulse("w1", 1), pulse("w1", 2), pulse("w2", 10), pulse("w1", 3), pulse("w2", 20),
          { type: "result", subtype: "success", is_error: false, duration_ms: 10 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-pulse-1", () => seedFor(transcriptPath));
    session.send("go");
    await drainTurn(registry, "op-pulse-1");

    // 재접속이 받는 것은 저널 전체다.
    const replayed: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => replayed.push(entry));
    const progress = replayed
      .map((entry) => entry.event)
      .filter((event): event is Extract<typeof event, { kind: "job-progress" }> => event.kind === "job-progress");
    expect(progress).toEqual([
      { kind: "job-progress", id: "w1", tokens: 3, tools: 0, durationMs: 3 },
      { kind: "job-progress", id: "w2", tokens: 20, tools: 0, durationMs: 20 },
    ]);
    // 되돌릴 수 없는 이력은 그대로 남는다.
    expect(kinds(replayed).filter((kind) => kind === "job")).toHaveLength(2);
    await registry.disposeAll();
  });
});

/**
 * 사용자가 도는 턴을 끊는 자리.
 *
 * 이 축의 요점은 결말의 이름이다 — 중지는 실패가 아니다. 원장이 둘을 같은 자리에 두면 사용자가
 * 자기가 누른 버튼의 결과를 고장으로 읽는다.
 */
describe("AgentChatRegistry — stopping a turn", () => {
  /** 스스로 끝나지 않는 턴. close()가 이터레이터를 풀어 주는 실제 런의 동작을 그대로 흉내 낸다. */
  function createHangingSdkFactory() {
    const configDir = tempDir("chat-stop-");
    const closes: number[] = [];
    let started = 0;
    const startTurn = vi.fn(async () => {
      const index = started++;
      let release: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      return {
        close: () => {
          closes.push(index);
          release?.();
        },
        [Symbol.asyncIterator]() {
          return {
            async next() {
              await gate;
              return { done: true as const, value: undefined };
            },
          };
        },
      };
    });
    const factory = vi.fn(async ({ models }: { readonly baseUrl: string; readonly models: readonly string[] }) => ({
      configDir,
      models,
      startTurn,
      dispose: vi.fn(async () => {}),
    }));
    return { factory: factory as never, startTurn, closes, startedCount: () => started };
  }

  it("closes the run and closes the turn as stopped, not failed", async () => {
    const transcriptPath = writeTranscript("sess-stop", []);
    const { factory, closes } = createHangingSdkFactory();
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-stop-1", () => seedFor(transcriptPath));

    const seen: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => seen.push(entry));

    session.send("go");
    await vi.waitFor(() => { expect(kinds(seen)).toContain("turn-start"); });

    expect(session.stopTurn()).toBe(true);
    await drainTurn(registry, "op-stop-1");

    // 중지 경로와 턴 종료의 finally가 각각 close한다. 계약상 두 번 불러도 안전하고, 둘 중
    // 어느 쪽만 남아도 슬롯이 반납되어야 하므로 이 중복은 의도된 것이다 — 세는 것은 "끊겼는가"다.
    expect(closes.length).toBeGreaterThanOrEqual(1);
    const end = seen.map((entry) => entry.event).find((event) => event.kind === "turn-end");
    expect(end).toEqual({ kind: "turn-end", ok: false, stopped: true });
    // 중지는 오류 줄을 세우지 않는다 — 사용자가 스스로 한 일에 고장 표식을 붙이지 않는다.
    expect(kinds(seen)).not.toContain("error");
    await registry.disposeAll();
  });

  it("drops turns that were queued behind the stopped one", async () => {
    // 큐에 밀려 있던 턴이 중지 직후 태연히 시작하면, 사용자가 멈춘 것은 화면에서 멈추지 않는다.
    const transcriptPath = writeTranscript("sess-stop-queue", []);
    const { factory, startedCount } = createHangingSdkFactory();
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-stop-2", () => seedFor(transcriptPath));

    const seen: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => seen.push(entry));

    session.send("first");
    session.send("second");
    await vi.waitFor(() => { expect(kinds(seen)).toContain("turn-start"); });

    expect(session.stopTurn()).toBe(true);
    await drainTurn(registry, "op-stop-2");

    expect(startedCount()).toBe(1);
    const dispatches = seen.map((entry) => entry.event).filter((event) => event.kind === "dispatch");
    expect(dispatches).toHaveLength(1);
    await registry.disposeAll();
  });

  it("refuses when there is no turn to stop", async () => {
    // 끊을 것이 없는데 성공을 돌려주면 화면이 멈춤을 그리고 아무 일도 일어나지 않는다.
    const transcriptPath = writeTranscript("sess-stop-idle", []);
    const { factory } = createHangingSdkFactory();
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-stop-3", () => seedFor(transcriptPath));
    expect(session.stopTurn()).toBe(false);
    await registry.disposeAll();
  });
});

/**
 * 잡 상세를 읽는 자리.
 *
 * 셸 출력의 좌표는 우리가 재구성할 수 없다 — 실측에서 그 파일은 격리 config dir이 아니라 CLI가
 * 고른 **별개의 임시 뿌리** 아래 앉았다. `task_notification.output_file`이 알려 주는 경로가
 * 유일한 권위이고, 그 경로는 호스트 절대 경로라 브라우저로 나가서는 안 된다.
 */
describe("AgentChatRegistry — job detail", () => {
  it("reads a shell tail from the path the notification announced, not a reconstructed one", async () => {
    const transcriptPath = writeTranscript("sess-detail", []);
    // 알림이 가리키는 파일을 config dir 바깥에 둔다 — 재구성한 경로로는 절대 닿을 수 없는 자리다.
    const outputRoot = tempDir("chat-task-out-");
    const outputFile = path.join(outputRoot, "b7chatty.output");
    writeFileSync(outputFile, "tick 1\ntick 2\ntick 3\n");

    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "b7chatty", description: "loop", task_type: "local_bash" },
          { type: "system", subtype: "task_notification", task_id: "b7chatty", status: "completed", output_file: outputFile, summary: "done" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-detail-1", () => seedFor(transcriptPath));
    session.send("go");
    await drainTurn(registry, "op-detail-1");

    const detail = await session.readJobDetail("b7chatty");
    expect(detail).toEqual({ kind: "shell", tail: "tick 1\ntick 2\ntick 3", truncated: false });

    // 저널 어디에도 그 절대 경로가 실리지 않는다 — 브라우저로 나가는 것은 저널이다.
    const journal: AgentChatJournalEvent[] = [];
    session.subscribe((entry) => journal.push(entry));
    expect(JSON.stringify(journal)).not.toContain(outputRoot);
    await registry.disposeAll();
  });

  it("refuses a job coordinate the session never issued", async () => {
    // 브라우저가 건네는 유일한 값이다. SDK가 발급한 적 없는 좌표는 파일 시스템에 닿기 전에 막힌다.
    const transcriptPath = writeTranscript("sess-detail-guard", []);
    const { factory } = createFakeSdkFactory([{ messages: [] }]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-detail-2", () => seedFor(transcriptPath));
    expect(await session.readJobDetail("../../etc/passwd")).toBeNull();
    expect(await session.readJobDetail("never-issued")).toBeNull();
    await registry.disposeAll();
  });
});

/**
 * 큰 출력 파일.
 *
 * 돌려주는 값이 작아도 파일 전체를 문자열로 올리면 그 순간의 메모리와 이벤트 루프는 파일
 * 크기만큼을 진다 — 실측에서 백그라운드 셸 출력은 이미 438KB까지 자랐고, 빌드를 백그라운드로
 * 돌리면 수십 MB가 정상 범위다.
 */
describe("AgentChatRegistry — large shell output", () => {
  it("reads only the end of the file", async () => {
    const transcriptPath = writeTranscript("sess-big", []);
    const outputRoot = tempDir("chat-task-big-");
    const outputFile = path.join(outputRoot, "b9huge.output");
    // 읽기 창(256KB)보다 확실히 큰 파일. 창 밖의 표식은 결과 어디에도 나타나지 않아야 한다 —
    // 나타난다면 파일 전체가 메모리에 올라왔다는 뜻이다.
    const filler = Array.from({ length: 40_000 }, (_, i) => `noise ${i} ${"y".repeat(40)}`).join("\n");
    writeFileSync(outputFile, `HEAD-MARKER\n${filler}\nTAIL-MARKER\n`);

    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "b9huge", description: "big", task_type: "local_bash" },
          { type: "system", subtype: "task_notification", task_id: "b9huge", status: "completed", output_file: outputFile, summary: "done" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-big-1", () => seedFor(transcriptPath));
    session.send("go");
    await drainTurn(registry, "op-big-1");

    // 내용만으로는 전체 읽기와 구별되지 않는다 — 200줄 컷이 같은 결과를 내기 때문이다.
    // 그래서 "파일 전체를 문자열로 올리지 않았다"를 직접 못 박는다.
    const readFile = vi.spyOn(nodeFs, "readFile");
    const open = vi.spyOn(nodeFs, "open");
    try {
      const detail = await session.readJobDetail("b9huge");
      expect(detail?.kind).toBe("shell");
      const tail = detail?.kind === "shell" ? detail.tail : "";
      expect(tail).toContain("TAIL-MARKER");
      expect(tail).not.toContain("HEAD-MARKER");
      expect(detail?.truncated).toBe(true);
      expect(open.mock.calls.some(([target]) => target === outputFile)).toBe(true);
      expect(readFile.mock.calls.some(([target]) => target === outputFile)).toBe(false);
    } finally {
      readFile.mockRestore();
      open.mockRestore();
    }
    await registry.disposeAll();
  });
});

/**
 * 창보다 큰 줄 하나.
 *
 * 앞선 경계-읽기 수정이 만든 결함이다: 줄 경계에 맞추려고 첫 개행까지를 버리는데, 마지막 한
 * 줄이 창보다 크면 개행이 창의 맨 끝에만 있거나 아예 없어서 버퍼 전체가 사라진다. 화면은 그때
 * 빈 꼬리를 보인다 — 잘린 줄 하나가 빈 화면보다 정직하다.
 */
describe("AgentChatRegistry — one line larger than the read window", () => {
  it("keeps the newest bytes instead of returning an empty tail", async () => {
    const transcriptPath = writeTranscript("sess-longline", []);
    const outputRoot = tempDir("chat-task-line-");
    const outputFile = path.join(outputRoot, "b1line.output");
    // 한 줄이 512KB — 창(256KB)보다 크고, 줄 끝에만 개행이 있다.
    writeFileSync(outputFile, `${"j".repeat(512 * 1024)}NEWEST-END\n`);

    const { factory } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "task_started", task_id: "b1line", description: "json", task_type: "local_bash" },
          { type: "system", subtype: "task_notification", task_id: "b1line", status: "completed", output_file: outputFile, summary: "done" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-line-1", () => seedFor(transcriptPath));
    session.send("go");
    await drainTurn(registry, "op-line-1");

    const detail = await session.readJobDetail("b1line");
    const tail = detail?.kind === "shell" ? detail.tail : null;
    expect(tail).not.toBe("");
    expect(tail).toContain("NEWEST-END");
    expect(detail?.truncated).toBe(true);
    await registry.disposeAll();
  });

  it("bounds the subagent transcript read the same way", async () => {
    const transcriptPath = writeTranscript("sess-bigtrail", []);
    const { factory, configDir } = createFakeSdkFactory([
      {
        messages: [
          { type: "system", subtype: "init", session_id: "sess-bigtrail" },
          { type: "system", subtype: "task_started", task_id: "atrail1", description: "recon", task_type: "local_agent" },
          { type: "system", subtype: "task_notification", task_id: "atrail1", status: "completed", summary: "done" },
          { type: "result", subtype: "success", is_error: false, duration_ms: 5 },
        ],
      },
    ]);
    const registry = new AgentChatRegistry(factory);
    const session = await registry.ensure("op-trail-1", () => seedFor(transcriptPath));

    // 창(4MB)보다 큰 전사록. 앞쪽 표식은 결과에 나타나면 안 된다.
    // 부산물은 트랜스크립트와 같은 홈에 앉는다 — 공유 홈에서는 SDK의 config dir이 곧 그 홈이다.
    const subagentDir = path.join(homeOf(transcriptPath), "projects", "-tmp-workspace", "sess-bigtrail", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    const line = (name: string) => JSON.stringify({
      isSidechain: true,
      type: "assistant",
      message: { content: [{ type: "tool_use", id: name, name, input: { command: "x".repeat(600) } }] },
    });
    const filler = Array.from({ length: 7_000 }, (_, i) => line(`Filler${i}`)).join("\n");
    writeFileSync(path.join(subagentDir, "agent-atrail1.jsonl"), `${line("HeadMarker")}\n${filler}\n${line("TailMarker")}\n`);

    session.send("go");
    await drainTurn(registry, "op-trail-1");

    const readFile = vi.spyOn(nodeFs, "readFile");
    try {
      const detail = await session.readJobDetail("atrail1");
      expect(detail?.kind).toBe("agent");
      const names = detail?.kind === "agent" ? detail.steps.map((step) => step.name) : [];
      expect(names).toContain("TailMarker");
      expect(names).not.toContain("HeadMarker");
      expect(detail?.truncated).toBe(true);
      expect(readFile.mock.calls.some(([target]) => String(target).includes("agent-atrail1"))).toBe(false);
    } finally {
      readFile.mockRestore();
    }
    await registry.disposeAll();
  });
});

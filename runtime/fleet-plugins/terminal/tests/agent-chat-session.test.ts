import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** 원 세션 트랜스크립트 픽스처 — projects/<인코딩 cwd>/<sid>.jsonl 모양 그대로. */
function writeTranscript(sessionId: string, lines: readonly unknown[]): string {
  const root = tempDir("chat-origin-");
  const projectDir = path.join(root, "projects", "-tmp-workspace");
  mkdirSync(projectDir, { recursive: true });
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, lines.map((line) => JSON.stringify(line)).join("\n"));
  return transcriptPath;
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
    transcriptPath,
    onProviderSessionUpdate,
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

  it("copies the transcript into the sdk config dir and resumes with the file's session id", async () => {
    const transcriptPath = writeTranscript("sid-2", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const { factory, startTurn, configDir } = createFakeSdkFactory([
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
    const copied = readFileSync(path.join(configDir, "projects", "-tmp-workspace", "sid-2.jsonl"), "utf8");
    expect(copied).toContain("first order");
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

  it("writes the grown transcript back to the origin dir and reports the provider session", async () => {
    const transcriptPath = writeTranscript("sid-3", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const updates: unknown[] = [];
    // 실제 SDK처럼 턴이 도는 동안 격리 config dir의 트랜스크립트가 자란다 — copy-in 이후에
    // 자라야 하므로 startTurn 안에서 파일을 키운다.
    const configDir = tempDir("chat-sdk-");
    const grown = path.join(configDir, "projects", "-tmp-workspace", "sid-3.jsonl");
    const factory = (async () => ({
      configDir,
      models: ["opus[1m]"],
      startTurn: async () => {
        writeFileSync(grown, `${readFileSync(grown, "utf8")}\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "grown" }] } })}`);
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

  it("skips the provider session update and surfaces an error when write-back fails", async () => {
    const transcriptPath = writeTranscript("sid-6", [
      { type: "user", message: { role: "user", content: "first order" } },
    ]);
    const updates: unknown[] = [];
    const configDir = tempDir("chat-sdk-");
    const grown = path.join(configDir, "projects", "-tmp-workspace", "sid-6.jsonl");
    const factory = (async () => ({
      configDir,
      models: ["opus[1m]"],
      startTurn: async () => {
        // SDK 트랜스크립트는 자랐지만, 원본 쪽 디렉터리가 사라져 write-back이 실패하는 상황.
        writeFileSync(grown, `${readFileSync(grown, "utf8")}\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "grown" }] } })}`);
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
    expect(events.some((entry) => entry.event.kind === "error" && entry.event.code === "chat_writeback_failed")).toBe(true);
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

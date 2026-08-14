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
    }));
    const copied = readFileSync(path.join(configDir, "projects", "-tmp-workspace", "sid-2.jsonl"), "utf8");
    expect(copied).toContain("first order");
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

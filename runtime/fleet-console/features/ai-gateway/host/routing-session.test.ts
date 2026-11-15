import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeProcessSpawner } from "@fleet-console/agent-runtime/claude";
import {
  chooseRoutingModels,
  parseRoutingAssignRequest,
  releaseAllRoutingSessions,
  releaseRoutingSession,
} from "./routing-model.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";

const difficulty = {
  instructions: ["Rate the task."],
  criteria: { low: "given", medium: "local", high: "design", xhigh: "open" },
};

interface SeenTurn {
  readonly sessionId?: string;
  readonly resume?: string;
  readonly persistSession?: boolean;
  readonly maxTurns?: number;
  readonly prompt: string;
  readonly homeKind: string;
  readonly configDir: string;
}

const spawnProcess = (() => { throw new Error("spawn"); }) as ClaudeProcessSpawner;
const originalWrite = process.stderr.write.bind(process.stderr);
let releaseHold = (): void => {};

function linesOf(chunks: readonly string[]): Array<Record<string, unknown>> {
  return chunks.flatMap((chunk) => chunk.split("\n").flatMap((line) => {
    const marker = "[fleet-routing-model] ";
    const at = line.indexOf(marker);
    if (at < 0) return [];
    return [JSON.parse(line.slice(at + marker.length)) as Record<string, unknown>];
  }));
}

afterEach(async () => {
  releaseHold();
  process.stderr.write = originalWrite;
  await releaseAllRoutingSessions();
});

function watchStderr(): string[] {
  const chunks: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return chunks;
}

function harness(options?: { readonly fail?: () => boolean; readonly holdFirst?: boolean }) {
  const turns: SeenTurn[] = [];
  let entered = 0;
  const hold = options?.holdFirst === true
    ? new Promise<void>((resolve) => { releaseHold = resolve; })
    : null;
  const createSdk = vi.fn(async (sdkOptions: { home?: { kind?: string; configDir?: string } }) => ({
    async startTurn(turn: { sessionId?: string; resume?: string; persistSession?: boolean; maxTurns?: number; prompt: string }) {
      entered += 1;
      turns.push({
        sessionId: turn.sessionId, resume: turn.resume, persistSession: turn.persistSession, maxTurns: turn.maxTurns, prompt: turn.prompt,
        homeKind: sdkOptions.home?.kind ?? "", configDir: sdkOptions.home?.configDir ?? "",
      });
      if (hold && entered === 1) await hold;
      if (options?.fail?.()) throw new Error("judge broke");
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "result" as const, subtype: "success" as const, structured_output: { t0: "c0", t0_difficulty: "low" } };
        },
        close() {},
      };
    },
    async dispose() {},
  }));
  const choose = (objectiveId: string, model = "opus[1m]", effort = "high") => chooseRoutingModels({
    objectiveId, baseUrl: "http://127.0.0.1:9/ai-gateway", judge: { model, effort },
    instructions: ["Role: assign."],
    state: { marker: objectiveId, secret: "SECRET-PROMPT-BODY" },
    criteria: { c0: "opus[1m]" }, difficulty, tasks: ["t0"], spawnProcess,
    createSdk: createSdk as never,
  });
  return { turns, choose, entered: () => entered };
}

describe("objective routing sessions", () => {
  it("rejects a routing request that has no objective id and keeps a confirmed commander assignment", () => {
    expect(parseRoutingAssignRequest({ judge: { model: "opus[1m]" }, items: [{ key: "a", prompt: "work" }] })).toBeUndefined();
    expect(parseRoutingAssignRequest({
      objectiveId: A, judge: { model: "opus[1m]", effort: "high" },
      commander: { model: "sonnet[1m]", effort: "low" }, items: [{ key: "m1", prompt: "work" }],
    })).toMatchObject({ objectiveId: A, commander: { model: "sonnet[1m]", effort: "low" } });
  });

  it("resumes one objective in order and lets another objective run beside it", async () => {
    const chunks = watchStderr();
    const { turns, choose } = harness({ holdFirst: true });
    const first = choose(A);
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const second = choose(A, "opus[1m]", "low");
    const other = choose(B);
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(turns).toHaveLength(2);
    releaseHold();
    await Promise.all([first, second, other]);
    const follow = turns.filter((turn) => turn.prompt.includes(A));
    const beside = turns.filter((turn) => turn.prompt.includes(B));
    expect(follow).toHaveLength(2);
    expect(beside).toHaveLength(1);
    expect(follow[0]).toMatchObject({ persistSession: true, maxTurns: 1, homeKind: "persistent", resume: undefined });
    expect(follow[0]!.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(follow[1]).toMatchObject({ persistSession: true, resume: follow[0]!.sessionId });
    expect(follow[1]!.sessionId).toBeUndefined();
    expect(follow[0]!.configDir).toBe(follow[1]!.configDir);
    expect(path.basename(follow[0]!.configDir)).toBe("claude");
    expect(follow[0]!.configDir.startsWith(os.tmpdir())).toBe(true);
    expect(beside[0]!.sessionId).toBeTruthy();
    expect(beside[0]!.sessionId).not.toBe(follow[0]!.sessionId);
    expect(beside[0]!.configDir).not.toBe(follow[0]!.configDir);
    const events = linesOf(chunks);
    expect(events.filter((event) => event.event === "judge_request" && event.session === "created")).toHaveLength(2);
    expect(events.some((event) => event.event === "judge_request" && event.session === "resumed" && event.turn === 2)).toBe(true);
    expect(chunks.join("")).not.toContain("SECRET-PROMPT-BODY");
  });

  it("opens a new session when the commodore model changes or the judgment fails", async () => {
    const chunks = watchStderr();
    let fail = false;
    const { turns, choose } = harness({ fail: () => fail });
    await choose(C);
    const firstHome = path.dirname(turns[0]!.configDir);
    await choose(C, "sonnet[1m]", "high");
    expect(existsSync(firstHome)).toBe(false);
    expect(turns[1]!.sessionId).toBeTruthy();
    expect(turns[1]!.sessionId).not.toBe(turns[0]!.sessionId);
    expect(turns[1]!.resume).toBeUndefined();
    fail = true;
    await expect(choose(C, "sonnet[1m]", "high")).rejects.toThrow("judge broke");
    const failedHome = path.dirname(turns[2]!.configDir);
    expect(existsSync(failedHome)).toBe(false);
    fail = false;
    await choose(C, "sonnet[1m]", "high");
    expect(turns[3]!.sessionId).toBeTruthy();
    expect(turns[3]!.resume).toBeUndefined();
    expect(turns[3]!.sessionId).not.toBe(turns[1]!.sessionId);
    const events = linesOf(chunks);
    expect(events.some((event) => event.disposeReason === "model_change")).toBe(true);
    expect(events.some((event) => event.disposeReason === "failure" && event.ok === false)).toBe(true);
    expect(chunks.join("")).not.toContain("SECRET-PROMPT-BODY");
  });

  it("removes the temp home on archive and on shutdown", async () => {
    const chunks = watchStderr();
    const archived = harness();
    await archived.choose(D);
    const archivedHome = path.dirname(archived.turns[0]!.configDir);
    await releaseRoutingSession(D);
    expect(existsSync(archivedHome)).toBe(false);
    const live = harness();
    await live.choose(A);
    const liveHome = path.dirname(live.turns[0]!.configDir);
    await releaseAllRoutingSessions();
    expect(existsSync(liveHome)).toBe(false);
    const events = linesOf(chunks);
    expect(events.some((event) => event.disposeReason === "archive")).toBe(true);
    expect(events.some((event) => event.disposeReason === "shutdown")).toBe(true);
    expect(chunks.join("")).not.toContain("SECRET-PROMPT-BODY");
  });
});

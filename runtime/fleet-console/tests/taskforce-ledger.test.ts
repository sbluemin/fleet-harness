import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTaskforceRoutes, type TaskforceRouteContext } from "../features/commodore/host/taskforce/routes.js";
import { createTaskforceStore, type TaskforceStore } from "../features/commodore/host/taskforce/store.js";
import type { TaskforceEvent } from "../features/commodore/shared/contracts/taskforce.js";
import { createCommodoreStore, type CommodoreStore } from "../features/commodore/host/store.js";
import { COALESCE_MS, createCommodoreSupervisor } from "../features/commodore/host/supervisor.js";
import type { ConsoleResidentAgentHost as AgentHost } from "../features/execution/host/agent/console-resident.js";
import type { AgentEvent } from "../features/execution/shared/agent.js";
import type { ConsoleMcpTool } from "../features/console-use/shared/tools.js";
import type { CommodoreBoardAdapter, CommodoreBoardWakeCode } from "../features/objectives/shared/commodore-board.js";
import { DEFAULT_EXPERIMENT_SETTINGS } from "../features/settings/shared/experiments.js";
import type { CommodoreEvent } from "../features/commodore/shared/contracts/types.js";

/**
 * TaskForce 원장의 필수 계약 — 덧붙인 순서대로 seq가 오르고, 재기동 복원이 같은
 * 말을 읽으며, 삭제는 TF 디렉터리째 걷는다. 판단·깨움 런타임의 전제다.
 */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function harness() {
  const consoleDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-taskforce-"));
  dirs.push(consoleDataDir);
  const events: TaskforceEvent[] = [];
  let clock = 1_000;
  const store = createTaskforceStore({ root: path.join(consoleDataDir, "taskforce"), emit: (event) => events.push(event), now: () => clock++ });
  let routeBody: unknown = {};
  let routeResult: { status: number; value: unknown } = { status: 0, value: null };
  const ctx = {
    host: {
      security: { isTerminalAuthorized: () => true },
      http: { readJsonBody: async () => routeBody, writeJson: (_res: unknown, status: number, value: unknown) => { routeResult = { status, value }; } },
    },
  } as unknown as TaskforceRouteContext;
  const route = async (name: string, body: Record<string, unknown>) => {
    routeBody = body;
    routeResult = { status: 0, value: null };
    const target = createTaskforceRoutes(ctx, store, { isKnownCommodore: () => true }).find((entry) => entry.name === name)!;
    await target.handler({ req: { method: target.method } as never, res: {} as never, pathname: `/api/v1/${name}` });
    return routeResult as { status: number; value: Record<string, unknown> };
  };
  const reopen = (): TaskforceStore =>
    createTaskforceStore({ root: path.join(consoleDataDir, "taskforce"), emit: () => undefined, now: () => clock++ });
  return { consoleDataDir, events, store, route, reopen };
}

describe("taskforce ledger", () => {
  it("appends entries with strictly increasing seq, restores them after reopen, and removes the directory on delete", async () => {
    const h = harness();
    const members = [randomUUID(), randomUUID(), randomUUID()];
    const created = await h.route("taskforce/create", { name: "출격 TF", topic: "오늘의 주제", members });
    expect(created.status).toBe(200);
    const taskforceId = (created.value.taskforce as { id: string }).id;
    expect((created.value.entry as { seq: number }).seq).toBe(1);

    // 닫힌 TF의 말은 기록에 남기기 전에 거절한다.
    expect((await h.route("taskforce/close", { taskforceId })).status).toBe(200);
    expect((await h.route("taskforce/post", { taskforceId, text: "닫힌 뒤의 말" })).status).toBe(409);
    expect((await h.route("taskforce/reopen", { taskforceId })).status).toBe(200);

    const first = await h.route("taskforce/post", { taskforceId, text: "사람의 말", mentions: [members[0]] });
    expect(first.status).toBe(200);
    const second = h.store.append(taskforceId, { speaker: { kind: "commodore", commodoreId: members[0]! }, text: "사령관의 말" });
    expect(second.entry.seq).toBeGreaterThan((first.value.entry as { seq: number }).seq);

    const page = await h.route("taskforce/read", { taskforceId });
    expect(page.status).toBe(200);
    const entries = (page.value.entries as { seq: number; text: string }[]);
    const seqs = entries.map((entry) => entry.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // 재기동 복원 — 새 저장소 인스턴스가 같은 원장을 읽는다.
    const restored = h.reopen();
    const reread = restored.readLedger(taskforceId);
    expect(reread.entries.map((entry) => [entry.seq, entry.text])).toEqual(
      entries.map((entry) => [entry.seq, entry.text]),
    );
    expect(restored.read(taskforceId)?.lastSeq).toBe(second.entry.seq);

    // 원장 사건이 순서대로 나갔다.
    expect(h.events.filter((event) => event.op === "taskforce-ledger").map((event) => event.taskforceId)).toContain(taskforceId);

    expect((await h.route("taskforce/delete", { taskforceId })).status).toBe(200);
    expect(fs.existsSync(path.join(h.consoleDataDir, "taskforce", taskforceId))).toBe(false);
    expect(h.reopen().read(taskforceId)).toBeNull();
  });
});

/**
 * TaskForce 판단 런타임의 필수 계약 — chain이 12에 닿으면 멈추고 `chain-paused`를
 * 남기며 깨우지 않는다. 자신의 말에는 스스로 깨지 않고, TF 말은 1:1 기록에 닿지 않는다.
 * 가짜 호스트·타이머 경로만 쓰고 실제 모델 호출은 없다.
 */

interface StubSession {
  readonly name: string;
  readonly sent: string[];
  readonly emit: (event: AgentEvent) => void;
  readonly finish: () => void;
  readonly tools: ReadonlyMap<string, ConsoleMcpTool>;
}

function runtimeHarness() {
  const consoleDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-taskforce-runtime-"));
  dirs.push(consoleDataDir);
  const theaterRoot = path.join(consoleDataDir, "theater");
  fs.mkdirSync(theaterRoot, { recursive: true });
  const a = randomUUID();
  const b = randomUUID();
  const commodoreEvents: CommodoreEvent[] = [];
  const tfEvents: TaskforceEvent[] = [];
  const store: CommodoreStore = createCommodoreStore({
    dirOf: (id) => (id === a || id === b ? path.join(consoleDataDir, "commodore", id) : null),
    theatersOf: () => [],
    theaterIdsOf: () => [],
    emit: (event) => commodoreEvents.push(event),
  });
  store.setAlias(a, "Alpha");
  store.setAlias(b, "Beta");
  const taskforce: TaskforceStore = createTaskforceStore({ root: path.join(consoleDataDir, "taskforce"), emit: (event) => tfEvents.push(event) });
  const sessions: StubSession[] = [];
  const agent: AgentHost = {
    createSession: async (options) => {
      const tools = new Map<string, ConsoleMcpTool>((options.tools?.custom?.find((group) => group.name === "fleet-commodore")?.tools ?? []).map((tool) => [tool.name, tool]));
      let finish = () => {};
      const entry: StubSession = {
        name: options.sessionName ?? "",
        sent: [],
        emit: (event) => options.onEvent?.(event),
        finish: () => finish(),
        tools,
      };
      sessions.push(entry);
      return {
        send: async (input) => {
          entry.sent.push(typeof input === "string" ? input : JSON.stringify(input));
          await new Promise<void>((resolve) => { finish = resolve; });
          options.onEvent?.({ kind: "result", isError: false, source: "message" });
        },
        steer: () => false,
        cancel: () => {},
        dispose: async () => {},
      };
    },
  };
  const board: CommodoreBoardAdapter = {
    tools: () => [],
    watch: () => ({ recount: () => new Map<CommodoreBoardWakeCode, number>(), scope: () => null, brief: () => null, attribute: (tool) => tool, emptyOperated: () => false, dispose: () => {} }),
    objective: () => null,
  };
  const supervisor = createCommodoreSupervisor({
    store,
    agent,
    theaterIds: () => [],
    cwd: (id) => (id === a || id === b ? theaterRoot : null),
    experiments: () => ({ ...DEFAULT_EXPERIMENT_SETTINGS, commodore: true }),
    theater: () => ({ label: "x", root: theaterRoot }),
    board: () => board,
    taskforce,
    onTaskforceEvent: (event) => tfEvents.push(event),
    emit: (event) => commodoreEvents.push(event),
  });
  return { consoleDataDir, theaterRoot, ids: { a, b }, store, taskforce, sessions, supervisor, tfEvents };
}

describe("taskforce runtime", () => {
  it("pauses the chain at 12, never self-wakes, and keeps TF traffic out of 1:1 transcripts", async () => {
    vi.useFakeTimers();
    try {
      const h = runtimeHarness();
      const { a, b } = h.ids;
      const { state: created } = h.taskforce.create({ name: "출격 TF", topic: "오늘의 주제", members: [a, b] });
      const taskforceId = created.id;
      h.supervisor.sync("started");
      // 사람의 말 — 두 성원이 판단 대상이다.
      h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: "사람의 말" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      const sendsOf = (alias: string) => h.sessions.filter((session) => session.name.includes(alias)).flatMap((session) => session.sent);
      const sessionOf = (alias: string) => h.sessions.find((session) => session.name.includes(alias))!;
      expect(sendsOf("Alpha")).toHaveLength(1);
      expect(sendsOf("Beta")).toHaveLength(1);
      expect(sendsOf("Alpha")[0]).toContain("TaskForce");
      expect(sendsOf("Alpha")[0]).toContain("사람의 말");
      expect(h.tfEvents.some((event) => event.op === "taskforce-judging" && event.judging.length === 2)).toBe(true);

      const post = async (alias: string, text: string) => {
        const tool = sessionOf(alias).tools.get("taskforce_post")!;
        const result = await tool.execute({ taskforceId, text }, { cwd: h.theaterRoot, toolCallId: `tf-${text.length}` } as never);
        expect(result).not.toMatchObject({ isError: true });
      };
      // Beta는 침묵으로 첫 턴을 끝낸다.
      sessionOf("Beta").finish();
      await vi.advanceTimersByTimeAsync(10);
      // TF로만 깬 Alpha 턴의 자유 텍스트는 1:1 기록에 남지 않는다.
      sessionOf("Alpha").emit({ kind: "text", text: "TF chatter that must not surface" });
      await post("Alpha", "Alpha의 말");
      sessionOf("Alpha").finish();
      await vi.advanceTimersByTimeAsync(10);
      // 자신의 말에는 스스로 깨지 않는다.
      expect(sendsOf("Alpha")).toHaveLength(1);
      const alphaEntries = h.store.transcriptRead(a).entries;
      expect(alphaEntries.some((entry) => entry.kind === "text")).toBe(false);
      expect(JSON.stringify(alphaEntries)).not.toContain("TF chatter that must not surface");
      expect(JSON.stringify(alphaEntries)).not.toContain("오늘의 주제");

      // chain을 12까지 쌓는다 — Beta부터 번갈아 말한다.
      const speakers = ["Beta", "Alpha", "Beta", "Alpha", "Beta", "Alpha", "Beta", "Alpha", "Beta", "Alpha", "Beta"];
      for (const [index, alias] of speakers.entries()) {
        await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
        await post(alias, `${alias}의 말 ${index}`);
        sessionOf(alias).finish();
        await vi.advanceTimersByTimeAsync(10);
      }
      const final = h.taskforce.read(taskforceId)!;
      expect(final.counts).toEqual({ person: 1, commodore: 12 });
      expect(final.chain.count).toBe(12);
      expect(final.chain.paused).toBe(true);
      const codes = h.taskforce.readLedger(taskforceId).entries.flatMap((entry) => (entry.speaker.kind === "system" ? [entry.speaker.code] : []));
      expect(codes).toContain("chain-paused");
      // 멈춘 뒤에는 깨우지 않는다 — 12번째 말을 한 Beta도, 듣는 Alpha도 새 턴이 서지 않는다.
      const betaSends = sendsOf("Beta").length;
      const alphaSends = sendsOf("Alpha").length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sendsOf("Beta")).toHaveLength(betaSends);
      expect(sendsOf("Alpha")).toHaveLength(alphaSends);
      // 1:1 기록에는 TF 말이 닿지 않았다.
      for (const id of [a, b]) {
        const entries = h.store.transcriptRead(id).entries;
        expect(entries.some((entry) => entry.kind === "text")).toBe(false);
        const dump = JSON.stringify(entries);
        expect(dump).not.toContain("오늘의 주제");
        expect(dump).not.toContain("사람의 말");
      }
      // 판단 결과 — 침묵과 말하기가 남았다. 읽을 때에도 스냅샷이 있다.
      expect(h.tfEvents.some((event) => event.op === "taskforce-judging" && event.outcomes?.[b]?.outcome === "silent")).toBe(true);
      expect(h.tfEvents.some((event) => event.op === "taskforce-judging" && event.outcomes?.[a]?.outcome === "spoke")).toBe(true);
      const snapshot = h.taskforce.read(taskforceId)?.judging;
      expect(snapshot?.judging).toEqual([]);
      expect(snapshot?.outcomes?.[a]?.outcome).toBe("spoke");
      expect(snapshot?.outcomes?.[b]?.outcome).toBe("spoke");
      const listed = h.taskforce.list().find((row) => row.id === taskforceId)!;
      expect(listed.counts).toEqual({ person: 1, commodore: 12 });
      expect(listed.judging).toEqual([]);
      // 재기동 복원 — 말 수와 판단 스냅샷이 함께 돌아온다.
      const restored = createTaskforceStore({ root: path.join(h.consoleDataDir, "taskforce"), emit: () => undefined });
      expect(restored.read(taskforceId)?.counts).toEqual({ person: 1, commodore: 12 });
      expect(restored.read(taskforceId)?.judging?.outcomes?.[a]?.outcome).toBe("spoke");
      await h.supervisor.dispose();
    } finally { vi.useRealTimers(); }
  });
});

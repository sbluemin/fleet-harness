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
import type { AgentEvent, AgentInputBlock } from "../features/execution/shared/agent.js";
import { MAX_COMMODORE_MESSAGE_IMAGE_BYTES } from "../features/commodore/shared/contracts/attachment-budget.js";
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

    const first = await h.route("taskforce/post", { taskforceId, text: "사람의 말", mentions: [members[0]] });
    expect(first.status).toBe(200);
    const second = h.store.append(taskforceId, { speaker: { kind: "commodore", commodoreId: members[0]! }, text: "사령관의 말" });
    expect(second.entry.seq).toBeGreaterThan((first.value.entry as { seq: number }).seq);

    // 한 발언의 이미지 합계가 턴 예산을 넘으면 저장·원장 append 전에 거절한다.
    const oversizePart = Buffer.alloc(MAX_COMMODORE_MESSAGE_IMAGE_BYTES / 2 + 1).toString("base64");
    const rejected = await h.route("taskforce/post", { taskforceId, text: "너무 큰 이미지 묶음", images: [
      { name: "a.png", mime: "image/png", dataBase64: oversizePart },
      { name: "b.png", mime: "image/png", dataBase64: oversizePart },
    ] });
    expect(rejected).toMatchObject({ status: 400, value: { error: "invalid_request" } });
    expect(h.store.read(taskforceId)?.lastSeq).toBe(second.entry.seq);
    expect(fs.existsSync(path.join(h.consoleDataDir, "taskforce", taskforceId, "images", String(second.entry.seq + 1)))).toBe(false);

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
  readonly images: Extract<AgentInputBlock, { type: "image" }>[][];
  readonly emit: (event: AgentEvent) => void;
  readonly finish: () => void;
  readonly tools: ReadonlyMap<string, ConsoleMcpTool>;
}

function runtimeHarness(extraBoardTools: readonly ConsoleMcpTool[] = []) {
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
        images: [],
        emit: (event) => options.onEvent?.(event),
        finish: () => finish(),
        tools,
      };
      sessions.push(entry);
      return {
        send: async (input) => {
          entry.sent.push(typeof input === "string" ? input : input.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n\n"));
          entry.images.push(typeof input === "string" ? [] : input.filter((block) => block.type === "image"));
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
    tools: () => [...extraBoardTools],
    watch: () => ({ recount: () => new Map<CommodoreBoardWakeCode, number>(), scope: () => null, brief: () => null, attribute: (tool) => tool, emptyOperated: () => false, dispose: () => {} }),
    objective: () => null,
  };
  const supervisor = createCommodoreSupervisor({
    store,
    agent,
    theaterIds: () => [],
    cwd: (id) => (id === a || id === b ? theaterRoot : null),
    experiments: () => ({ ...DEFAULT_EXPERIMENT_SETTINGS, commodore: true, taskforce: true }),
    theater: () => ({ label: "x", root: theaterRoot }),
    board: () => board,
    taskforce,
    onTaskforceEvent: (event) => tfEvents.push(event),
    emit: (event) => commodoreEvents.push(event),
  });
  return { consoleDataDir, theaterRoot, ids: { a, b }, store, taskforce, sessions, supervisor, tfEvents };
}

describe("taskforce runtime", () => {
  it("migrates a previously closed TF without waking its members or changing its ledger", async () => {
    vi.useFakeTimers();
    try {
      const h = runtimeHarness();
      const { a, b } = h.ids;
      const { state } = h.taskforce.create({ name: "이전 TF", topic: "보존할 대화", members: [a, b] });
      const taskforceId = state.id;
      for (const code of ["close-proposed", "reopened", "closed"] as const) h.taskforce.append(taskforceId, { speaker: { kind: "system", code }, text: "이전 기록" });
      const previous = h.taskforce.read(taskforceId)!;
      const tfDir = path.join(h.consoleDataDir, "taskforce", taskforceId);
      const ledger = fs.readFileSync(path.join(tfDir, "ledger.jsonl"), "utf8");
      fs.writeFileSync(path.join(tfDir, "state.json"), JSON.stringify({ ...previous, status: "closed", closedAt: Date.now() }));
      h.taskforce.forget(taskforceId);
      h.supervisor.sync("started");
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(h.sessions).toHaveLength(0);
      const migrated = h.taskforce.read(taskforceId)!;
      expect(migrated).not.toHaveProperty("status");
      expect(migrated).not.toHaveProperty("closedAt");
      expect(migrated.readSeq).toEqual({ [a]: previous.lastSeq, [b]: previous.lastSeq });
      const persisted = JSON.parse(fs.readFileSync(path.join(tfDir, "state.json"), "utf8"));
      expect(persisted).not.toHaveProperty("status");
      expect(persisted).not.toHaveProperty("closedAt");
      expect(fs.readFileSync(path.join(tfDir, "ledger.jsonl"), "utf8")).toBe(ledger);
      const restored = createTaskforceStore({ root: path.join(h.consoleDataDir, "taskforce"), emit: () => undefined });
      expect(restored.read(taskforceId)?.readSeq).toEqual(migrated.readSeq);
      expect(restored.pending(taskforceId, a)).toEqual([]);
      h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: "다시 나누는 말" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(h.sessions).toHaveLength(2);
      for (const session of h.sessions) {
        expect(session.sent[0]).toContain("다시 나누는 말");
        session.finish();
      }
      await vi.advanceTimersByTimeAsync(10);
      await h.supervisor.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("delivers simultaneous posts once and adds history only to a new session's first turn without self-waking", async () => {
    vi.useFakeTimers();
    try {
      const h = runtimeHarness();
      const { a, b } = h.ids;
      const { state } = h.taskforce.create({ name: "동시 판단 TF", topic: "공유 대화", members: [a, b] });
      const taskforceId = state.id;
      h.supervisor.sync("started");
      // 긴 사람 발언도 새 말일 때는 원문으로 싣고, 교대한 세션의 이력에서만 자른다.
      const personText = "함께 답해 주세요: " + "가".repeat(15_900);
      const imageBytes = Buffer.from("TF image payload");
      const images = h.taskforce.saveImages(taskforceId, 2, [{ name: "group.png", mime: "image/png", bytes: imageBytes }]);
      h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: personText, images });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      const sessionOf = (alias: string) => h.sessions.filter((session) => session.name.includes(alias)).at(-1)!;
      expect(sessionOf("Alpha").sent[0]).toContain(personText);
      expect(sessionOf("Beta").sent[0]).toContain(personText);
      for (const alias of ["Alpha", "Beta"]) {
        expect(sessionOf(alias).images[0]).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: imageBytes.toString("base64") } }]);
        expect(sessionOf(alias).sent[0]).toContain(`id: ${taskforceId}, seq 2 (image ×1)`);
      }
      const post = async (alias: string, text: string) => {
        const result = await sessionOf(alias).tools.get("taskforce_post")!.execute({ taskforceId, text }, { cwd: h.theaterRoot, toolCallId: alias } as never);
        expect(result).not.toMatchObject({ isError: true });
        return h.taskforce.lastEntry(taskforceId)!;
      };
      // 두 턴이 같은 입력을 판단 중이다. Beta가 나중에 말해도 그 전에 도착한 Alpha의 말을 읽은 셈 치면 안 된다.
      const alpha = await post("Alpha", "Alpha의 동시 응답");
      const beta = await post("Beta", "Beta의 동시 응답");
      // 보드 쓰기 묶음 역시 읽음 커서를 건너뛰게 하면 안 된다.
      h.taskforce.appendActions(taskforceId, b, { actions: [{ kind: "add", objectiveId: "o1", title: "공유 작업" }], replyTo: beta.seq });
      expect(h.taskforce.read(taskforceId)?.readSeq).toMatchObject({ [a]: 0, [b]: 0 });
      sessionOf("Alpha").finish();
      sessionOf("Beta").finish();
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      for (const [alias, peer] of [["Alpha", beta], ["Beta", alpha]] as const) {
        const session = sessionOf(alias);
        expect(session.sent).toHaveLength(2);
        expect(session.images[1]).toEqual([]);
        const prompt = session.sent[1]!;
        expect(prompt.split(`[seq ${peer.seq}]`)).toHaveLength(2);
        expect(prompt).toContain(`${alias === "Alpha" ? "Beta" : "Alpha"}: ${peer.text}`);
        expect(prompt).not.toContain("Recent conversation reminder");
        expect(prompt).not.toContain("person: 함께 답해 주세요");
        expect(prompt).not.toContain("[seq 2]");
        session.finish();
      }
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sessionOf("Alpha").sent).toHaveLength(2);
      expect(sessionOf("Beta").sent).toHaveLength(2);
      // 교대한 Alpha의 첫 턴에만 읽은 이력을 붙인다. 같은 세션의 Beta는 새 말만 받는다.
      const oldAlpha = sessionOf("Alpha");
      h.supervisor.replaceSessionNext(a);
      h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: "서로의 응답을 확인해 주세요" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      for (const alias of ["Alpha", "Beta"]) {
        const session = sessionOf(alias);
        const prompt = session.sent.at(-1)!;
        expect(session.images.at(-1)).toEqual([]);
        expect(prompt).toContain("서로의 응답을 확인해 주세요");
        if (alias === "Alpha") {
          expect(session).not.toBe(oldAlpha);
          expect(session.sent).toHaveLength(1);
          const history = prompt.split("Recent conversation reminder (already read; not new utterances):\n")[1]!.split("New ledger entries")[0]!;
          expect(history.length).toBeLessThanOrEqual(8001);
          expect(history).toContain("person: 함께 답해 주세요");
          expect(history).toContain("[seq 2] (image ×1)");
          expect(history).toContain("[history truncated]");
          for (const entry of [alpha, beta]) {
            expect(history).toContain(entry.text);
            expect(prompt.split(`[seq ${entry.seq}]`)).toHaveLength(2);
          }
        } else {
          expect(prompt).not.toContain("Recent conversation reminder");
          for (const entry of [alpha, beta]) expect(prompt).not.toContain(`[seq ${entry.seq}]`);
        }
        session.finish();
      }
      await vi.advanceTimersByTimeAsync(10);
      // 다음 1:1 턴도 새 세션이 아니므로 TF 이력을 반복하지 않는다.
      h.store.transcriptAppend(a, { kind: "message", text: "개인 대화" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessionOf("Alpha").sent.at(-1)).not.toContain("Recent conversation reminder");
      expect(sessionOf("Alpha").sent.at(-1)).not.toContain(`(id: ${taskforceId})`);
      sessionOf("Alpha").finish();
      await vi.advanceTimersByTimeAsync(10);
      // 두 이미지 발언은 각각 한 턴에 들어간다. 합계가 턴 예산을 넘으면 두 번째 발언 전체를 남긴다.
      const largeImage = Buffer.alloc(MAX_COMMODORE_MESSAGE_IMAGE_BYTES, 1);
      const imageEntries = ["큰 이미지 1", "큰 이미지 2"].map((text) => {
        const seq = h.taskforce.read(taskforceId)!.lastSeq + 1;
        const saved = h.taskforce.saveImages(taskforceId, seq, [{ name: "large.png", mime: "image/png", bytes: largeImage }]);
        return h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text, images: saved }).entry;
      });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      const previous = [sessionOf("Alpha"), sessionOf("Beta")];
      for (const session of previous) {
        expect(session.images.at(-1)).toHaveLength(1);
        expect(session.sent.at(-1)).toContain(imageEntries[0]!.text);
        expect(session.sent.at(-1)).not.toContain(imageEntries[1]!.text);
        session.finish();
      }
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      // 누적 12 MiB 세션 상한을 넘기 전 교체하고, 새 세션에는 남겨 둔 두 번째 이미지만 싣는다.
      for (const [index, alias] of ["Alpha", "Beta"].entries()) {
        const session = sessionOf(alias);
        expect(session).not.toBe(previous[index]);
        expect(session.sent).toHaveLength(1);
        expect(session.images[0]).toHaveLength(1);
        const [history, unread] = session.sent[0]!.split("New ledger entries");
        expect(history).toContain(imageEntries[0]!.text);
        expect(history).toContain("(image ×1)");
        expect(unread).toContain(imageEntries[1]!.text);
        expect(unread).not.toContain(imageEntries[0]!.text);
        session.finish();
      }
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      for (const id of [a, b]) {
        expect(h.taskforce.read(taskforceId)?.readSeq[id]).toBe(imageEntries[1]!.seq);
        expect(JSON.stringify(h.store.transcriptRead(id))).not.toContain("큰 이미지");
      }
      // 이전 버전에서 저장한 상한 초과 묶음은 새 턴을 영원히 막지 않고, 생략 사실과 텍스트를 전달한다.
      const persisted = h.taskforce.read(taskforceId)!;
      const legacy = { seq: persisted.lastSeq + 1, at: Date.now(), speaker: { kind: "person" }, mentions: [], text: "과거의 큰 이미지 묶음", images: imageEntries.flatMap((entry) => entry.images ?? []) };
      const tfDir = path.join(h.consoleDataDir, "taskforce", taskforceId);
      fs.appendFileSync(path.join(tfDir, "ledger.jsonl"), JSON.stringify(legacy) + "\n");
      fs.writeFileSync(path.join(tfDir, "state.json"), JSON.stringify({ ...persisted, lastSeq: legacy.seq }));
      h.taskforce.forget(taskforceId);
      h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: "계속 판단해 주세요" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      for (const alias of ["Alpha", "Beta"]) {
        const session = sessionOf(alias);
        expect(session.images.at(-1)).toEqual([]);
        expect(session.sent.at(-1)).toContain("과거의 큰 이미지 묶음 (images omitted: exceeds 8 MiB message limit)");
        expect(session.sent.at(-1)).toContain("계속 판단해 주세요");
        session.finish();
      }
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      for (const id of [a, b]) expect(h.taskforce.read(taskforceId)?.readSeq[id]).toBe(legacy.seq + 1);
      await h.supervisor.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("pauses the chain at 12, never self-wakes, and keeps TF traffic out of 1:1 transcripts", async () => {
    vi.useFakeTimers();
    try {
      const h = runtimeHarness();
      const { a, b } = h.ids;
      const { state: created } = h.taskforce.create({ name: "출격 TF", topic: "오늘의 주제", members: [a, b] });
      const taskforceId = created.id;
      h.supervisor.sync("started");
      // 사람의 말 — 두 성원이 판단 대상이다. Alpha는 세션을 먼저 교체한다.
      h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: "사람의 말" });
      h.supervisor.replaceSessionNext(a);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      const sendsOf = (alias: string) => h.sessions.filter((session) => session.name.includes(alias)).flatMap((session) => session.sent);
      // 세션은 교체될 때마다 새로 열린다 — 항상 마지막 세션으로 말한다.
      const sessionOf = (alias: string) => h.sessions.filter((session) => session.name.includes(alias)).at(-1)!;
      expect(sendsOf("Alpha")).toHaveLength(1);
      expect(sendsOf("Beta")).toHaveLength(1);
      expect(sendsOf("Alpha")[0]).toContain("TaskForce");
      expect(sendsOf("Alpha")[0]).toContain("사람의 말");
      // 판단 블록에는 말하는 데 필요한 id가 그대로 있다 — 모델이 추측하지 않게 한다.
      expect(sendsOf("Alpha")[0]).toContain(`(id: ${taskforceId})`);
      expect(sendsOf("Alpha")[0]).toContain(`Alpha (${a})`);
      expect(sendsOf("Alpha")[0]).toContain(`Beta (${b})`);
      expect(sendsOf("Alpha")[0]!.match(/\(id: ([0-9a-f-]{36})\)/)![1]).toBe(taskforceId);
      expect(h.tfEvents.some((event) => event.op === "taskforce-judging" && event.judging.length === 2)).toBe(true);

      const post = async (alias: string, text: string) => {
        const tool = sessionOf(alias).tools.get("taskforce_post")!;
        const result = await tool.execute({ taskforceId, text }, { cwd: h.theaterRoot, toolCallId: `tf-${text.length}` } as never);
        expect(result).not.toMatchObject({ isError: true });
      };
      // Beta는 침묵으로 첫 턴을 끝낸다.
      sessionOf("Beta").finish();
      await vi.advanceTimersByTimeAsync(10);
      // Alpha도 말 없이 첫 턴을 끝낸다 — 교대한 세션의 rotated 이유가 다음 턴에 남는다.
      sessionOf("Alpha").finish();
      await vi.advanceTimersByTimeAsync(10);
      // 사람의 말이 또 오면 rotated와 taskforce가 한 턴에 겹친다.
      h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: "사람의 말 2" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      // 겹친 턴의 자유 텍스트도 1:1 기록에 남지 않는다 — 세션 수명주기는 조용함을 깨지 않는다.
      sessionOf("Alpha").emit({ kind: "text", text: "rotated chatter that must not surface" });
      await post("Alpha", "Alpha의 말");
      sessionOf("Alpha").finish();
      await vi.advanceTimersByTimeAsync(10);
      // Beta의 겹친 턴은 침묵으로 끝낸다.
      sessionOf("Beta").finish();
      await vi.advanceTimersByTimeAsync(10);
      // 자신의 말에는 스스로 깨지 않는다.
      expect(sendsOf("Alpha")).toHaveLength(2);
      const alphaEntries = h.store.transcriptRead(a).entries;
      expect(alphaEntries.some((entry) => entry.kind === "text")).toBe(false);
      expect(JSON.stringify(alphaEntries)).not.toContain("rotated chatter that must not surface");
      expect(JSON.stringify(alphaEntries)).not.toContain("오늘의 주제");
      // 깨움 이유에 taskforce와 rotated가 함께 남았다.
      const wakeReasons = alphaEntries.flatMap((entry) => (entry.kind === "wake" ? [entry.reasons] : []));
      expect(wakeReasons.some((reasons) => reasons.includes("taskforce") && reasons.includes("rotated"))).toBe(true);

      // chain을 12까지 쌓는다 — Beta부터 번갈아 말한다.
      const speakers = ["Beta", "Alpha", "Beta", "Alpha", "Beta", "Alpha", "Beta", "Alpha", "Beta", "Alpha", "Beta"];
      for (const [index, alias] of speakers.entries()) {
        await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
        await post(alias, `${alias}의 말 ${index}`);
        sessionOf(alias).finish();
        await vi.advanceTimersByTimeAsync(10);
      }
      const final = h.taskforce.read(taskforceId)!;
      expect(final.counts).toEqual({ person: 2, commodore: 12 });
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
      // 끝난 판단마다 시각을 새긴다 — 1:1 턴에 실린 새 세션 맥락도 판단이다.
      // 판단으로 깨지 않은 턴의 되풀이 침묵도 최근 시각으로 남는다.
      const lastSilentAt = () => h.tfEvents.flatMap((event) => {
        if (event.op !== "taskforce-judging") return [];
        const outcome = event.outcomes[b];
        return outcome?.outcome === "silent" ? [outcome.at] : [];
      }).at(-1);
      h.supervisor.replaceSessionNext(b);
      h.store.transcriptAppend(b, { kind: "message", text: "1:1 말 1" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      sessionOf("Beta").finish();
      await vi.advanceTimersByTimeAsync(10);
      const r1 = lastSilentAt();
      h.supervisor.replaceSessionNext(b);
      h.store.transcriptAppend(b, { kind: "message", text: "1:1 말 2" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      sessionOf("Beta").finish();
      await vi.advanceTimersByTimeAsync(10);
      const r2 = lastSilentAt();
      expect(r1).toBeDefined();
      expect(r2).toBeGreaterThan(r1!);
      const snapshot = h.taskforce.read(taskforceId)?.judging;
      expect(snapshot?.judging).toEqual([]);
      expect(snapshot?.outcomes?.[a]?.outcome).toBe("spoke");
      expect(snapshot?.outcomes?.[b]?.outcome).toBe("silent");
      const listed = h.taskforce.list().find((row) => row.id === taskforceId)!;
      expect(listed.counts).toEqual({ person: 2, commodore: 12 });
      expect(listed.judging).toEqual([]);
      // 재기동 복원 — 말 수와 판단 스냅샷이 함께 돌아온다.
      const restored = createTaskforceStore({ root: path.join(h.consoleDataDir, "taskforce"), emit: () => undefined });
      expect(restored.read(taskforceId)?.counts).toEqual({ person: 2, commodore: 12 });
      expect(restored.read(taskforceId)?.judging?.outcomes?.[a]?.outcome).toBe("spoke");
      await h.supervisor.dispose();
    } finally { vi.useRealTimers(); }
  });
});

describe("taskforce runtime empty wakes", () => {
  it("does not start a turn for a taskforce wake with no unread items", async () => {
    vi.useFakeTimers();
    try {
      const h = runtimeHarness();
      const { a, b } = h.ids;
      const { state: created } = h.taskforce.create({ name: "빈 깨움 TF", topic: "주제", members: [a, b] });
      const taskforceId = created.id;
      h.supervisor.sync("started");
      h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: "사람의 말" });
      // 다른 턴이 이미 읽은 셈 친다 — 깨움만 남고 판단 항목은 없다.
      h.taskforce.advanceReadSeq(taskforceId, a, 2);
      h.taskforce.advanceReadSeq(taskforceId, b, 2);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      // 턴이 서지 않는다 — 세션도, 1:1 기록도 남지 않는다.
      expect(h.sessions).toHaveLength(0);
      expect(h.store.transcriptRead(a).entries).toHaveLength(0);
      expect(h.store.transcriptRead(b).entries).toHaveLength(0);
      expect(h.supervisor.status(a)).toMatchObject({ phase: "idle" });
      // 판단 중에서도 조용히 빠진다.
      const judgements = h.tfEvents.filter((event) => event.op === "taskforce-judging");
      expect(judgements.length).toBeGreaterThan(0);
      expect(judgements.at(-1)).toMatchObject({ taskforceId, judging: [] });
      await h.supervisor.dispose();
    } finally { vi.useRealTimers(); }
  });
});

describe("taskforce runtime board actions", () => {
  it("appends board writes under the post with replyTo", async () => {
    vi.useFakeTimers();
    try {
      // `add` 의 id는 입력이 아니라 결과 본문에만 있다 — 실제 경로처럼 structuredContent 없이 content 텍스트로만 온다.
      const objectivesAddTool = {
        name: "objectives",
        description: "fake board",
        inputSchema: {},
        actionSchema: { actions: { add: { kind: "write" } } },
        execute: async () => ({ content: [{ type: "text", text: JSON.stringify({ ok: true, objectiveId: "o1", stored: { title: "온보딩 결제 단계 분리" } }) }], isError: false }),
      } as unknown as ConsoleMcpTool;
      const h = runtimeHarness([objectivesAddTool]);
      const { a } = h.ids;
      const { state: created } = h.taskforce.create({ name: "액션 TF", topic: "주제", members: [a, h.ids.b] });
      const taskforceId = created.id;
      h.supervisor.sync("started");
      h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: "사람의 말" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      const sessionOf = (alias: string) => h.sessions.filter((session) => session.name.includes(alias)).at(-1)!;
      sessionOf("Beta").finish();
      await vi.advanceTimersByTimeAsync(10);
      // 같은 턴에 쓰고 말한다 — 순서는 바뀌어도 같은 말 아래에 묶인다.
      const tools = sessionOf("Alpha").tools;
      sessionOf("Alpha").emit({ kind: "tool-start", id: "w0", name: "mcp__fleet-commodore__objectives", input: { action: "add", title: "온보딩 결제 단계 분리" } });
      const writeResult = await tools.get("objectives")!.execute({ action: "add", title: "온보딩 결제 단계 분리" }, { cwd: h.theaterRoot, toolCallId: "w0" } as never);
      expect(writeResult).not.toMatchObject({ isError: true });
      sessionOf("Alpha").emit({ kind: "tool-end", id: "w0", isError: false });
      const postResult = await tools.get("taskforce_post")!.execute({ taskforceId, text: "Alpha의 말" }, { cwd: h.theaterRoot, toolCallId: "tf-1" } as never);
      expect(postResult).not.toMatchObject({ isError: true });
      sessionOf("Alpha").finish();
      await vi.advanceTimersByTimeAsync(10);
      const entries = h.taskforce.readLedger(taskforceId).entries;
      const postEntry = entries.find((entry) => entry.speaker.kind === "commodore" && entry.text === "Alpha의 말")!;
      const actionsEntry = entries.find((entry) => (entry.actions?.length ?? 0) > 0)!;
      expect(actionsEntry.replyTo).toBe(postEntry.seq);
      expect(actionsEntry.actions).toEqual([{ kind: "add", objectiveId: "o1", title: "온보딩 결제 단계 분리" }]);
      // 1:1 기록의 tool 줄에도 결과의 objectiveId가 남았다.
      const toolEntry = h.store.transcriptRead(a).entries.find((entry) => entry.kind === "tool" && entry.name === "objectives");
      expect(toolEntry).toMatchObject({ action: "add", objectiveId: "o1", title: "온보딩 결제 단계 분리", ok: true });
      await h.supervisor.dispose();
    } finally { vi.useRealTimers(); }
  });
});

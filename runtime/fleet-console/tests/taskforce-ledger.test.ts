import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTaskforceRoutes, type TaskforceRouteContext } from "../features/commodore/host/taskforce/routes.js";
import { createTaskforceStore, type TaskforceStore } from "../features/commodore/host/taskforce/store.js";
import type { TaskforceEvent } from "../features/commodore/shared/contracts/taskforce.js";
import { createCommodoreStore, type CommodoreStore } from "../features/commodore/host/store.js";
import { createCommodoreTools } from "../features/commodore/host/tools.js";
import { TF_PERSON_QUIET_MS, createCommodoreSupervisor } from "../features/commodore/host/supervisor.js";
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

  it("adds and removes members with a 200 response and a membership system entry", async () => {
    const h = harness();
    const members = [randomUUID(), randomUUID(), randomUUID()];
    const created = await h.route("taskforce/create", { name: "성원 TF", topic: "주제", members });
    expect(created.status).toBe(200);
    const taskforceId = (created.value.taskforce as { id: string }).id;

    const newcomer = randomUUID();
    const added = await h.route("taskforce/members/add", { taskforceId, commodoreIds: [newcomer] });
    expect(added.status).toBe(200);
    expect((added.value.taskforce as { members: string[] }).members).toEqual([...members, newcomer]);

    // 제거는 실제로 반영되면서 200으로 끝나고 `member-removed` 항목을 남긴다.
    const removed = await h.route("taskforce/members/remove", { taskforceId, commodoreId: members[0] });
    expect(removed.status).toBe(200);
    expect((removed.value.taskforce as { members: string[] }).members).toEqual([members[1], members[2], newcomer]);
    const codes = h.store.readLedger(taskforceId).entries.flatMap((entry) => (entry.speaker.kind === "system" ? [entry.speaker.code] : []));
    expect(codes).toContain("member-added");
    expect(codes).toContain("member-removed");
  });
});

/**
 * TaskForce 판단 런타임의 필수 계약 — chain이 TF가 고른 상한에 닿으면 멈추고 `chain-paused`를
 * 남기며 깨우지 않는다. 제한 안 함이면 멈추지 않는다. 자신의 말에는 스스로 깨지 않고, TF 말은 1:1 기록에 닿지 않는다.
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
      await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
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
      await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
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
      await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
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
      await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
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
      await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
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
      await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
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
      await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
      const previous = [sessionOf("Alpha"), sessionOf("Beta")];
      for (const session of previous) {
        expect(session.images.at(-1)).toHaveLength(1);
        expect(session.sent.at(-1)).toContain(imageEntries[0]!.text);
        expect(session.sent.at(-1)).not.toContain(imageEntries[1]!.text);
        session.finish();
      }
      await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
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
      await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
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
      await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
      for (const alias of ["Alpha", "Beta"]) {
        const session = sessionOf(alias);
        expect(session.images.at(-1)).toEqual([]);
        expect(session.sent.at(-1)).toContain("과거의 큰 이미지 묶음 (images omitted: exceeds 8 MiB message limit)");
        expect(session.sent.at(-1)).toContain("계속 판단해 주세요");
        session.finish();
      }
      await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
      for (const id of [a, b]) expect(h.taskforce.read(taskforceId)?.readSeq[id]).toBe(legacy.seq + 1);
      await h.supervisor.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("searches only the participation intervals of each TaskForce with the same tool", async () => {
    // 단일 원장 검색의 TF 대표 계약 — 현재·과거 참여 구간만 보이고, 구간 밖은
    // 가려지며, 참여한 적 없는 호출자에게는 없는 TF와 같이 거절된다.
    vi.useFakeTimers();
    try {
      const h = runtimeHarness();
      const { a, b } = h.ids;
      const c = randomUUID();
      const outsider = randomUUID();
      const { state } = h.taskforce.create({ name: "검색 TF", topic: "공유 주제", members: [a, b] });
      const taskforceId = state.id;
      h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: "사람의 첫 말" });
      h.taskforce.append(taskforceId, { speaker: { kind: "commodore", commodoreId: a }, text: "Alpha의 말" });
      h.taskforce.addMembers(taskforceId, [c]);
      h.taskforce.append(taskforceId, { speaker: { kind: "commodore", commodoreId: c }, text: "Charlie의 말" });
      h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: "사람의 둘째 말" });
      h.taskforce.removeMember(taskforceId, b);
      h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: "사람의 셋째 말" });
      h.taskforce.append(taskforceId, { speaker: { kind: "commodore", commodoreId: a }, text: "Alpha의 끝말" });

      h.supervisor.sync("started");
      await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
      const sessionOf = (alias: string) => h.sessions.filter((session) => session.name.includes(alias)).at(-1)!;
      const callSession = (alias: string, args: Record<string, unknown>) =>
        sessionOf(alias).tools.get("memory_search")!.execute(args, { cwd: h.theaterRoot, toolCallId: alias } as never) as Promise<{ isError: boolean; structuredContent: Record<string, any> }>;
      const direct = (callerId: string) =>
        Object.fromEntries(createCommodoreTools({
          commodoreId: callerId, theaterRoot: h.theaterRoot,
          // 늦게 든 성원(c)도 부르는 쪽에 서게 같은 Console 땅의 넓은 저장소로 본다.
          store: createCommodoreStore({
            dirOf: (id) => (id === a || id === b || id === c || id === outsider ? path.join(h.consoleDataDir, "commodore", id) : null),
            theatersOf: () => [], theaterIdsOf: () => [], emit: () => {},
          }),
          taskforce: h.taskforce,
        }).map((tool) => [tool.name, tool])).memory_search!;
      const callDirect = async (callerId: string, args: Record<string, unknown>) =>
        await direct(callerId).execute(args, { cwd: h.theaterRoot }) as { isError: boolean; structuredContent: Record<string, any> };

      // 현재 성원(a)은 전체를 본다 — 세션 도구의 전체 경로.
      const full = (await callSession("Alpha", { target: "taskforce", taskforceId })).structuredContent;
      expect(full.callerCommodoreId).toBe(a);
      expect(full.results.map((item: { seq: number }) => item.seq)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
      expect(full.partial).toBe(false);
      expect(full.sources).toMatchObject([{ source: { kind: "taskforce", id: taskforceId, name: "검색 TF" }, status: "complete" }]);
      const bySeq = Object.fromEntries((full.results as { seq: number; speaker: object }[]).map((item) => [item.seq, item]));
      expect(bySeq[3]!.speaker).toMatchObject({ role: "self", kind: "commodore", commodoreId: a, alias: "Alpha" });
      expect(bySeq[5]!.speaker).toMatchObject({ role: "other", kind: "commodore", commodoreId: c });
      expect(bySeq[2]!.speaker).toMatchObject({ role: "person", kind: "person" });
      expect(bySeq[1]!.speaker).toMatchObject({ role: "system", kind: "system" });

      // 나간 성원(b)은 나간 때까지만, 늦게 든 성원(c)은 든 뒤만 본다.
      const past = (await callDirect(b, { target: "taskforce", taskforceId })).structuredContent;
      expect(past.results.map((item: { seq: number }) => item.seq)).toEqual([7, 6, 5, 4, 3, 2, 1]);
      expect(past.sources).toMatchObject([{ source: { id: taskforceId }, status: "complete" }]);
      const late = (await callDirect(c, { target: "taskforce", taskforceId })).structuredContent;
      expect(late.results.map((item: { seq: number }) => item.seq)).toEqual([9, 8, 7, 6, 5, 4]);
      // 참여한 적 없는 호출자는 없는 TF와 같이 거절된다.
      expect((await callDirect(outsider, { target: "taskforce", taskforceId })).structuredContent).toMatchObject({ error: "unknown_taskforce" });
      expect((await callSession("Alpha", { target: "taskforce", taskforceId: randomUUID() })).structuredContent).toMatchObject({ error: "unknown_taskforce" });

      // anchor로 구간 밖을 읽으면 자리는 보여주고 내용은 가린다.
      const outside = (await callDirect(b, { anchor: { source: taskforceId, seq: 8 }, before: 1, after: 1 })).structuredContent as {
        anchorFound: boolean; items: { seq: number; readable: boolean; reason?: string }[]; partial: boolean;
      };
      expect(outside.anchorFound).toBe(true);
      expect(outside.partial).toBe(false);
      expect(outside.items).toMatchObject([
        { seq: 7, readable: true },
        { seq: 8, readable: false, reason: "outside_participation" },
        { seq: 9, readable: false, reason: "outside_participation" },
      ]);
      // 구간 밖 자리에는 시각·원문 등 metadata를 싣지 않는다.
      const hidden = outside.items.filter((item) => !item.readable);
      expect(hidden).toHaveLength(2);
      expect(hidden.every((item) => !("at" in item) && !("text" in item) && !("kind" in item))).toBe(true);
      // 참여 증거 전에 읽기가 깨지면 source 메타데이터 없이 거절된다.
      const boomState = h.taskforce.read(taskforceId)!;
      const boom = {
        list: () => h.taskforce.list().filter((entry) => entry.id === taskforceId),
        read: () => boomState,
        readLedger: () => { throw new Error("boom"); },
      };
      const boomTool = Object.fromEntries(createCommodoreTools({ commodoreId: b, theaterRoot: h.theaterRoot, store: h.store, taskforce: boom as never }).map((tool) => [tool.name, tool])).memory_search!;
      const boomCall = async (args: Record<string, unknown>) =>
        await boomTool.execute(args, { cwd: h.theaterRoot }) as { isError: boolean; structuredContent: Record<string, any> };
      expect((await boomCall({ target: "taskforce", taskforceId })).structuredContent).toMatchObject({ error: "unknown_taskforce" });
      const boomAll = (await boomCall({ target: "all" })).structuredContent as { partial: boolean; sources: { source: { id: string } }[] };
      expect(boomAll.partial).toBe(true);
      expect(boomAll.sources.every((entry) => entry.source.id !== taskforceId)).toBe(true);
      // all은 참여한 TF를 같은 응답에서 발견한다.
      const discovered = (await callDirect(b, { target: "all", query: "Alpha" })).structuredContent as {
        sources: { source: { kind: string; id: string } }[]; results: { seq: number }[];
      };
      expect(discovered.sources.map((entry) => entry.source.id).sort()).toEqual([b, taskforceId].sort());
      expect(discovered.results.map((item) => item.seq)).toEqual([3]);

      for (const session of h.sessions) session.finish();
      await vi.advanceTimersByTimeAsync(10);
      await h.supervisor.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("ignores TaskForce files that escape their directories", async () => {
    // 원장·상태 읽기의 실경로 경계 — 밖을 가리키는 링크는 없는 것으로 본다.
    const h = runtimeHarness();
    const { a, b } = h.ids;
    const { state } = h.taskforce.create({ name: "울타리 TF", topic: "주제", members: [a, b] });
    const taskforceId = state.id;
    h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: "안에 있는 말" });
    const direct = (callerId: string) =>
      Object.fromEntries(createCommodoreTools({ commodoreId: callerId, theaterRoot: h.theaterRoot, store: h.store, taskforce: h.taskforce }).map((tool) => [tool.name, tool])).memory_search!;
    const call = async (callerId: string, args: Record<string, unknown>) =>
      await direct(callerId).execute(args, { cwd: h.theaterRoot }) as { isError: boolean; structuredContent: Record<string, any> };
    const tfDir = path.join(h.consoleDataDir, "taskforce", taskforceId);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-tf-outside-"));
    dirs.push(outsideDir);
    const ledger = path.join(tfDir, "ledger.jsonl");
    fs.renameSync(ledger, path.join(tfDir, "saved-ledger.jsonl"));
    const outside = path.join(outsideDir, "other.jsonl");
    fs.writeFileSync(outside, `${JSON.stringify({ seq: 1, at: Date.now(), speaker: { kind: "person" }, text: "OUTSIDE_TF_LEDGER", mentions: [] })}\n`);
    fs.symlinkSync(outside, ledger);
    try {
      expect(h.taskforce.readLedger(taskforceId).entries).toEqual([]);
      const leaked = (await call(a, { target: "taskforce", taskforceId })).structuredContent;
      expect(leaked.results).toEqual([]);
      expect(JSON.stringify(leaked)).not.toContain("OUTSIDE_TF_LEDGER");
    } finally {
      fs.unlinkSync(ledger);
      fs.renameSync(path.join(tfDir, "saved-ledger.jsonl"), ledger);
    }
    // 상태가 밖을 가리키면 TF 자체가 없는 것으로 보인다.
    const stateFile = path.join(tfDir, "state.json");
    fs.writeFileSync(path.join(outsideDir, "other-state.json"), JSON.stringify({ ...h.taskforce.read(taskforceId), name: "Planted" }));
    fs.renameSync(stateFile, path.join(tfDir, "saved-state.json"));
    fs.symlinkSync(path.join(outsideDir, "other-state.json"), stateFile);
    try {
      h.taskforce.forget(taskforceId);
      expect(h.taskforce.read(taskforceId)).toBeNull();
      const gone = (await call(a, { target: "taskforce", taskforceId })).structuredContent;
      expect(gone).toMatchObject({ error: "unknown_taskforce" });
      expect(JSON.stringify(gone)).not.toContain("Planted");
    } finally {
      fs.unlinkSync(stateFile);
      fs.renameSync(path.join(tfDir, "saved-state.json"), stateFile);
    }
  });

  it("verifies participation backward from the latest state instead of inferring from absence", async () => {
    // 탈퇴 뒤 재합류 사이의 비참여 구간은 읽었다는 이유만으로 보이지 않는다.
    const h = runtimeHarness();
    const { a, b } = h.ids;
    const { state } = h.taskforce.create({ name: "출입 TF", topic: "주제", members: [a, b] });
    const taskforceId = state.id;
    const direct = (callerId: string) =>
      Object.fromEntries(createCommodoreTools({ commodoreId: callerId, theaterRoot: h.theaterRoot, store: h.store, taskforce: h.taskforce }).map((tool) => [tool.name, tool])).memory_search!;
    const call = async (callerId: string, args: Record<string, unknown>) =>
      await direct(callerId).execute(args, { cwd: h.theaterRoot }) as { isError: boolean; structuredContent: Record<string, any> };
    for (let i = 0; i < 18; i += 1) h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: `앞 말 ${i}` });
    h.taskforce.removeMember(taskforceId, a);
    for (let i = 0; i < 79; i += 1) h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: i === 30 ? "GAP_NEEDLE" : `틈 말 ${i}` });
    h.taskforce.addMembers(taskforceId, [a]);
    h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: "COVERED_NEEDLE" });
    for (let i = 0; i < 19; i += 1) h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: `뒷 말 ${i}` });
    const res = (await call(a, { target: "taskforce", taskforceId, limit: 50 })).structuredContent as {
      results: { seq: number }[]; hasMore: boolean; partial: boolean; nextScan?: string;
    };
    const seqs = res.results.map((item) => item.seq);
    expect(seqs.every((seq) => seq <= 20 || seq >= 100)).toBe(true);
    expect(seqs).not.toContain(51);
    expect(JSON.stringify(res)).not.toContain("GAP_NEEDLE");
    expect(JSON.stringify(res)).toContain("COVERED_NEEDLE");
    expect(res.hasMore).toBe(false);
    expect(res.partial).toBe(false);
    expect(res.nextScan).toBeUndefined();
  });

  it("continues into older ledger pages with scan without widening permission", async () => {
    // 6000개 원장의 깊은 기록 — 이어읽기 토큰은 위치만 옮기고 권한은 매번 다시 가린다.
    const h = runtimeHarness();
    const { a, b } = h.ids;
    const { state } = h.taskforce.create({ name: "깊은 TF", topic: "주제", members: [a, b] });
    const taskforceId = state.id;
    const direct = (callerId: string) =>
      Object.fromEntries(createCommodoreTools({ commodoreId: callerId, theaterRoot: h.theaterRoot, store: h.store, taskforce: h.taskforce }).map((tool) => [tool.name, tool])).memory_search!;
    const call = async (callerId: string, args: Record<string, unknown>) =>
      await direct(callerId).execute(args, { cwd: h.theaterRoot }) as { isError: boolean; structuredContent: Record<string, any> };
    for (let seq = 2; seq <= 99; seq += 1) h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: seq === 50 ? "COVERED_NEEDLE" : `앞 말 ${seq}` });
    h.taskforce.removeMember(taskforceId, a);
    for (let seq = 101; seq <= 2999; seq += 1) h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: seq === 150 ? "GAP_NEEDLE" : `틈 말 ${seq}` });
    h.taskforce.addMembers(taskforceId, [a]);
    for (let seq = 3001; seq <= 6000; seq += 1) h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: seq === 5900 ? "NEW_NEEDLE" : `뒷 말 ${seq}` });
    const first = (await call(a, { target: "taskforce", taskforceId, query: "NEEDLE", limit: 50 })).structuredContent as {
      results: { seq: number }[]; hasMore: boolean; partial: boolean; nextScan?: string;
      sources: { status: string; participationUncertain?: boolean }[];
    };
    expect(first.results.map((item) => item.seq)).toEqual([5900]);
    expect(first.hasMore).toBe(false);
    expect(first.partial).toBe(true);
    expect(typeof first.nextScan).toBe("string");
    expect(first.sources).toMatchObject([{ status: "partial", participationUncertain: true }]);
    // cursor와 scan은 섞지 않는다.
    expect((await call(a, { target: "taskforce", taskforceId, cursor: "x", scan: first.nextScan })).structuredContent).toMatchObject({ error: "invalid_request" });
    // 남의 토큰은 호출자가 바뀌면 무효다(권한이 아니라 위치만 담아도 지문으로 묶는다).
    expect((await call(b, { target: "taskforce", taskforceId, query: "NEEDLE", scan: first.nextScan })).structuredContent).toMatchObject({ error: "invalid_scan" });
    const second = (await call(a, { target: "taskforce", taskforceId, query: "NEEDLE", scan: first.nextScan })).structuredContent as {
      results: { seq: number }[]; partial: boolean; nextScan?: string; scanContinued?: boolean;
    };
    expect(second.scanContinued).toBe(true);
    expect(second.results).toEqual([]);
    expect(typeof second.nextScan).toBe("string");
    const third = (await call(a, { target: "taskforce", taskforceId, query: "NEEDLE", scan: second.nextScan })).structuredContent as {
      results: { seq: number }[]; partial: boolean; nextScan?: string; sources: { status: string }[];
    };
    expect(third.results.map((item) => item.seq)).toEqual([50]);
    expect(JSON.stringify(third)).not.toContain("GAP_NEEDLE");
    expect(third.partial).toBe(false);
    expect(third.nextScan).toBeUndefined();
    expect(third.sources).toMatchObject([{ status: "complete" }]);
  });

  it("withholds unverified anchor context when the walk cannot reach it", async () => {
    // 7000개 원장의 깊은 anchor — 6000 예산으로 최신부터 거슬러 닿지 못하면 미확인이다.
    const h = runtimeHarness();
    const { a, b } = h.ids;
    const { state } = h.taskforce.create({ name: "먼 TF", topic: "주제", members: [a, b] });
    const taskforceId = state.id;
    const direct = (callerId: string) =>
      Object.fromEntries(createCommodoreTools({ commodoreId: callerId, theaterRoot: h.theaterRoot, store: h.store, taskforce: h.taskforce }).map((tool) => [tool.name, tool])).memory_search!;
    const call = async (callerId: string, args: Record<string, unknown>) =>
      await direct(callerId).execute(args, { cwd: h.theaterRoot }) as { isError: boolean; structuredContent: Record<string, any> };
    for (let seq = 2; seq <= 7000; seq += 1) h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: `먼 말 ${seq}` });
    const res = (await call(a, { anchor: { source: taskforceId, seq: 150 }, before: 5, after: 5 })).structuredContent as {
      anchorFound: boolean; partial: boolean;
      items: { seq: number; readable: boolean; reason?: string }[];
      sources: { status: string; participationUncertain?: boolean }[];
    };
    expect(res.anchorFound).toBe(false);
    expect(res.partial).toBe(true);
    expect(res.items).toHaveLength(11);
    expect(res.items.every((item) => !item.readable && item.reason === "unverified")).toBe(true);
    expect(res.items.every((item) => !("at" in item) && !("text" in item))).toBe(true);
    expect(res.sources).toMatchObject([{ status: "partial", participationUncertain: true }]);
  });

  it("judges anchor context with transitions outside the window", async () => {
    // anchor window에는 없지만 권한을 정하는 전이(탈퇴·재합류)도 walk에 싣는다.
    const h = runtimeHarness();
    const { a, b } = h.ids;
    const { state } = h.taskforce.create({ name: "틈 TF", topic: "주제", members: [a, b] });
    const taskforceId = state.id;
    const direct = (callerId: string) =>
      Object.fromEntries(createCommodoreTools({ commodoreId: callerId, theaterRoot: h.theaterRoot, store: h.store, taskforce: h.taskforce }).map((tool) => [tool.name, tool])).memory_search!;
    const call = async (callerId: string, args: Record<string, unknown>) =>
      await direct(callerId).execute(args, { cwd: h.theaterRoot }) as { isError: boolean; structuredContent: Record<string, any> };
    h.taskforce.removeMember(taskforceId, a);
    const outside = h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: "WHILE_ABSENT" }).entry;
    h.taskforce.addMembers(taskforceId, [a]);
    h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: "AFTER_REJOIN" });
    const res = (await call(a, { anchor: { source: taskforceId, seq: outside.seq }, before: 0, after: 0 })).structuredContent as {
      anchorFound: boolean; items: { seq: number; readable: boolean; reason?: string }[];
    };
    expect(res.anchorFound).toBe(true);
    expect(res.items).toMatchObject([{ seq: outside.seq, readable: false, reason: "outside_participation" }]);
    expect(res.items[0]).not.toHaveProperty("text");
    expect(res.items[0]).not.toHaveProperty("at");
    expect(JSON.stringify(res)).not.toContain("WHILE_ABSENT");
  });

  it("rejects swapped TaskForce directories instead of reading through them", async () => {
    // 같은 TF root의 미참여 TF 디렉터리로 바꿔치기해도 다른 원장이 새지 않는다.
    const h = runtimeHarness();
    const { a, b } = h.ids;
    const outsider = randomUUID();
    const tf1 = h.taskforce.create({ name: "owned", topic: "topic", members: [a, b] }).state.id;
    h.taskforce.append(tf1, { speaker: { kind: "person" }, text: "own words" });
    const tf2 = h.taskforce.create({ name: "not-joined", topic: "private-topic", members: [b, outsider] }).state.id;
    h.taskforce.append(tf2, { speaker: { kind: "person" }, text: "OTHER_TF_DIRECTORY_SECRET" });
    const direct = (callerId: string) =>
      Object.fromEntries(createCommodoreTools({ commodoreId: callerId, theaterRoot: h.theaterRoot, store: h.store, taskforce: h.taskforce }).map((tool) => [tool.name, tool])).memory_search!;
    const call = async (callerId: string, args: Record<string, unknown>) =>
      await direct(callerId).execute(args, { cwd: h.theaterRoot }) as { isError: boolean; structuredContent: Record<string, any> };
    // 바꿔치기 전에는 a의 정상 참여 기록이 보인다.
    expect(((await call(a, { target: "taskforce", taskforceId: tf1 })).structuredContent as { results: unknown[] }).results).not.toEqual([]);
    const ownedDir = path.join(h.consoleDataDir, "taskforce", tf1);
    fs.renameSync(ownedDir, `${ownedDir}.backup`);
    fs.symlinkSync(path.join(h.consoleDataDir, "taskforce", tf2), ownedDir);
    const leaked = await call(a, { target: "taskforce", taskforceId: tf1, query: "OTHER_TF_DIRECTORY_SECRET" });
    expect(leaked.structuredContent).toMatchObject({ error: "unknown_taskforce" });
    expect(JSON.stringify(leaked)).not.toContain("OTHER_TF_DIRECTORY_SECRET");
    // 목록에도 바꿔치기된 자리가 올라오지 않는다.
    expect(h.taskforce.list().some((entry) => entry.id === tf1)).toBe(false);
    expect(() => h.taskforce.readLedger(tf1)).toThrow("unknown_taskforce");
  });

  it("recognizes anchor coverage that reaches the ledger start", async () => {
    // 2항목 원장의 anchor는 걷기가 시작점에 닿아 미확인이 아니라 원문이 보인다.
    const h = runtimeHarness();
    const { a, b } = h.ids;
    const { state } = h.taskforce.create({ name: "short", topic: "original topic", members: [a, b] });
    const taskforceId = state.id;
    h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: "early person request" });
    const direct = (callerId: string) =>
      Object.fromEntries(createCommodoreTools({ commodoreId: callerId, theaterRoot: h.theaterRoot, store: h.store, taskforce: h.taskforce }).map((tool) => [tool.name, tool])).memory_search!;
    const res = (await direct(a).execute({ anchor: { source: taskforceId, seq: 2 } }, { cwd: h.theaterRoot }) as { structuredContent: {
      anchorFound: boolean; items: { seq: number; readable: boolean; text?: string }[]; partial: boolean;
      sources: { status: string; participationUncertain?: boolean }[];
    } }).structuredContent;
    expect(res.anchorFound).toBe(true);
    expect(res.partial).toBe(false);
    expect(res.items).toMatchObject([
      { seq: 1, readable: true },
      { seq: 2, readable: true, text: "early person request" },
    ]);
    expect(res.sources).toMatchObject([{ status: "complete" }]);
    expect(res.sources[0]).not.toHaveProperty("participationUncertain");
  });

  it("accepts long cursors from many-source scans", async () => {
    // 32개 TF 이어읽기에서 나온 긴 cursor도 스키마를 통과해 다음 페이지를 잇는다.
    const h = runtimeHarness();
    const { a, b } = h.ids;
    const direct = (callerId: string) =>
      Object.fromEntries(createCommodoreTools({ commodoreId: callerId, theaterRoot: h.theaterRoot, store: h.store, taskforce: h.taskforce }).map((tool) => [tool.name, tool])).memory_search!;
    const call = async (callerId: string, args: Record<string, unknown>) =>
      await direct(callerId).execute(args, { cwd: h.theaterRoot }) as { isError: boolean; structuredContent: Record<string, any> };
    const ids: string[] = [];
    for (let k = 0; k < 32; k += 1) {
      const state = h.taskforce.create({ name: `tf-${k}`, topic: "topic", members: [a, b] }).state;
      ids.push(state.id);
      const dir = path.join(h.consoleDataDir, "taskforce", state.id);
      const rows = Array.from({ length: 2100 }, (_, i) => ({ seq: i + 1, at: 1700000000000 + i, speaker: { kind: "person" }, text: i < 100 ? "NEEDLE" : "ordinary", mentions: [] as string[] }));
      fs.writeFileSync(path.join(dir, "ledger.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ ...state, lastSeq: 2100 }));
      h.taskforce.forget(state.id);
    }
    const first = (await call(a, { target: "taskforce", query: "NEEDLE" })).structuredContent as { results: unknown[]; nextScan?: string };
    expect(first.results).toEqual([]);
    expect(typeof first.nextScan).toBe("string");
    const second = (await call(a, { target: "taskforce", query: "NEEDLE", scan: first.nextScan })).structuredContent as {
      results: { seq: number; source: { kind: string; id: string } }[]; hasMore: boolean; nextCursor?: string;
    };
    expect(second.results).toHaveLength(20);
    expect(second.hasMore).toBe(true);
    expect(typeof second.nextCursor).toBe("string");
    expect(second.nextCursor!.length).toBeGreaterThan(2048);
    expect(second.nextCursor!.length).toBeLessThanOrEqual(8192);
    const third = (await call(a, { target: "taskforce", query: "NEEDLE", cursor: second.nextCursor })).structuredContent as {
      isError?: boolean; results: { seq: number; source: { kind: string; id: string } }[]; hasMore: boolean; error?: string;
    };
    expect(third.error).toBeUndefined();
    expect(third.results).toHaveLength(20);
    // 페이지는 겹치지 않고 같은 스캔 범위 안에서 이어진다.
    const seen = new Set(second.results.map((item) => `${item.source.id}:${item.seq}`));
    expect(third.hasMore).toBe(true);
    for (const item of third.results) {
      expect(seen.has(`${item.source.id}:${item.seq}`)).toBe(false);
      seen.add(`${item.source.id}:${item.seq}`);
    }
    expect(seen.size).toBe(40);
  });

  it("skips finished sources when continuing into older ledger pages", async () => {
    // all+scan: 끝난 원장은 다시 읽지 않아 중복·낭비가 없다. 새로고침해야 새 원장이 보인다.
    const h = runtimeHarness();
    const { a, b } = h.ids;
    const { state } = h.taskforce.create({ name: "깊은 TF", topic: "주제", members: [a, b] });
    const taskforceId = state.id;
    const direct = (callerId: string) =>
      Object.fromEntries(createCommodoreTools({ commodoreId: callerId, theaterRoot: h.theaterRoot, store: h.store, taskforce: h.taskforce }).map((tool) => [tool.name, tool])).memory_search!;
    const call = async (callerId: string, args: Record<string, unknown>) =>
      await direct(callerId).execute(args, { cwd: h.theaterRoot }) as { isError: boolean; structuredContent: Record<string, any> };
    h.store.transcriptAppend(a, { kind: "text", text: "SHARED_NEEDLE in own" });
    h.store.transcriptAppend(a, { kind: "text", text: "ordinary own" });
    for (let seq = 2; seq <= 2500; seq += 1) {
      h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: seq === 2400 ? "SHARED_NEEDLE in tf-new" : seq >= 2 && seq <= 31 ? "SHARED_NEEDLE in tf-old" : `tf filler ${seq}` });
    }
    const first = (await call(a, { target: "all", query: "SHARED_NEEDLE", limit: 50 })).structuredContent as {
      results: { seq: number; source: { kind: string } }[]; nextScan?: string; nextCursor?: string; hasMore: boolean;
    };
    expect(first.results.map((item) => item.seq)).toEqual([2400, 1]);
    expect(first.results.map((item) => item.source.kind)).toEqual(["taskforce", "own"]);
    expect(first.hasMore).toBe(false);
    expect(typeof first.nextScan).toBe("string");
    expect(first.nextCursor).toBeUndefined();
    const second = (await call(a, { target: "all", query: "SHARED_NEEDLE", limit: 20, scan: first.nextScan })).structuredContent as {
      results: { seq: number; source: { kind: string } }[]; nextScan?: string; nextCursor?: string; hasMore: boolean; scanContinued?: boolean;
      sources: { source: { kind: string } }[];
    };
    expect(second.scanContinued).toBe(true);
    // 끝난 본인 기록은 다시 읽지 않아 중복이 없다 — 이어진 TF 범위만 새로 본다.
    expect(second.results.map((item) => item.seq)).toEqual(Array.from({ length: 20 }, (_, i) => 31 - i));
    expect(second.results.every((item) => item.source.kind === "taskforce")).toBe(true);
    expect(second.sources.every((entry) => entry.source.kind === "taskforce")).toBe(true);
    expect(second.hasMore).toBe(true);
    expect(second.nextScan).toBeUndefined();
    // cursor는 자신이 나온 스캔(TF만)을 재현한다 — 끝난 본인 결과가 다시 나타나지 않는다.
    const third = (await call(a, { target: "all", query: "SHARED_NEEDLE", limit: 20, cursor: second.nextCursor })).structuredContent as {
      results: { seq: number; source: { kind: string }; text: string }[]; hasMore: boolean; nextCursor?: string; nextScan?: string;
    };
    expect(third.results.map((item) => item.seq)).toEqual(Array.from({ length: 10 }, (_, i) => 11 - i));
    expect(third.results.every((item) => item.source.kind === "taskforce")).toBe(true);
    expect(third.hasMore).toBe(false);
    expect(third.nextScan).toBeUndefined();
  });

  it("pauses the chain at the chosen limit, never with no limit, never self-wakes, and keeps TF traffic out of 1:1 transcripts", async () => {
    vi.useFakeTimers();
    try {
      const h = runtimeHarness();
      const { a, b } = h.ids;
      const { state: created } = h.taskforce.create({ name: "출격 TF", topic: "오늘의 주제", members: [a, b] });
      const taskforceId = created.id;
      expect(created.chain.limit).toBe(15);
      // 제한 안 함 — 아래에서 사령관 발언이 15개 쌓여도 멈추지 않는다.
      h.taskforce.update(taskforceId, { chainLimit: null });
      h.supervisor.sync("started");
      // 사람의 말 — 두 성원이 판단 대상이다. Alpha는 세션을 먼저 교체한다.
      h.taskforce.append(taskforceId, { speaker: { kind: "person" }, text: "사람의 말" });
      h.supervisor.replaceSessionNext(a);
      await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
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
      await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
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

      // chain을 15까지 쌓는다 — Beta부터 번갈아 말한다. 제한 안 함이라 멈추지 않는다.
      const speakers = ["Beta", "Alpha", "Beta", "Alpha", "Beta", "Alpha", "Beta", "Alpha", "Beta", "Alpha", "Beta", "Alpha", "Beta", "Alpha"];
      const speak = async (alias: string, text: string) => {
        await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
        await post(alias, text);
        sessionOf(alias).finish();
        await vi.advanceTimersByTimeAsync(10);
      };
      for (const [index, alias] of speakers.entries()) await speak(alias, `${alias}의 말 ${index}`);
      expect(h.taskforce.read(taskforceId)!.chain).toEqual({ count: 15, limit: null, paused: false });
      // 상한을 15로 고르면 이미 넘긴 chain은 다음 사령관 발언에서 멈춘다.
      h.taskforce.update(taskforceId, { chainLimit: 15 });
      await speak("Beta", "Beta의 마지막 말");
      const final = h.taskforce.read(taskforceId)!;
      expect(final.counts).toEqual({ person: 2, commodore: 16 });
      expect(final.chain.count).toBe(16);
      expect(final.chain.paused).toBe(true);
      const codes = h.taskforce.readLedger(taskforceId).entries.flatMap((entry) => (entry.speaker.kind === "system" ? [entry.speaker.code] : []));
      expect(codes).toContain("chain-paused");
      // 멈춘 뒤에는 깨우지 않는다 — 마지막 말을 한 Beta도, 듣는 Alpha도 새 턴이 서지 않는다.
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
      await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
      sessionOf("Beta").finish();
      await vi.advanceTimersByTimeAsync(10);
      const r1 = lastSilentAt();
      h.supervisor.replaceSessionNext(b);
      h.store.transcriptAppend(b, { kind: "message", text: "1:1 말 2" });
      await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
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
      expect(listed.counts).toEqual({ person: 2, commodore: 16 });
      expect(listed.judging).toEqual([]);
      // 재기동 복원 — 말 수와 판단 스냅샷, 고른 상한이 함께 돌아온다.
      const root = path.join(h.consoleDataDir, "taskforce");
      expect(createTaskforceStore({ root, emit: () => undefined }).read(taskforceId)?.chain.limit).toBe(15);
      // 고정 12 시절의 state.json은 버려지지 않고 기본 상한 15로 읽힌다.
      const stateFile = path.join(root, taskforceId, "state.json");
      const stored = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      fs.writeFileSync(stateFile, JSON.stringify({ ...stored, chain: { ...stored.chain, limit: 12 } }));
      const restored = createTaskforceStore({ root, emit: () => undefined });
      expect(restored.read(taskforceId)?.chain.limit).toBe(15);
      expect(restored.read(taskforceId)?.counts).toEqual({ person: 2, commodore: 16 });
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
      await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
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
      await vi.advanceTimersByTimeAsync(TF_PERSON_QUIET_MS + 10);
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

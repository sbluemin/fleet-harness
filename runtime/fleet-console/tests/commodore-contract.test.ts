import type { CommodoreRouteContext } from "../features/commodore/host/routes.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createLaunchAttachmentStore } from "../features/execution/host/agent/launch-attachments.js";
import { MAX_COMMODORE_MESSAGE_IMAGE_BYTES } from "../features/commodore/shared/contracts/attachment-budget.js";
import type { AgentEvent, AgentInput, AgentSessionOptions } from "../features/execution/shared/agent.js";
import { CONVERSATION_REFERENCE_MARK as MARK } from "../features/execution/shared/conversation/references.js";
import { resolveRosterCoordinate, type ModelCoordinate } from "../features/ai-gateway/shared/models.js";
import { defineConsoleTool } from "../features/console-use/shared/actions.js";
import { DEFAULT_EXPERIMENT_SETTINGS, resolveExperimentSettings } from "../features/settings/shared/experiments.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { commodoreActive, createCommodoreRoutes, type CommodoreRouteHooks } from "../features/commodore/host/routes.js";
import type { ConsoleResidentAgentHost as AgentHost } from "../features/execution/host/agent/console-resident.js";
import { createCommodoreEntities } from "../features/commodore/host/entities.js";
import { workspaceHash } from "../features/workspace/host/theaters/theater-domain.js";
import { createCommodoreSession } from "../features/commodore/host/session.js";
import { createCommodoreStore as createHostStore, type CommodoreStoreOptions } from "../features/commodore/host/store.js";
import { COALESCE_MS, createCommodoreSupervisor as createHostSupervisor, RETRY_DELAYS_MS, type CommodoreSupervisorDeps } from "../features/commodore/host/supervisor.js";
import { COMMANDER_REST_MS, restClock } from "../features/objectives/shared/board-state.js";
import { patrolIntervalMs, MAX_TRANSCRIPT_TEXT, type CommodoreEvent } from "../features/commodore/shared/contracts/types.js";
import type { Objective, ObjectiveEvent } from "../features/objectives/shared/types.js";
import type { CommodoreAttachmentReader, CommodorePersonMessageReader } from "../features/objectives/shared/commodore-board.js";
import type { ConsoleMcpTool } from "../features/console-use/shared/tools.js";
import { createCommodoreBoardWatch, PLANNED_CHECK_MS, STALL_CHECK_MS, type CommodoreBoardWatchDeps } from "../features/objectives/host/commodore-board.js";

/** 이 파일의 단일 Theater fixture. 제품 저장소는 경로를 노출하지 않는 색인 포트를 받는다. */
function createCommodoreStore(options: Omit<CommodoreStoreOptions, "theatersOf" | "theaterIdsOf">) {
  return createHostStore({ ...options, theatersOf: (id) => [{ path: options.dirOf(id) ?? "/unavailable" }], theaterIdsOf: () => ["t1"] });
}

/** 기존 대표 시나리오는 실제 보드 어댑터와 feature의 SDK 경계를 함께 검증한다. */
function createCommodoreSupervisor(deps: Omit<CommodoreSupervisorDeps, "board" | "theaterIds" | "cwd"> & CommodoreBoardWatchDeps & {
  boardTools(theaterId: string, read: CommodoreAttachmentReader, hasMessage: CommodorePersonMessageReader): readonly ConsoleMcpTool[];
}) {
  return createHostSupervisor({ ...deps, theaterIds: () => ["t1"], cwd: (id) => deps.store.read(id) ? deps.theater("t1")?.root ?? null : null, board: () => ({
    tools: (theaterId, turn) => deps.boardTools(theaterId, turn.readAttachments, turn.hasPersonMessage),
    watch: (theaterId, sink) => createCommodoreBoardWatch(deps, theaterId, sink),
    objective: (theaterId, id) => {
      const objective = deps.objectives(theaterId).find((objective) => objective.id === id && !objective.removed);
      return objective ? { id: objective.id, commodoreId: theaterId, title: objective.title } : null;
    },
  }) });
}

/**
 * 사령관 Theater 상태의 필수 계약 — 보드 곁 `commodore/` 에 한 건으로 영속되고, 지시 개정은 본문이 바뀔 때만 오르며,
 * 자율 운영은 Theater 별로 켜고 끄며, 기록은 덧붙인 순서대로 쪽을 나눠 읽힌다.
 */

const TEST_PATROL_MS = 60 * 60_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function harness(now?: () => number, maxRetainedImageBytes?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-commodore-"));
  dirs.push(dir);
  const objectivesDir = path.join(dir, "workspaces", "project", "objectives");
  const events: CommodoreEvent[] = [];
  let experiments = { ...DEFAULT_EXPERIMENT_SETTINGS };
  let routeBody: unknown = {};
  let routeResult: { status: number; value: unknown } = { status: 0, value: null };
  let authorized = true;
  const ctx = {
    pluginId: "objectives",
    host: {
      security: { isTerminalAuthorized: () => authorized },
      http: { readJsonBody: async () => routeBody, writeJson: (_res: unknown, status: number, value: unknown) => { routeResult = { status, value }; } },
      experiments: { read: () => experiments },
    },
  } as unknown as CommodoreRouteContext;
  let clock = 1_000;
  const store = createCommodoreStore({ dirOf: (theaterId) => (theaterId === "t1" ? objectivesDir : null), emit: (event) => events.push(event), now: now ?? (() => clock++), ...(maxRetainedImageBytes !== undefined ? { maxRetainedImageBytes } : {}) });
  const route = async (name: string, body: Record<string, unknown>, hooks: CommodoreRouteHooks = {}, method?: string) => {
    routeBody = body;
    routeResult = { status: 0, value: null };
    const target = createCommodoreRoutes(ctx, store, { theaterIds: () => ["t1"], ...hooks }).find((entry) => entry.name === name)!;
    const query = new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)]));
    const res = {
      writeHead: (status: number, headers: unknown) => { routeResult = { status, value: { headers } }; },
      end: (bytes: Uint8Array) => { routeResult.value = { ...(routeResult.value as object), bytes }; },
    };
    await target.handler({ req: { method: method ?? target.method, url: `/${name}?${query}` } as never, res: res as never, pathname: name });
    return routeResult as { status: number; value: Record<string, unknown> & { state?: Record<string, unknown>; error?: string } };
  };
  return { ctx, store, events, route, objectivesDir, experiments: () => experiments, setExperiments: (next: Partial<typeof experiments>) => { experiments = resolveExperimentSettings({ ...experiments, ...next }); }, setAuthorized: (next: boolean) => { authorized = next; } };
}

describe("commodore theater state", () => {
  it("persists UUID entities with canonical single-Theater links and isolated patrol, directive and intel", async () => {
    const h = harness();
    // 엔티티 저장 무결성: id는 폴더에만, 연결은 path 하나만 남기고 색인은 재구성한다.
    const root = path.join(h.objectivesDir, "entities");
    const theater = path.join(h.objectivesDir, "theater");
    fs.mkdirSync(theater, { recursive: true });
    const canonical = fs.realpathSync.native(theater);
    const entities = createCommodoreEntities(root, workspaceHash);
    const id = entities.create(theater);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entities.create(theater)).toBe(id);
    const entityFile = path.join(root, id, "state.json");
    const disk = JSON.parse(fs.readFileSync(entityFile, "utf8"));
    expect(disk.theaters).toEqual([{ path: canonical }]);
    expect(disk).not.toHaveProperty("id");
    expect(entities.resolve(workspaceHash(canonical))).toBe(id);
    const entityEvents: CommodoreEvent[] = [];
    const entityStore = createHostStore({ dirOf: entities.dirOf, commodoreIds: entities.ids, theatersOf: entities.theatersOf, theaterIdsOf: entities.theaterIds, emit: (event) => entityEvents.push(event) });
    entityStore.setDirective(id, "Keep entity links intact.");
    // UUID 이름은 경로 연결·실행 설정과 독립적으로 보존된다.
    entityStore.setAlias(id, "Flagship");
    const reopenedEntity = createHostStore({ dirOf: entities.dirOf, commodoreIds: entities.ids, theatersOf: entities.theatersOf, theaterIdsOf: entities.theaterIds, emit: () => {} });
    expect(reopenedEntity.read(id)?.alias).toBe("Flagship");
    expect(reopenedEntity.read(id)?.patrolMinutes).toBeUndefined();
    reopenedEntity.setAlias(id, null);
    expect(JSON.parse(fs.readFileSync(entityFile, "utf8"))).not.toHaveProperty("alias");
    expect(JSON.parse(fs.readFileSync(entityFile, "utf8")).theaters).toEqual([{ path: canonical }]);
    expect(entityEvents[0]).toMatchObject({ commodoreId: id, theaterIds: [workspaceHash(canonical)] });
    expect(JSON.stringify(entityEvents)).not.toContain(canonical);
    const secondTheater = path.join(h.objectivesDir, "second");
    fs.mkdirSync(secondTheater);
    const secondId = entities.create(secondTheater);
    expect(() => entities.link(secondId, theater)).toThrow("theater_already_linked");
    // 손편집 중복과 링크·손상은 원본을 건드리지 않고 경고와 함께 제외한다.
    const loser = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    fs.mkdirSync(path.join(root, loser));
    const preserved = fs.readFileSync(entityFile, "utf8");
    fs.writeFileSync(path.join(root, loser, "state.json"), preserved);
    fs.symlinkSync(path.join(root, id), path.join(root, "00000000-0000-0000-0000-000000000000"));
    fs.mkdirSync(path.join(root, "invalid-id"));
    fs.writeFileSync(path.join(root, secondId, "state.json"), "broken");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const restored = createCommodoreEntities(root, workspaceHash);
      expect(restored.resolve(workspaceHash(canonical))).toBe(id);
      expect(restored.ids()).toEqual([id]);
      expect(fs.readFileSync(path.join(root, loser, "state.json"), "utf8")).toBe(preserved);
      expect(warn).toHaveBeenCalled();
      fs.rmSync(theater, { recursive: true });
      expect(createCommodoreEntities(root, workspaceHash).resolve(workspaceHash(canonical))).toBe(id);
    } finally { warn.mockRestore(); }
    const stateFile = path.join(h.objectivesDir, "state.json");

    h.setExperiments({ commodore: false }); // 옛 저장값은 사령관 표면을 숨기지 않는다.
    expect((await h.route("commodore/state", { commodoreId: "t1" })).value).toMatchObject({ enabled: true, active: false, run: { phase: "off", totals: { session: 0, costUsd: 0, actions: 0 } }, state: { directive: { text: "", rev: 0 }, intel: [] } });
    expect((await h.route("commodore/state", { commodoreId: "unknown" })).status).toBe(404);
    expect(fs.existsSync(stateFile)).toBe(false);
    expect(patrolIntervalMs(h.store.read("t1"))).toBeNull();
    expect(createCommodoreRoutes(h.ctx, h.store).some((route) => route.name === "commodore/autonomy")).toBe(false);
    expect((await h.route("commodore/patrol", { commodoreId: "t1", minutes: null })).status).toBe(400);
    // 별칭 쓰기는 실행이 꺼져 있어도 되고, 응답·재시작·사건은 같은 사령관 상태를 읽는다.
    expect((await h.route("commodore/alias", { commodoreId: "t1", alias: "  Flagship  " })).value).toMatchObject({ active: false, state: { alias: "Flagship" } });
    expect(createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined }).read("t1")?.alias).toBe("Flagship");
    expect(await h.route("commodore/alias", { commodoreId: "t1", alias: "abc\u202Egnp.exe" })).toMatchObject({ status: 400 });
    expect((await h.route("commodore/alias", { commodoreId: "t1", alias: null })).value.state).not.toHaveProperty("alias");
    expect(createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined }).read("t1")).not.toHaveProperty("alias");

    // 옛 Settings 좌표는 무시하지만 Theater 별 선택은 아래 경로에서 유지된다.
    h.setExperiments({ commodore: true, commodoreModel: "haiku", commodoreEffort: "low" });
    expect((await h.route("commodore/patrol", { commodoreId: "t1", minutes: 60 })).value).toMatchObject({ active: true, defaults: { model: "opus[1m]", effort: "high" }, run: { phase: "idle" } });
    expect(commodoreActive(h.ctx, h.store, "t1")).toBe(true);
    // 서랍의 요청이 사람의 언어를 남긴다 — 사령관 기록의 언어가 된다.
    expect((await h.route("commodore/state", { commodoreId: "t1", language: "ko" })).value.state).toMatchObject({ language: "ko" });

    // 지시 — 본문이 바뀔 때만 개정이 오르고, 같은 본문은 사건도 내지 않는다(사령관을 헛되이 깨우지 않는다).
    expect((await h.route("commodore/directive", { commodoreId: "t1", text: "Fix remote first." })).value.state).toMatchObject({ directive: { text: "Fix remote first.", rev: 1 } });
    const before = h.events.length;
    expect((await h.route("commodore/directive", { commodoreId: "t1", text: "Fix remote first." })).value.state).toMatchObject({ directive: { rev: 1 } });
    expect(h.events.length).toBe(before);

    // 정보 — 최신이 앞이고 출처는 사람이다.
    await h.route("commodore/intel/add", { commodoreId: "t1", text: "Users report dropped remote sessions." });
    const added = await h.route("commodore/intel/add", { commodoreId: "t1", text: "Pairing fails after sleep." });
    expect(added.value.state!.intel).toMatchObject([{ source: "person", text: "Pairing fails after sleep." }, { source: "person", text: "Users report dropped remote sessions." }]);
    expect((await h.route("commodore/intel/remove", { commodoreId: "t1", intelId: "nope" })).status).toBe(404);
    // 수정 — 그 자리에서 본문만 바뀌고 id·출처·자리·추가 시각은 그대로, editedAt 이 남는다. 같은 본문은 사건을 내지 않는다.
    const older = (added.value.state!.intel as { id: string; at: number }[])[1]!;
    const edited = await h.route("commodore/intel/edit", { commodoreId: "t1", intelId: older.id, text: "  Users report dropped remote sessions on Wi-Fi.  " });
    expect(edited.value.state!.intel).toMatchObject([{ text: "Pairing fails after sleep." }, { id: older.id, at: older.at, source: "person", text: "Users report dropped remote sessions on Wi-Fi.", editedAt: expect.any(Number) }]);
    const eventsBeforeSame = h.events.length;
    await h.route("commodore/intel/edit", { commodoreId: "t1", intelId: older.id, text: "Users report dropped remote sessions on Wi-Fi." });
    expect(h.events.length).toBe(eventsBeforeSame);
    expect((await h.route("commodore/intel/edit", { commodoreId: "t1", intelId: "nope", text: "x" })).status).toBe(404);
    expect((await h.route("commodore/intel/edit", { commodoreId: "t1", intelId: older.id, text: "   " })).status).toBe(400);
    expect((await h.route("commodore/coordinates", { commodoreId: "t1", model: "sonnet", effort: null })).status).toBe(400);
    // Gateway scoped Claude 표기도 받되 정준 id(실행 id)로 접어 저장한다.
    expect((await h.route("commodore/coordinates", { commodoreId: "t1", model: "claude--sonnet", effort: "xhigh" })).value.state).toMatchObject({ model: "sonnet[1m]", effort: "xhigh" });

    // 영속 — 새 저장소가 같은 파일에서 같은 상태를 읽는다. 옛 실험 설정은 자율 운영을 바꾸지 않는다.
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({ patrolMinutes: 60, directive: { rev: 1 }, model: "sonnet[1m]", effort: "xhigh" });
    expect(createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined }).read("t1")).toEqual(h.store.read("t1"));
    // 재시작 복원은 등록된 Theater 를 훑는다 — 읽을 수 없는 Theater 는 빠지고 던지지 않는다.
    expect(createCommodoreStore({ dirOf: (id) => (id === "t1" ? h.objectivesDir : null), commodoreIds: () => ["t1", "gone"], emit: () => undefined }).patrollingCommodores()).toEqual(["t1"]);
    h.setExperiments({ commodore: false });
    expect(commodoreActive(h.ctx, h.store, "t1")).toBe(true);
    expect(h.events.map((event) => event.op === "state" ? event.change : event.op)).toEqual(["alias", "alias", "patrol", "language", "directive", "intel", "intel", "intel-edited", "coordinates"]);

    // 저장된 스위치와 실행 가능 여부는 별개다. 보드 없는 view는 꺼짐이며 켜기 요청도 거절한다.
    expect((await h.route("commodore/state", { commodoreId: "t1" }, { boardReady: () => false })).value).toMatchObject({ boardReady: false, active: false, state: { patrolMinutes: 60 }, run: { phase: "off" } });
    expect(await h.route("commodore/patrol", { commodoreId: "t1", minutes: 60 }, { boardReady: () => false })).toMatchObject({ status: 409, value: { error: "commodore_inactive" } });
    expect(h.store.read("t1")!.patrolMinutes).toBe(60);
    // 같은 origin 의 Console 만 지난다.
    h.setAuthorized(false);
    expect((await h.route("commodore/state", { commodoreId: "t1" })).status).toBe(401);
    expect((await h.route("commodore/alias", { commodoreId: "t1", alias: "Forbidden" })).status).toBe(401);
    expect(h.store.read("t1")).not.toHaveProperty("alias");
  });

  it("refuses unavailable recipients but accepts messages with patrol off, appends the log in order and pages it from the newest end", async () => {
    const h = harness();
    h.store.transcriptAppend("t1", { kind: "session", event: "opened" });
    h.store.transcriptAppend("t1", { kind: "wake", reasons: ["directive changed"] });
    h.store.transcriptAppend("t1", { kind: "tool", name: "console_objectives", action: "complete", objectiveId: "o1", title: "Remote pairing" });
    // 그 Theater 의 자율 운영이 꺼져 있으면 메시지는 거절되고 기록에 남지 않는다.
    expect(await h.route("commodore/message", { commodoreId: "t1", text: "Lost?" })).toMatchObject({ status: 409, value: { error: "commodore_inactive" } });
    expect(h.store.transcriptRead("t1").entries).toHaveLength(3);
    h.store.setPatrol("t1", 60);
    // 설정은 켜졌지만 감독자 알림이 아직 오지 않은 경계 — 받을 runner가 없으면 기록도 남기지 않는다.
    expect(await h.route("commodore/message", { commodoreId: "t1", text: "Before the runner." }, { run: () => null })).toMatchObject({ status: 409, value: { error: "commodore_inactive" } });
    expect(h.store.transcriptRead("t1").entries).toHaveLength(3);
    const hooks: CommodoreRouteHooks = { acceptsMessage: () => true, run: () => ({ phase: "idle" }), objective: (id) => id === "missing" ? null : { id, commodoreId: id === "foreign" ? "t2" : "t1", title: id === "o1" ? "Small scope" : `Scope ${id}`, ...(id === "gone" ? { removed: { at: 1 } } : {}) } };
    expect((await h.route("commodore/message", { commodoreId: "t1", objectiveId: "foreign", text: "wrong scope" }, hooks)).value).toMatchObject({ error: "objective_owner_mismatch" });
    expect((await h.route("commodore/message", { commodoreId: "t1", objectiveId: "missing", text: "missing scope" }, hooks)).value).toMatchObject({ error: "unknown_objective" });
    // 본문 속 지휘관 참조 — 같은 Theater 의 지운 적 없는 목표만, 셋까지, 본문의 표식 글자 수와 짝이 맞을 때만 기록한다. 참조와 짝이 맞지
    // 않는 표식 글자는 거절한다(검증하지 않은 참조가 서지 않는다).
    for (const [body, error] of [
      [{ text: `${MARK} vs ${MARK}`, references: ["o2", "foreign"] }, "objective_owner_mismatch"],
      [{ text: `${MARK} ${MARK}`, references: ["o2", "missing"] }, "unknown_objective"],
      [{ text: MARK, references: ["gone"] }, "unknown_objective"],
      [{ text: MARK.repeat(4), references: ["o2", "o3", "o4", "o5"] }, "invalid_request"],
      [{ text: `typed ${MARK} by hand ${MARK}`, references: ["o2"] }, "invalid_request"],
      [{ text: MARK, references: ["o2", "o3"] }, "invalid_request"],
      [{ text: `${MARK}${MARK}`, references: ["o2", "o2"] }, "invalid_request"],
    ] as const) expect((await h.route("commodore/message", { commodoreId: "t1", ...body }, hooks)).value).toMatchObject({ error });
    expect(h.store.transcriptRead("t1").entries).toHaveLength(3);
    // 참조 없는 본문의 표식 글자(이미지 섞인 서식 글을 붙여 넣으면 브라우저가 만든다)는 지우고 받는다 — 참조는 서지 않는다.
    expect((await h.route("commodore/message", { commodoreId: "t1", text: `pasted ${MARK} note` }, hooks)).value.entry).toEqual(expect.objectContaining({ seq: 4, text: "pasted  note" }));
    expect(h.store.transcriptRead("t1").entries.at(-1)).not.toHaveProperty("references");
    h.store.setPatrol("t1", "off"); // 메시지는 순찰 안 함에서도 같은 범위 검증 뒤 전달된다.
    const text = `Compare ${MARK} with ${MARK}${MARK}; prefer small objectives.`;
    const sent = await h.route("commodore/message", { commodoreId: "t1", objectiveId: "o1", text, references: ["o2", "o3", "o4"] }, hooks);
    const references = [{ id: "o2", title: "Scope o2" }, { id: "o3", title: "Scope o3" }, { id: "o4", title: "Scope o4" }];
    expect(sent.value.entry).toMatchObject({ seq: 5, kind: "message", text, objective: { id: "o1", title: "Small scope" }, references });
    expect(createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined }).transcriptRead("t1").entries.at(-1)).toMatchObject({ objective: { id: "o1", title: "Small scope" }, references });
    expect(h.events.filter((event) => event.op === "transcript")).toHaveLength(5);
    h.store.setPatrol("t1", "off");
    expect(await h.route("commodore/message", { commodoreId: "t1", text: "Lost?" })).toMatchObject({ status: 409, value: { error: "commodore_inactive" } });

    const page = (await h.route("commodore/transcript", { commodoreId: "t1", limit: 2 })).value as { entries: { seq: number; kind: string }[]; hasMore: boolean };
    expect(page.entries.map((entry) => entry.seq)).toEqual([4, 5]);
    expect(page.hasMore).toBe(true);
    const older = (await h.route("commodore/transcript", { commodoreId: "t1", limit: 3, before: 4 })).value as { entries: { seq: number }[]; hasMore: boolean };
    expect(older.entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(older.hasMore).toBe(false);

    // 재기동 뒤에도 seq 는 이어진다 — 기록 파일이 커서의 진실이다.
    const reopened = createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined });
    expect(reopened.transcriptAppend("t1", { kind: "result", outcome: "ok", costUsd: 0.2 }).seq).toBe(6);
    expect((await h.route("commodore/retry", { commodoreId: "t1" }))).toMatchObject({ status: 409, value: { error: "commodore_not_retrying" } });
  });
  it("contains message previews and bounds copies by retained bytes and transcript history", async () => {
    const png = Buffer.from("iVBORw0KGgo=", "base64");
    const h = harness(undefined, png.byteLength * 2);
    const files = createLaunchAttachmentStore({ dataDir: h.objectivesDir });
    const attachments = files.forPlugin("objectives");
    Object.assign(h.ctx.host, { attachments });
    h.store.setPatrol("t1", 60);
    const hooks = { run: () => ({ phase: "idle" as const }) };
    const send = async () => {
      const { id } = files.save(png);
      const result = await h.route("commodore/message", { commodoreId: "t1", text: "Image", attachmentIds: [id] }, hooks);
      expect(result.status).toBe(200);
      const entry = result.value.entry as { messageId: string; attachments: { id: string; preview?: true }[] };
      return { entry, query: { commodoreId: "t1", messageId: entry.messageId, attachmentId: id } };
    };
    try {
      const old = await send();
      h.setAuthorized(false);
      expect((await h.route("commodore/attachment", old.query)).status).toBe(401);
      h.setAuthorized(true);
      expect((await h.route("commodore/attachment", old.query, {}, "POST")).status).toBe(405);
      expect((await h.route("commodore/attachment", { ...old.query, commodoreId: "t2" })).status).toBe(404);
      expect((await h.route("commodore/attachment", { ...old.query, attachmentId: "../state" })).status).toBe(400);
      const images = path.join(h.objectivesDir, "images");
      const file = path.join(images, old.entry.messageId, `${old.query.attachmentId}.png`);
      const outside = path.join(h.objectivesDir, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "secret.png"), png);
      fs.unlinkSync(file);
      fs.symlinkSync(path.join(outside, "secret.png"), file);
      expect((await h.route("commodore/attachment", old.query)).status).toBe(404);
      fs.unlinkSync(file);
      fs.writeFileSync(file, png);
      // 부모 링크도 거절한다. 사본 실패는 메시지를 잃게 하지 않고 참조 표시로 폴백한다.
      fs.renameSync(images, `${images}-saved`);
      fs.symlinkSync(outside, images);
      expect((await h.route("commodore/attachment", old.query)).status).toBe(404);
      const fallback = await send();
      expect(fallback.entry.attachments[0]).not.toHaveProperty("preview");
      expect(attachments.read("t1", fallback.entry.messageId)[0]!.bytes).toEqual(png);
      expect(fs.readdirSync(outside)).toEqual(["secret.png"]);
      fs.unlinkSync(images);
      fs.renameSync(`${images}-saved`, images);
      // 크기 합산은 링크를 따라가지 않는다. 텍스트가 작아도 사본 두 장의 총량 상한은 즉시 적용한다.
      fs.symlinkSync(path.join(outside, "secret.png"), path.join(path.dirname(file), "outside.png"));
      const middle = await send();
      expect((await h.route("commodore/attachment", old.query)).status).toBe(200);
      // mtime 을 뒤집어도 메시지 seq 가 가장 오래된 사본을 먼저 고른다. 방금 보낸 사본은 보존한다.
      fs.utimesSync(path.dirname(file), new Date("2099-01-01"), new Date("2099-01-01"));
      const newest = await send();
      expect((await h.route("commodore/attachment", old.query)).status).toBe(404);
      expect((await h.route("commodore/attachment", middle.query)).status).toBe(200);
      expect((await h.route("commodore/attachment", newest.query)).status).toBe(200);
      expect(fs.readdirSync(images).sort()).toEqual([middle.entry.messageId, newest.entry.messageId].sort());
      expect(fs.readFileSync(path.join(outside, "secret.png"))).toEqual(png);
      // 기록의 앞 절반이 떨어질 때 그 메시지 사본만 거둔다. 아직 남은 메시지의 사본은 보존한다.
      for (let index = 0; index < 240; index += 1) h.store.transcriptAppend("t1", { kind: "text", text: "x".repeat(MAX_TRANSCRIPT_TEXT) });
      const recent = await send();
      for (let index = 0; index < 50; index += 1) h.store.transcriptAppend("t1", { kind: "text", text: "x".repeat(MAX_TRANSCRIPT_TEXT) });
      expect(fs.existsSync(path.join(images, newest.entry.messageId))).toBe(false);
      expect((await h.route("commodore/attachment", newest.query)).status).toBe(404);
      expect((await h.route("commodore/attachment", recent.query))).toMatchObject({ status: 200, value: { bytes: png } });
      h.store.transcriptClear("t1");
      expect((await h.route("commodore/attachment", recent.query)).status).toBe(404);
      expect(fs.existsSync(images)).toBe(false);
    } finally { attachments.dispose(); files.cleanup(); }
  });
});

describe("commodore fleet-memory", () => {
  it("keeps entries in a contained three-level tree, rebuilds the index on every write and refuses secrets", async () => {
    let clock = 1_000;
    const h = harness(() => clock);
    const root = path.join(h.objectivesDir, "memory");
    const entry = { branch: "theater", topic: "실행 환경", slug: "isolated-console-env", title: "Isolated Console env", description: "Unset FLEET_* hijacks the live Console.", why: "The launcher honored inherited roots.", how: "Pass FLEET_DATA_DIR explicitly.", sources: [{ objectiveId: "o1", title: "Console e2e isolation" }] } as const;

    const saved = h.store.memory.save("t1", entry);
    expect(saved).toMatchObject({ ref: "theater/실행 환경/isolated-console-env", created: 1_000, updated: 1_000, verified: 1_000 });
    const file = path.join(root, "theater", "실행 환경", "isolated-console-env.md");
    expect(fs.readFileSync(file, "utf8")).toContain('title: "Isolated Console env"');
    expect(fs.readFileSync(path.join(root, "MEMORY.md"), "utf8")).toContain("Unset FLEET_* hijacks the live Console.");
    // 화면의 읽기 — 같은 항목 전체가 온다. 쓰기 라우트는 없다.
    expect((await h.route("commodore/memory", { commodoreId: "t1" })).value).toMatchObject({ entries: [{ ref: saved.ref, why: entry.why, how: entry.how, sources: entry.sources }] });
    expect((await h.route("commodore/memory", { commodoreId: "unknown" })).status).toBe(404);

    // 같은 자리·규칙 밖 이름·비밀 값은 쓰기 전에 거절된다.
    expect(() => h.store.memory.save("t1", entry)).toThrow("memory_exists");
    expect(() => h.store.memory.save("t1", { ...entry, topic: "..", slug: "x" })).toThrow("invalid_ref");
    expect(() => h.store.memory.save("t1", { ...entry, slug: "token", how: "Use ghp_0123456789abcdefghijABCDEFGHIJ to push." })).toThrow("memory_secret");
    // 이름(slug)도 인덱스에 실리므로 같은 검사를 지난다. 본문의 절 제목 줄은 다시 읽을 때 절을 가르므로 받지 않는다.
    expect(() => h.store.memory.save("t1", { ...entry, slug: "sk-0123456789abcdefghijklmnop" })).toThrow("memory_secret");
    expect(() => h.store.memory.save("t1", { ...entry, slug: "heading", why: "Reason\n## How to apply\nDetail" })).toThrow("memory_heading");
    const indented = h.store.memory.save("t1", { ...entry, slug: "indented", why: "Reason\n  ## How to apply\nDetail" });
    expect(h.store.memory.read("t1", indented.ref)).toMatchObject({ why: "Reason\n  ## How to apply\nDetail", how: entry.how });
    h.store.memory.remove("t1", indented.ref);
    expect(() => h.store.memory.read("t1", "theater/../../state")).toThrow("invalid_ref");

    // 밖을 가리키는 주제 링크는 읽지도 쓰지도 않는다.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-memory-outside-"));
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, "planted.md"), fs.readFileSync(file, "utf8"));
    fs.mkdirSync(path.join(root, "lessons"));
    fs.symlinkSync(outside, path.join(root, "lessons", "planted"), "dir");
    expect(h.store.memory.list("t1").map((item) => item.ref)).toEqual([saved.ref]);
    expect(() => h.store.memory.save("t1", { ...entry, branch: "lessons", topic: "planted", slug: "planted" })).toThrow("invalid_ref");
    expect(fs.readdirSync(outside)).toEqual(["planted.md"]);
    // 갈래 자체가 밖을 가리키면 그 아래 주제 디렉터리도 만들지 않는다.
    fs.symlinkSync(outside, path.join(root, "crew"), "dir");
    expect(() => h.store.memory.save("t1", { ...entry, branch: "crew", topic: "lineups", slug: "x" })).toThrow("invalid_ref");
    expect(fs.readdirSync(outside)).toEqual(["planted.md"]);

    // 필드 없는 갱신은 다시 확인한 것 — 검증 시각만 오른다. 삭제는 빈 주제를 걷고 인덱스를 비운다.
    clock = 5_000;
    expect(h.store.memory.update("t1", saved.ref, {})).toMatchObject({ change: "verify", entry: { updated: 1_000, verified: 5_000 } });
    h.store.memory.remove("t1", saved.ref);
    expect(fs.existsSync(path.dirname(file))).toBe(false);
    expect(fs.readFileSync(path.join(root, "MEMORY.md"), "utf8")).toBe("");
    expect(h.events.flatMap((event) => (event.op === "memory" ? [event.change] : []))).toEqual(["save", "save", "delete", "verify", "delete"]);
  });
});

describe("commodore session", () => {
  function agentStub() {
    const created: AgentSessionOptions[] = [];
    const sent: string[] = [];
    let emit: ((event: AgentEvent) => void) | undefined;
    let disposed = 0;
    const agent: AgentHost = {
      createSession: async (options) => {
        created.push(options);
        emit = options.onEvent;
        return {
          send: async (text) => { if (typeof text !== "string") throw new Error("Expected text-only turn"); sent.push(text); await script(text); },
          steer: () => false, cancel: () => undefined,
          dispose: async () => { disposed += 1; },
        };
      },
    };
    let script: (text: string) => Promise<void> = async () => undefined;
    return { agent, created, sent, emit: (event: AgentEvent) => emit?.(event), setScript: (next: typeof script) => { script = next; }, disposedCount: () => disposed };
  }

  it("opens a plugin-owned session with the base prompt only, wakes with reasons only, and keeps a redacted log", async () => {
    const h = harness();
    const theaterRoot = path.join(h.objectivesDir, "..", "..", "..", "theater");
    fs.mkdirSync(path.join(theaterRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(theaterRoot, "src", "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(theaterRoot, "secret.bin"), Buffer.from([0x00, 0x01]));
    const outside = path.join(h.objectivesDir, "..", "..", "..", "outside.txt");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(theaterRoot, "link.txt"));
    h.store.setDirective("t1", "Fix remote first.");
    h.store.addIntel("t1", { text: "older" });
    const newest = h.store.addIntel("t1", { text: "newest" }).item;
    h.store.setSources("t1", [{ kind: "github-issues", label: "feedback", locator: "acme/fleet" }, { kind: "url", label: "forum", locator: "https://example.test/forum" }]);
    const stub = agentStub();
    const wakes: { at: number; reason: string }[] = [];
    const commands: { file: string; args: readonly string[] }[] = [];
    const session = createCommodoreSession({
      commodoreId: "t1", cwd: h.objectivesDir, theaterLabel: "fleet-harness", theaterRoot, agent: stub.agent, store: h.store,
      coordinates: { model: "opus[1m]", effort: "high" }, boardTools: [
        defineConsoleTool({ name: "console_objectives", description: "list", actions: { inbox: { kind: "read", input: z.object({}) } } }).plugin({ execute: async () => ({ content: [] }) }),
        defineConsoleTool({ name: "console_objectives_detail", description: "objective", actions: { complete: { kind: "write", input: z.object({ objectiveId: z.string() }) } } })
          .plugin({ execute: async (args) => (args as { action?: unknown }).action === "complete" ? { content: [{ type: "text", text: JSON.stringify({ error: "not_awaiting_review", hint: "secret hint" }) }], isError: true } : { content: [] } }),
      ], onNextWake: (at, reason) => wakes.push({ at, reason }), now: () => 10_000,
      execute: async (file, args) => { commands.push({ file, args }); return file === "git" ? { stdout: "abc1234\x1f2026-10-03\x1fme\x1ffix: thing\n", stderr: "" } : { stdout: JSON.stringify([{ number: 7, title: "Pairing drops", state: "OPEN", updatedAt: "2026-10-01T00:00:00Z", labels: [{ name: "bug" }], url: "https://example.test/7" }]), stderr: "" }; },
    });

    stub.setScript(async () => {
      // 호스트처럼 도구를 먼저 실행하고(결과는 세션 이벤트에 실리지 않는다) tool-end 로 끝만 알린다.
      await stub.created[0]!.tools!.custom![1]!.tools[1]!.execute({ action: "complete", objectiveId: "o2" }, { cwd: theaterRoot, toolCallId: "u0" });
      stub.emit({ kind: "tool-start", id: "u0", name: "mcp__console__console_objectives_detail", input: { action: "complete", objectiveId: "o2" } });
      stub.emit({ kind: "tool-end", id: "u0", isError: true });
      stub.emit({ kind: "thinking", text: "The directive " }); stub.emit({ kind: "thinking", text: "changed." });
      stub.emit({ kind: "tool-start", id: "u1", name: "mcp__commodore__directive", input: {} });
      stub.emit({ kind: "tool-end", id: "u1", isError: false });
      stub.emit({ kind: "text", text: "Completing " }); stub.emit({ kind: "text", text: "the pairing objective." });
      stub.emit({ kind: "tool-start", id: "u2", name: "mcp__console__console_objectives_detail", input: { action: "complete", batchId: "secret detail that must not be logged", objectiveId: "o1", title: "Remote pairing" } });
      stub.emit({ kind: "tool-end", id: "u2", isError: false });
      stub.emit({ kind: "tool-start", id: "u3", name: "mcp__console__console_objectives", input: { action: "inbox" } });
      stub.emit({ kind: "tool-end", id: "u3", isError: false });
      stub.emit({ kind: "tool-start", id: "u4", name: "Read", input: { file_path: outside } });
      stub.emit({ kind: "tool-end", id: "u4", isError: false });
      stub.emit({ kind: "result", isError: false, source: "message", usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.25 } });
    });
    const outcome = await session.turn({ reasons: ["directive changed (rev 1)", "1 new intel item"] });
    expect(outcome).toMatchObject({ outcome: "ok", actions: 1, usage: { costUsd: 0.25 } });

    // 세션 — 베이스 프롬프트뿐이고 지시·정보 본문은 프롬프트에도 깨움 턴에도 없다.
    const options = stub.created[0]!;
    expect(options).toMatchObject({ model: "opus[1m]", effort: "high", continuation: "conversation", sessionName: "commodore-fleet-harness-t1" });
    expect(options.systemPrompt).toContain("owner UUID t1");
    expect(options.systemPrompt).toContain("The person reads the log in English.");
    expect(options.systemPrompt).not.toContain("Fix remote first.");
    expect(options.tools).toMatchObject({ builtins: ["WebSearch", "WebFetch", "Read"], browser: { scopeId: "commodore:t1" } });
    expect(options.tools!.consoleUse).toBeUndefined();
    expect(options.tools!.custom!.map((group) => [group.name, group.tools.map((tool) => tool.name)])).toEqual([["commodore", ["directive", "intel", "next_wake", "ask_person", "withdraw_ask", "asks", "memory_view", "memory_save", "memory_update", "memory_delete", "read_file", "git_log", "issue_list"]], ["console", ["console_objectives", "console_objectives_detail"]]]);
    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0]).toMatch(/^\[wake \d\d:\d\d · prompt v\d+\] directive changed \(rev 1\); 1 new intel item\.\n\nYour fleet-memory is empty\.$/);
    expect(stub.sent[0]).not.toContain("newest");

    // 기록 — 사고·텍스트는 블록으로, 보드 행위는 action·objectiveId·title 만, 도구 입력의 나머지는 없다.
    const log = h.store.transcriptRead("t1").entries;
    expect(log.map((entry) => entry.kind)).toEqual(["wake", "tool", "thinking", "tool", "text", "tool", "tool", "tool", "result"]);
    // 거절된 보드 행위는 코드 한 낱말로 남고 행위로 세지 않는다 — 결과의 힌트는 싣지 않는다.
    expect(log[1]).toMatchObject({ kind: "tool", name: "console_objectives_detail", action: "complete", objectiveId: "o2", ok: false, error: "not_awaiting_review" });
    expect(log[2]).toMatchObject({ kind: "thinking", text: "The directive changed." });
    expect(log[3]).toMatchObject({ kind: "tool", name: "directive", ok: true });
    expect(log[5]).toMatchObject({ kind: "tool", name: "console_objectives_detail", action: "complete", objectiveId: "o1", title: "Remote pairing", ok: true });
    expect(JSON.stringify(log)).not.toContain("secret");
    // 내장 Read의 Theater 밖 경로는 기록 요약에도 싣지 않는다.
    expect(log[7]).toMatchObject({ kind: "tool", name: "Read", ok: true });
    expect(log[7]).not.toHaveProperty("summary");
    expect(JSON.stringify(log)).not.toContain(outside);
    expect(log[8]).toMatchObject({ kind: "result", outcome: "ok", costUsd: 0.25, inputTokens: 1200 });
    expect(h.store.read("t1")!.run).toEqual({ session: 0, costUsd: 0.25, actions: 1 });

    // 사령관 전용 도구 — 지시·정보는 저장소에서, 읽기 도구는 Theater 안에서만.
    const tools = Object.fromEntries(options.tools!.custom![0]!.tools.map((tool) => [tool.name, tool]));
    const call = async (name: string, args: Record<string, unknown>) => await tools[name]!.execute(args, { cwd: theaterRoot }) as { isError: boolean; structuredContent: Record<string, unknown> };
    expect((await call("directive", {})).structuredContent).toMatchObject({ text: "Fix remote first.", rev: 1 });
    const intel = (await call("intel", {})).structuredContent as { items: { text: string }[]; sources: { kind: string }[] };
    expect(intel.items.map((item) => item.text)).toEqual(["newest", "older"]);
    expect(intel.sources.map((source) => source.kind)).toEqual(["github-issues", "url"]);
    expect(((await call("intel", { since: newest.id })).structuredContent as { items: unknown[] }).items).toEqual([]);
    // 이미 본 항목이 그 뒤에 고쳐지면 since 로도 보인다 — id 와 자리는 그대로, editedAt 이 붙는다.
    const olderId = h.store.read("t1")!.intel[1]!.id;
    h.store.editIntel("t1", olderId, "older, corrected");
    expect(((await call("intel", { since: newest.id })).structuredContent as { items: unknown[] }).items).toEqual([{ id: olderId, at: expect.any(String), editedAt: expect.any(String), source: "person", text: "older, corrected" }]);
    expect((await call("next_wake", { inMinutes: 30, reason: "no automatic wake" })).structuredContent).toMatchObject({ error: "patrol_off" });
    expect(wakes).toEqual([]);
    h.store.setPatrol("t1", 60);
    expect((await call("next_wake", { inMinutes: 30, reason: "patrol after the merge" })).isError).toBe(false);
    expect(wakes).toEqual([{ at: 10_000 + 30 * 60_000, reason: "patrol after the merge" }]);
    // 사람이 고른 순찰 간격(이 시나리오는 60분)을 넘는 예약은 거절하지 않고 간격으로 줄인다.
    expect((await call("next_wake", { inMinutes: 90, reason: "too far" })).structuredContent).toMatchObject({ patrolIntervalMinutes: 60, shortened: true });
    expect(wakes.at(-1)).toEqual({ at: 10_000 + 60 * 60_000, reason: "too far" });
    expect((await call("read_file", { path: "src/a.ts" })).structuredContent).toMatchObject({ text: "export const a = 1;\n", truncated: false });
    expect((await call("read_file", { path: "link.txt" })).structuredContent).toMatchObject({ error: "unsafe_path" });
    expect((await call("read_file", { path: "../outside.txt" })).structuredContent).toMatchObject({ error: "unsafe_path" });
    expect((await call("read_file", { path: outside })).structuredContent).toMatchObject({ error: "unsafe_path" });
    expect((await call("read_file", { path: "secret.bin" })).structuredContent).toMatchObject({ error: "binary_file" });
    expect((await call("git_log", { path: "--output=/tmp/x" })).structuredContent).toMatchObject({ error: "unsafe_path" });
    expect((await call("git_log", { limit: 5, path: "src" })).structuredContent).toMatchObject({ commits: [{ hash: "abc1234", subject: "fix: thing" }] });
    expect(commands.at(-1)).toEqual({ file: "git", args: ["log", "--no-decorate", "--date=short", "--format=%h%x1f%ad%x1f%an%x1f%s", "-n", "5", "--", "src"] });
    const sources = h.store.read("t1")!.sources;
    expect((await call("issue_list", { sourceId: sources[0]!.id })).structuredContent).toMatchObject({ issues: [{ number: 7, labels: ["bug"] }] });
    expect(commands.at(-1)).toMatchObject({ file: "gh", args: ["issue", "list", "-R", "acme/fleet", "--state", "open", "--limit", "30", "--json", "number,title,state,updatedAt,labels,url"] });
    expect((await call("issue_list", { sourceId: sources[1]!.id })).structuredContent).toMatchObject({ hint: expect.stringContaining("WebFetch") });

    // fleet-memory — 사령관 도구로만 쓰고, 다음 깨움부터 인덱스가 턴에 실린다. 출처는 이 Theater 보드의 목표만 받는다.
    expect((await call("memory_save", { branch: "lessons", topic: "Console E2E", slug: "offline-keeps-sse", title: "Offline keeps SSE", description: "CDP offline leaves an open EventSource alive.", why: "A reconnect repro stayed connected.", how: "Fire onerror on a hooked EventSource.", sourceObjectiveIds: ["elsewhere"] })).structuredContent).toMatchObject({ error: "unknown_objective" });
    expect((await call("memory_save", { branch: "lessons", topic: "Console E2E", slug: "offline-keeps-sse", title: "Offline keeps SSE", description: "CDP offline leaves an open EventSource alive.", why: "A reconnect repro stayed connected.", how: "Fire onerror on a hooked EventSource." })).structuredContent).toMatchObject({ ref: "lessons/Console E2E/offline-keeps-sse" });
    expect((await call("memory_view", {})).structuredContent).toMatchObject({ entries: [{ ref: "lessons/Console E2E/offline-keeps-sse" }] });

    // 턴 오류는 결말로 돌아오고 기록에 남는다; 폐기는 세션을 닫는다.
    stub.setScript(async () => { throw new Error("rate limit exceeded (429)"); });
    expect(await session.turn({ reasons: ["patrol"] })).toMatchObject({ outcome: "error", error: "rate_limited" });
    expect(stub.sent[1]).toContain("Your fleet-memory index (read an entry with memory_view):");
    expect(stub.sent[1]).toContain("CDP offline leaves an open EventSource alive.");
    expect(h.store.transcriptRead("t1").entries.at(-1)).toMatchObject({ kind: "result", outcome: "error", error: "rate_limited" });
    await session.dispose();
    expect(stub.disposedCount()).toBe(1);
    await expect(session.turn({ reasons: ["patrol"] })).rejects.toThrow("session_disposed");
  });
});

describe("commodore supervisor", () => {
  it("owns accepted images beyond the draft TTL, delivers blocks and releases success, clear and undelivered messages", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    const h = harness(Date.now);
    const files = createLaunchAttachmentStore({ dataDir: h.objectivesDir, now: Date.now });
    const attachments = files.forPlugin("objectives");
    Object.assign(h.ctx.host, { attachments });
    const turns: AgentInput[] = [];
    let readTurnAttachments: CommodoreAttachmentReader | undefined;
    let activeId: string | undefined;
    const copies: Uint8Array[] = [];
    const foreign = files.save(Buffer.from("iVBORw0KGgo=", "base64")).id;
    attachments.claim("t2", "another-message", [foreign], MAX_COMMODORE_MESSAGE_IMAGE_BYTES);
    const rejected: string[] = [];
    let fail = true;
    let created = 0;
    const agent: AgentHost = { createSession: async (options) => { created += 1; return ({
      send: async (input) => {
        turns.push(input);
        if (activeId && readTurnAttachments) {
          copies.push(readTurnAttachments([activeId])[0]!.bytes);
          try { readTurnAttachments([foreign]); } catch (error) { rejected.push((error as Error).message); }
        }
        options.onEvent?.({ kind: "result", isError: fail, source: "message", ...(fail ? { detail: "network" } : {}) });
      },
      steer: () => false, cancel() {}, dispose: async () => undefined,
    }); } };
    const supervisor = createCommodoreSupervisor({ store: h.store, agent, attachments, experiments: h.experiments, theater: () => ({ label: "test", root: h.objectivesDir }), objectives: () => [], subscribeObjectives: () => () => undefined, boardTools: (_theaterId, read) => { readTurnAttachments = read; return []; }, emit: () => undefined });
    const hooks = { acceptsMessage: (id: string) => supervisor.acceptsMessage(id), run: (id: string) => supervisor.status(id), clear: (id: string) => supervisor.clear(id) };
    const png = Buffer.from("iVBORw0KGgo=", "base64");
    const sendImage = async (bytes = png) => {
      const { id } = files.save(bytes);
      activeId = id;
      const result = await h.route("commodore/message", { commodoreId: "t1", text: "Look at this", attachmentIds: [id] }, hooks);
      return { id, result, entry: result.value.entry as { messageId: string } };
    };
    try {
      h.store.setPatrol("t1", 60);
      const accepted = await sendImage();
      expect(accepted.result.status).toBe(200);
      files.discard(accepted.id); // 브라우저의 늦은 제거는 서버가 수락한 메시지를 건드리지 못한다.
      expect(files.forPlugin("other").read("t1", accepted.entry.messageId)).toEqual([]);
      expect((await h.route("commodore/message", { commodoreId: "t1", text: "again", attachmentIds: [accepted.id] }, hooks)).status).toBe(400);
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      files.assertSaveCapacity();
      expect(attachments.read("t1", accepted.entry.messageId)[0]!.bytes).toEqual(png);
      // 실패 뒤의 보존은 다음 재시도 턴을 위한 것이다 — 턴 밖의 도구는 그 바이트를 읽지 못한다.
      expect(() => readTurnAttachments!([accepted.id])).toThrow("attachment_not_available");
      fail = false;
      await supervisor.retry("t1");
      const delivered = turns.at(-1)!;
      expect(typeof delivered).not.toBe("string");
      expect(delivered).toEqual(expect.arrayContaining([{ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }]));
      expect(attachments.read("t1", accepted.entry.messageId)).toEqual([]);
      // 전달 원본은 거뒀어도 기록 사본은 재시작 뒤까지 남고, 브라우저는 경로 없이 같은 출처 라우트로 읽는다.
      const previewQuery = { commodoreId: "t1", messageId: accepted.entry.messageId, attachmentId: accepted.id };
      expect(await h.route("commodore/attachment", previewQuery)).toMatchObject({ status: 200, value: { bytes: png, headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } } });
      expect(createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined }).images.read("t1", accepted.entry.messageId, accepted.id)?.bytes).toEqual(png);
      expect(JSON.stringify(accepted.result.value)).not.toContain(h.objectivesDir);
      expect(accepted.result.value.entry).toMatchObject({ attachments: [{ id: accepted.id, preview: true }] });
      expect(copies.at(-1)).toEqual(png);
      expect(rejected).toEqual(expect.arrayContaining(["attachment_not_available"]));
      expect(() => readTurnAttachments!([accepted.id])).toThrow("attachment_not_available");
      expect((delivered as Exclude<AgentInput, string>).filter((block) => block.type === "text").some((block) => block.text.includes(accepted.id))).toBe(true);
      // raw 12 MiB와 같아도 파일마다 붙는 padding으로 base64 16 MiB를 넘기 전에 교대한다.
      await supervisor.clear("t1");
      expect((await h.route("commodore/attachment", previewQuery)).status).toBe(404);
      expect(fs.existsSync(path.join(h.objectivesDir, "images"))).toBe(false);
      const beforeBudget = created;
      const fourMiB = Buffer.alloc(4 * 1024 * 1024); png.copy(fourMiB);
      for (let index = 0; index < 3; index += 1) {
        expect((await sendImage(fourMiB)).result.status).toBe(200);
        await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      }
      expect(created - beforeBudget).toBe(2);
      const tooLarge = Buffer.alloc(MAX_COMMODORE_MESSAGE_IMAGE_BYTES + 1); png.copy(tooLarge);
      const over = await sendImage(tooLarge);
      expect(over.result).toMatchObject({ status: 400, value: { error: "attachment_budget_exceeded" } });
      expect(files.resolve([over.id])).toHaveLength(1); files.unreserve([over.id]); files.discard(over.id);
      const cleared = await sendImage();
      await supervisor.clear("t1");
      expect(attachments.read("t1", cleared.entry.messageId)).toEqual([]);
      const stopped = await sendImage();
      h.store.setPatrol("t1", "off");
      await Promise.resolve(); await supervisor.dispose();
      expect(attachments.read("t1", stopped.entry.messageId)).toEqual([]);
      expect(h.store.transcriptRead("t1").entries.some((entry) => entry.kind === "undelivered")).toBe(true);
    } finally { await supervisor.dispose(); attachments.dispose(); files.cleanup(); vi.useRealTimers(); }
  });
  it("clears the active session and transcript without losing standing state or reviving deleted history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    const h = harness(Date.now);
    const sessions: { options: AgentSessionOptions; sent: string[]; disposed: boolean }[] = [];
    let hold = true;
    let cancel: (() => void) | undefined;
    const agent: AgentHost = { createSession: async (options) => {
      const entry = { options, sent: [] as string[], disposed: false }; sessions.push(entry);
      return {
        send: async (text) => { if (typeof text !== "string") throw new Error("Expected text-only turn"); entry.sent.push(text); if (hold) await new Promise<void>((resolve) => { cancel = () => { options.onEvent?.({ kind: "cancelled" }); resolve(); }; }); else options.onEvent?.({ kind: "result", isError: false, source: "message" }); },
        steer: () => false, cancel: () => cancel?.(), dispose: async () => { entry.disposed = true; },
      };
    } };
    const supervisor = createCommodoreSupervisor({ store: h.store, agent, experiments: h.experiments, theater: () => ({ label: "test", root: h.objectivesDir }), objectives: () => [], subscribeObjectives: () => () => undefined, boardTools: () => [], emit: () => undefined });
    const hooks = { acceptsMessage: (id: string) => supervisor.acceptsMessage(id), clear: (id: string) => supervisor.clear(id), run: (id: string) => supervisor.status(id) };
    try {
      h.setExperiments({ commodore: true });
      h.store.setDirective("t1", "Keep the directive.");
      h.store.addIntel("t1", { text: "Keep the intel." });
      h.store.setSources("t1", [{ kind: "url", label: "Reference", locator: "https://example.com" }]);
      h.store.setCoordinates("t1", { model: "sonnet", effort: "high" });
      h.store.setCommander("t1", { model: "opus[1m]", effort: "high" });
      h.store.setPatrol("t1", 120);
      h.store.setStopAt("t1", Date.now() + 3 * 60 * 60_000);
      h.store.transcriptAppend("t1", { kind: "message", text: "Old active instruction." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      h.store.transcriptAppend("t1", { kind: "message", text: "Old queued instruction." });
      const before = h.store.read("t1")!;
      const file = path.join(h.objectivesDir, "transcript.jsonl");
      const oldRaw = fs.readFileSync(file, "utf8");
      expect((await h.route("commodore/clear", { commodoreId: "t1" }, hooks)).status).toBe(400);
      h.setAuthorized(false);
      expect((await h.route("commodore/clear", { commodoreId: "t1", confirm: true }, hooks)).status).toBe(401);
      h.setAuthorized(true);
      expect((await h.route("commodore/clear", { commodoreId: "t1", confirm: true }, hooks)).status).toBe(200);
      expect(sessions[0]!.disposed).toBe(true);
      expect(h.store.read("t1")).toEqual({ ...before, transcriptClearedThrough: expect.any(Number) });
      expect(fs.existsSync(file)).toBe(false);
      expect(h.store.transcriptRead("t1").entries).toEqual([]);
      expect(supervisor.status("t1")).toMatchObject({ phase: "idle" });
      expect(supervisor.status("t1")?.context).toBeUndefined();
      // 폐기된 SDK의 늦은 스트림 콜백도 기록 파일을 되살릴 수 없다.
      sessions[0]!.options.onEvent?.({ kind: "text", text: "Late old response" });
      sessions[0]!.options.onEvent?.({ kind: "result", isError: false, source: "message" });
      expect(fs.existsSync(file)).toBe(false);
      // 경계 영속 뒤 파일 삭제 전에 내려간 경우도 새 저장소는 옛 줄을 감춘다.
      fs.writeFileSync(file, oldRaw);
      const reopened = createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined });
      expect(reopened.transcriptRead("t1").entries).toEqual([]);
      fs.rmSync(file);
      hold = false;
      h.store.transcriptAppend("t1", { kind: "message", text: "A fresh instruction." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      expect(sessions).toHaveLength(2);
      expect(sessions[1]!.sent[0]).toContain("A fresh instruction.");
      expect(sessions[1]!.sent[0]).not.toMatch(/Old active|Old queued|replacement session|recent actions/);
      expect(h.store.transcriptRead("t1").entries.every((entry) => entry.seq > h.store.read("t1")!.transcriptClearedThrough!)).toBe(true);
      expect(h.events.some((event) => event.op === "state" && event.change === "clear")).toBe(true);
      // 다른 창의 끄기가 runner를 목록에서 내린 직후에도, Clear는 그 세션의 마지막 기록까지 기다린다.
      hold = true;
      h.store.transcriptAppend("t1", { kind: "message", text: "Stopping while clearing." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      h.store.setPatrol("t1", "off");
      await supervisor.clear("t1");
      await vi.advanceTimersByTimeAsync(1);
      expect(fs.existsSync(file)).toBe(false);
      expect(h.store.transcriptRead("t1").entries).toEqual([]);
    } finally { await supervisor.dispose(); vi.useRealTimers(); }
  });
  it("persists a cancellable stop deadline, cancels pending work, notifies once and restores overdue stops without another patrol", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    const h = harness(Date.now);
    const sessions: { options: AgentSessionOptions; sent: string[]; disposed: boolean }[] = [];
    let hold = false;
    let failNotice = false;
    let cancel: (() => void) | undefined;
    const boardWrite = vi.fn(async () => ({ content: [] }));
    const agent: AgentHost = { createSession: async (options) => {
      const entry = { options, sent: [] as string[], disposed: false };
      sessions.push(entry);
      return {
        send: async (text) => {
          if (typeof text !== "string") throw new Error("Expected text-only turn"); entry.sent.push(text);
          if (failNotice) throw new Error("rate limit exceeded");
          if (hold) {
            await new Promise<void>((resolve) => { cancel = () => { options.onEvent?.({ kind: "cancelled" }); cancel = undefined; resolve(); }; });
          } else options.onEvent?.({ kind: "result", isError: false, source: "message" });
        },
        steer: () => false, cancel: () => cancel?.(),
        dispose: async () => { entry.disposed = true; },
      };
    } };
    const makeSupervisor = (store = h.store) => createCommodoreSupervisor({
      store, agent, experiments: h.experiments, theater: () => ({ label: "test", root: h.objectivesDir }),
      objectives: () => [], subscribeObjectives: () => () => undefined,
      boardTools: () => [{ name: "console_objectives_detail", description: "", inputSchema: {}, execute: boardWrite }], emit: () => undefined,
    });
    let supervisor = makeSupervisor();
    const hooks = { acceptsMessage: (id: string) => supervisor.acceptsMessage(id), run: (id: string) => supervisor.status(id) };
    const schedule = (stopAt: number | null) => h.route("commodore/stop-at", { commodoreId: "t1", stopAt }, hooks);
    try {
      expect((await schedule(Date.now() + 60_000)).status).toBe(409);
      h.setExperiments({ commodore: true, commodoreModel: "haiku", commodoreEffort: "low" });
      h.store.setPatrol("t1", 60);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      expect(sessions[0]!.options).toMatchObject({ model: "opus[1m]", effort: "high" });
      expect((await schedule(Date.now() - 1)).status).toBe(400);
      expect((await schedule(Date.now() + 31 * 86_400_000)).status).toBe(200);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.store.read("t1")!.patrolMinutes).toBe(60);
      const cancelledAt = Date.now() + 1_000;
      await schedule(cancelledAt);
      expect((await schedule(null)).value.state?.stopAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_001);
      expect(sessions[0]!.sent).toHaveLength(1);
      h.store.setDirective("t1", "Keep the board intact.");
      h.store.addIntel("t1", { text: "Keep this intel." });
      hold = true;
      const active = h.store.transcriptAppend("t1", { kind: "message", text: "Interrupt me." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      const pending = h.store.transcriptAppend("t1", { kind: "message", text: "Return me to the person." });
      const stopAt = Date.now() + 1_000;
      expect((await schedule(stopAt)).value.state?.stopAt).toBe(stopAt);
      expect(createCommodoreStore({ dirOf: () => h.objectivesDir, emit: () => undefined }).read("t1")!.stopAt).toBe(stopAt);
      // 종료 알림도 진행 중으로 붙들어 둔다. 그 동안 메시지·보드 쓰기는 받아서는 안 된다.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sessions[0]!.sent).toHaveLength(3);
      expect(sessions[0]!.sent.at(-1)).toContain("The scheduled end time has arrived");
      expect(sessions[0]!.sent.at(-1)).not.toContain("Return me to the person.");
      expect((await h.route("commodore/message", { commodoreId: "t1", text: "Too late." }, hooks)).value.error).toBe("commodore_stopping");
      expect((await schedule(null)).value.error).toBe("commodore_stopping");
      const tool = sessions[0]!.options.tools!.custom!.flatMap((group) => group.tools).find((tool) => tool.name === "console_objectives_detail")!;
      expect(await tool.execute({ action: "complete" }, { cwd: h.objectivesDir })).toMatchObject({ isError: true });
      expect(boardWrite).not.toHaveBeenCalled();
      h.store.addIntel("t1", { text: "No new wake." });
      await vi.advanceTimersByTimeAsync(30_001);
      expect(h.store.read("t1")).toMatchObject({ patrolMinutes: "off", directive: { text: "Keep the board intact." } });
      expect(h.store.read("t1")!.stopAt).toBeUndefined();
      expect(h.store.read("t1")!.intel).toHaveLength(2);
      expect(sessions[0]!.disposed).toBe(true);
      expect(supervisor.status("t1")).toBeNull();
      const entries = h.store.transcriptRead("t1").entries;
      expect(entries.filter((entry) => entry.kind === "undelivered")).toMatchObject([{ seqs: [active.seq, pending.seq] }]);
      expect(entries.filter((entry) => entry.kind === "wake" && entry.reasons.includes("scheduled-stop"))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(TEST_PATROL_MS);
      expect(sessions[0]!.sent).toHaveLength(3);

      // 정상 알림 결말에서도 끄기와 같은 상태가 된다. 껐다 켜면 지난 예약은 되살아나지 않는다.
      hold = false;
      h.store.setPatrol("t1", 60);
      await schedule(Date.now() + COALESCE_MS + 1_000);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1_001);
      expect(sessions.at(-1)!.sent).toHaveLength(2);
      expect(sessions.at(-1)!.sent.at(-1)).toContain("The scheduled end time has arrived");
      expect(h.store.transcriptRead("t1").entries.slice(-2)).toMatchObject([{ kind: "result", outcome: "ok" }, { kind: "session", event: "stopped" }]);
      expect(h.store.read("t1")!.patrolMinutes).toBe("off");
      expect(sessions.at(-1)!.disposed).toBe(true);

      // 예약을 남긴 채 Console이 종료되고 기한 뒤 재기동하면, 재시작 순찰 대신 종료 알림만 한 번 간다.
      h.store.setPatrol("t1", 60);
      await schedule(Date.now() + 60_000);
      await supervisor.dispose();
      await vi.advanceTimersByTimeAsync(60_001);
      const restored = createCommodoreStore({ dirOf: () => h.objectivesDir, commodoreIds: () => ["t1"], emit: () => undefined });
      failNotice = true;
      supervisor = makeSupervisor(restored);
      supervisor.sync("restart");
      await vi.advanceTimersByTimeAsync(1);
      expect(sessions.at(-1)!.sent).toHaveLength(1);
      expect(sessions.at(-1)!.sent[0]).toContain("The scheduled end time has arrived");
      expect(sessions.at(-1)!.sent[0]).toContain("board actions");
      expect(sessions.at(-1)!.sent[0]).not.toContain("Console restarted;");
      expect(restored.read("t1")!.patrolMinutes).toBe("off");
      expect(restored.read("t1")!.stopAt).toBeUndefined();
      expect(sessions.at(-1)!.disposed).toBe(true);
      expect(supervisor.status("t1")).toBeNull();
      await vi.advanceTimersByTimeAsync(TEST_PATROL_MS);
      expect(sessions.at(-1)!.sent).toHaveLength(1);
    } finally { await supervisor.dispose(); vi.useRealTimers(); }
  });
  it("hands messages to the running turn, returns unread ones to the queue, and opens a fresh conversation with a transcript summary across restarts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    try {
      const h = harness(Date.now);
      h.setExperiments({ commodore: true });
      h.store.setPatrol("t1", 60);
      const theaterRoot = path.join(h.objectivesDir, "..", "..", "..", "theater");
      fs.mkdirSync(theaterRoot, { recursive: true });
      // 남는 대화를 흉내 내는 호스트 — key 마다 대화가 남고, 같은 key 로 다시 열면 이어 받는다. 도는 턴은 건넨 말을 받는다.
      const sessions: { sent: string[]; steered: { text: string; id: string }[]; emit: (event: AgentEvent) => void; finish: () => void }[] = [];
      const agent: AgentHost = {
        createSession: async (options) => {
          let finish = () => {};
          const entry = { sent: [] as string[], steered: [] as { text: string; id: string }[], emit: (event: AgentEvent) => options.onEvent?.(event), finish: () => finish() };
          sessions.push(entry);
          let turning = false; let cancelled = false;
          return {
            send: async (text) => { entry.sent.push(text as string); turning = true; cancelled = false; await new Promise<void>((resolve) => { finish = resolve; }); turning = false; options.onEvent?.(cancelled ? { kind: "cancelled" } : { kind: "result", isError: false, source: "message" }); },
            steer: (text, id) => { if (!turning) return false; entry.steered.push({ text: text as string, id }); return true; },
            cancel: () => { for (const { id } of entry.steered) options.onEvent?.({ kind: "input-cancelled", id }); cancelled = true; finish(); },
            dispose: async () => undefined,
          };
        },
      };
      let hasPersonMessage: (() => boolean) | undefined;
      const make = () => createCommodoreSupervisor({ store: h.store, agent, experiments: () => h.experiments(), theater: () => ({ label: "x", root: theaterRoot }), objectives: () => [], subscribeObjectives: () => () => undefined, boardTools: (_theaterId, _readAttachments, hasMessage) => { hasPersonMessage = hasMessage; return []; }, emit: () => undefined });
      let supervisor = make();
      supervisor.sync("patrol-started");
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.sent).toHaveLength(1);
      expect(hasPersonMessage!()).toBe(false);
      // 턴 중의 말 — 다음 턴을 기다리지 않고 도는 턴에 건넨다. 그 턴이 집으면 「전달됨」이 남고 다음 턴은 서지 않는다.
      const read = h.store.transcriptAppend("t1", { kind: "message", text: "Use Muse Spark for new commanders." });
      expect(sessions[0]!.steered).toEqual([{ text: expect.stringContaining("Use Muse Spark for new commanders."), id: `m${read.seq}` }]);
      expect(hasPersonMessage!()).toBe(false);
      sessions[0]!.emit({ kind: "input-started", id: `m${read.seq}` });
      expect(hasPersonMessage!()).toBe(true);
      expect(h.store.transcriptRead("t1").entries.at(-1)).toMatchObject({ kind: "delivered", seqs: [read.seq] });
      // 집히지 못한 말은 대기열로 돌아와 다음 턴에 실린다 — 잃지 않는다.
      const unread = h.store.transcriptAppend("t1", { kind: "message", text: "And check the roster." });
      sessions[0]!.emit({ kind: "input-cancelled", id: `m${unread.seq}` });
      sessions[0]!.finish();
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions[0]!.sent).toHaveLength(2);
      expect(sessions[0]!.sent[1]).toContain("And check the roster.");
      expect(sessions[0]!.sent[1]).not.toContain("Use Muse Spark");
      expect(hasPersonMessage!()).toBe(true);
      sessions[0]!.finish();
      await vi.advanceTimersByTimeAsync(10);
      expect(hasPersonMessage!()).toBe(false);

      // Console 재시작 — 새 대화의 첫 턴은 제품 기록의 최근 결과 요약과 restart·empty 깨움이다.
      await supervisor.dispose();
      supervisor = make();
      supervisor.sync("restart");
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(2);
      expect(sessions[1]!.sent).toHaveLength(1);
      expect(sessions[1]!.sent[0]).toContain("Console restarted");
      expect(sessions[1]!.sent[0]).toContain("2026-10-17T12:");
      expect(sessions[1]!.sent[0]).toContain("board actions");
      expect(h.store.read("t1")!.run!.session).toBe(2);
      sessions[1]!.finish();
      await vi.advanceTimersByTimeAsync(10);
      expect(supervisor.status("t1")).toMatchObject({ phase: "idle" });
      // 끊긴 턴의 말은 새 대화에 다시 싣는다.
      const cut = h.store.transcriptAppend("t1", { kind: "message", text: "Recheck the roster." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions.at(-1)!.sent.at(-1)).toContain("Recheck the roster.");
      h.store.setPatrol("t1", "off");
      await supervisor.dispose(); // Console 종료는 진행 턴을 취소하고 미전달 말을 보존한다.
      supervisor = make();
      supervisor.sync("restart");
      await vi.advanceTimersByTimeAsync(TEST_PATROL_MS);
      expect(sessions).toHaveLength(2);
      const lines = () => h.store.transcriptRead("t1").entries.flatMap((entry) => (entry.kind === "undelivered" || entry.kind === "requeued" ? [`${entry.kind}:${entry.seqs.join(",")}`] : []));
      expect(lines().at(-1)).toBe(`undelivered:${cut.seq}`);
      // 다시 실었다가 전달 전에 또 끊기면 다시 「전달되지 않음」이고, 다음에 서면 그 말이 또 실린다 — 가장 늦은 행방이 이긴다.
      h.store.setPatrol("t1", 60); await vi.advanceTimersByTimeAsync(10);
      h.store.setPatrol("t1", "off"); await vi.advanceTimersByTimeAsync(10);
      expect(lines().slice(-2)).toEqual([`requeued:${cut.seq}`, `undelivered:${cut.seq}`]);
      h.store.setPatrol("t1", 60); await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(lines().at(-1)).toBe(`requeued:${cut.seq}`);
      expect(sessions.at(-1)!.sent.at(-1)).toContain("Recheck the roster.");
      sessions.at(-1)!.finish(); await vi.advanceTimersByTimeAsync(10);
      // Clear 는 남은 대화를 버린다 — 다음 세션은 새 대화다.
      await supervisor.clear("t1");
      h.store.transcriptAppend("t1", { kind: "message", text: "After clear." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions.at(-1)!.sent[0]).not.toContain("board actions");
      sessions.at(-1)!.finish();
      await vi.advanceTimersByTimeAsync(10);
      await supervisor.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("keeps off dormant across restart and automatic events, delivers held input on a message and closes a late-opening session", async () => {
    vi.useFakeTimers();
    const h = harness(Date.now);
    const held = h.store.transcriptAppend("t1", { kind: "message", text: "Held before restart." });
    h.store.transcriptAppend("t1", { kind: "undelivered", seqs: [held.seq] });
    const { ask } = h.store.askAdd("t1", { questions: [{ text: "Which direction?", options: [] }], reason: "Need direction", objective: null });
    h.store.askAnswer("t1", ask.id, [{ questionId: ask.questions[0]!.id, selectedOptionIds: [], text: "Keep it small." }]);
    let release: (() => void) | undefined;
    let delayOpen = false;
    let failMessage = false;
    const sent: string[] = [];
    const disposed = vi.fn();
    const agent: AgentHost = {
      createSession: async (options) => {
        if (delayOpen) await new Promise<void>((resolve) => { release = resolve; });
        return { send: async (input) => { sent.push(input as string); options.onEvent?.({ kind: "result", isError: failMessage, source: "message", ...(failMessage ? { detail: "network" } : {}) }); }, steer: () => false, cancel: () => undefined, dispose: async () => { disposed(); } };
      },
    };
    const objectives: Objective[] = [];
    const listeners: ((event: ObjectiveEvent) => void)[] = [];
    const notifyCommanderRest = vi.fn(async () => true);
    const supervisor = createCommodoreSupervisor({
      store: h.store, agent, experiments: h.experiments, theater: () => ({ label: "test", root: h.objectivesDir }),
      objectives: () => objectives, subscribeObjectives: (listener) => { listeners.push(listener); return () => undefined; }, boardTools: () => [], emit: () => undefined,
      observe: restClock(() => ({ lifecycle: "live", activity: "idle", surface: "chat", supportedActions: [], attention: { kind: "none" }, output: { revision: 0, outcome: "none" } } as never)),
      notifyCommanderRest,
    });
    const hooks = { acceptsMessage: supervisor.acceptsMessage, run: supervisor.status };
    try {
      expect(patrolIntervalMs(h.store.read("t1"))).toBeNull();
      supervisor.sync("restart");
      h.store.setDirective("t1", "Do not wake automatically.");
      h.store.addIntel("t1", { text: "Wait for a message." });
      await vi.advanceTimersByTimeAsync(24 * TEST_PATROL_MS);
      expect(sent).toEqual([]);
      expect((await h.route("commodore/message", { commodoreId: "t1", text: "Read the waiting input." }, hooks)).status).toBe(200);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("Held before restart.");
      expect(sent[0]).toContain("Which direction?");
      expect((await h.route("commodore/state", { commodoreId: "t1" }, hooks)).value.active).toBe(false);
      expect((await h.route("commodore/stop-at", { commodoreId: "t1", stopAt: Date.now() + TEST_PATROL_MS }, hooks)).value.error).toBe("commodore_inactive");
      h.store.setDirective("t1", "Still do not wake automatically.");
      h.store.addIntel("t1", { text: "Still wait." });
      objectives.push({ id: "waiting", theaterId: "t1", title: "Waiting", createdAt: Date.now(), commodoreOperated: true, done: null, removed: null, commenced: true, planning: false, members: [], awaitingReview: false, awaitingHandoff: false, decisionRequest: null, criteriaProposals: [], followups: [], followupBatches: [], missions: [{ id: "m1", text: "Waiting work", done: false }] } as unknown as Objective);
      for (const listener of listeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "waiting" });
      supervisor.sync("restart");
      await vi.advanceTimersByTimeAsync(24 * TEST_PATROL_MS);
      expect(sent).toHaveLength(1);
      expect(notifyCommanderRest).not.toHaveBeenCalled();
      // 안 함의 실패는 자동 재시도하지 않는다. 새 사람 메시지는 다시 시도할 명시적인 이유다.
      failMessage = true;
      await h.route("commodore/message", { commodoreId: "t1", text: "A failed message." }, hooks);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      expect(supervisor.status("t1")).toMatchObject({ phase: "error" });
      expect(supervisor.status("t1")?.nextWakeAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(24 * TEST_PATROL_MS);
      expect(sent).toHaveLength(2);
      failMessage = false;
      await h.route("commodore/message", { commodoreId: "t1", text: "Try with this new message." }, hooks);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      expect(sent).toHaveLength(3);
      // 메시지 전용 실행기가 오류로 쉰 뒤 순찰을 켜면 즉시 재시도하고 자동 재시도 사다리도 다시 선다.
      failMessage = true;
      await h.route("commodore/message", { commodoreId: "t1", text: "Fail before enabling patrol." }, hooks);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      expect(sent).toHaveLength(4);
      expect(supervisor.status("t1")).toMatchObject({ phase: "error" });
      expect(supervisor.status("t1")?.nextWakeAt).toBeUndefined();
      h.store.setPatrol("t1", 15);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      expect(sent).toHaveLength(5);
      expect(supervisor.status("t1")).toMatchObject({ phase: "retrying" });
      expect(supervisor.status("t1")!.nextWakeAt).toBeGreaterThan(Date.now() + RETRY_DELAYS_MS[0]! - 10);
      expect(supervisor.status("t1")!.nextWakeAt).toBeLessThanOrEqual(Date.now() + RETRY_DELAYS_MS[0]!);
      failMessage = false;
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]! + 1);
      expect(sent).toHaveLength(6);
      expect(supervisor.status("t1")).toMatchObject({ phase: "idle" });
      expect(supervisor.status("t1")!.nextWakeAt).toBeGreaterThan(Date.now());
      h.store.setPatrol("t1", "off");
      await vi.advanceTimersByTimeAsync(1);
      expect(disposed).toHaveBeenCalledTimes(1);
      // 순찰 시작으로 세션이 열리는 도중 안 함으로 바꾸면, 늦게 열린 자식도 턴 없이 닫힌다.
      delayOpen = true;
      h.store.setPatrol("t1", 60);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
      expect(release).toBeDefined();
      h.store.setPatrol("t1", "off");
      release!();
      await vi.advanceTimersByTimeAsync(1);
      expect(disposed).toHaveBeenCalledTimes(2);
      expect(sent).toHaveLength(6);
      expect(supervisor.status("t1")).toBeNull();
    } finally { release?.(); await supervisor.dispose(); vi.useRealTimers(); }
  });

  it("restores on register, coalesces wake reasons, patrols within the ceiling, retries failures, compacts long sessions in place, replaces sessions on new coordinates and finishes the active turn when patrol is off", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    try {
      const h = harness();
      // Theater 모델은 Gateway에서 꺼져 있다 — 저장값은 그대로 두고 로스터 폴백(sonnet)으로 열며 그 사실을 기록에 남긴다.
      h.setExperiments({ commodore: true });
      h.store.setCoordinates("t1", { model: "codex--gpt-6-luna", effort: "medium" });
      const sonnetRow = { id: "sonnet", label: "Sonnet", launch: { model: "sonnet" }, chips: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ id: effort, label: effort, launch: { model: "sonnet", effort } })) };
      // 설치된 Claude Code가 별칭을 푸는 정식 id — 사령관은 그 id로 열고, 회전은 별칭 좌표로 판정한다.
      const models = {
        resolve: (stored: ModelCoordinate, _target: unknown, fallback?: ModelCoordinate) => ({ ...resolveRosterCoordinate([{ id: "gateway:claude", label: "Claude", rows: [sonnetRow] }], stored, fallback ?? { model: "sonnet" }), wireModel: "sonnet" }),
        pinClaudeVersion: async (model: string) => model === "sonnet" ? "claude-sonnet-installed" : model,
      };
      h.store.setPatrol("t1", 60);
      h.store.setLanguage("t1", "ko");
      const theaterRoot = path.join(h.objectivesDir, "..", "..", "..", "theater");
      fs.mkdirSync(theaterRoot, { recursive: true });
      const sessions: { options: AgentSessionOptions; sent: string[]; disposed: boolean }[] = [];
      let fail: string | null = null;
      let inputTokens = 1_000;
      let compaction: { readonly preTokens: number; readonly postTokens: number } | null = null;
      let compactionFails = false;
      let holdTurn = false;
      let completeOnCancel = false;
      let cancelTurn: (() => void) | undefined;
      const agent: AgentHost = {
        createSession: async (options) => {
          const entry = { options, sent: [] as string[], disposed: false };
          sessions.push(entry);
          return {
            send: async (text) => {
              if (typeof text !== "string") throw new Error("Expected text-only turn"); entry.sent.push(text);
              if (fail) throw new Error(fail);
              if (holdTurn) {
                await new Promise<void>((resolve) => { cancelTurn = () => { options.onEvent?.(completeOnCancel ? { kind: "result", isError: false, source: "message" } : { kind: "cancelled" }); cancelTurn = undefined; resolve(); }; });
                return;
              }
              if (compaction) { options.onEvent?.({ kind: "compacted", trigger: "auto", ...compaction }); compaction = null; }
              // 요약이 실패한 채 창을 넘긴 세션 — Claude Code(2.1.296 실측)는 압축 실패를 알리고 턴을 오류로 끝내며, 다음 턴도 같다.
              if (compactionFails) {
                options.onEvent?.({ kind: "compact-failed" });
                options.onEvent?.({ kind: "result", isError: true, source: "message", detail: "Prompt is too long · automatic compaction failed", usage: { inputTokens: 0, outputTokens: 0, contextTokens: 0 } });
                return;
              }
              options.onEvent?.({ kind: "text", text: "ok" });
              // 턴 합계(inputTokens)는 도구 호출마다 다시 더해진 값이고, 대화 크기는 마지막 호출의 입력(contextTokens)이다.
              options.onEvent?.({ kind: "result", isError: false, source: "message", usage: { inputTokens: inputTokens * 2, outputTokens: 10, costUsd: 0.01, contextTokens: inputTokens } });
            },
            steer: () => false, cancel: () => cancelTurn?.(),
            dispose: async () => { entry.disposed = true; },
          };
        },
      };
      const objectives: Objective[] = [];
      const boardListeners: ((event: ObjectiveEvent) => void)[] = [];
      const commanderActivity = new Map<string, "running" | "background">();
      const runs: CommodoreEvent[] = [];
      const restNotices: string[] = [];
      const supervisor = createCommodoreSupervisor({
        store: h.store, agent, experiments: () => h.experiments(), models, theater: () => ({ label: "fleet-harness", root: theaterRoot }),
        objectives: () => objectives, subscribeObjectives: (listener) => { boardListeners.push(listener); return () => undefined; },
        // 사령관의 보드 쓰기 — 개시하면 그 목표가 진행 중이 되고 사건이 난다(실제 도구처럼 쓰는 동안).
        // 지휘관이 일하는 동안의 개시는 실제 도구처럼 objective_busy 로 거절된다.
        boardTools: () => [{ name: "console_objectives_detail", description: "", inputSchema: {}, execute: async (args) => {
          const target = objectives.find((objective) => objective.id === (args as { objectiveId?: string }).objectiveId);
          if (target && commanderActivity.has(target.id)) return { content: [], structuredContent: { error: "objective_busy", retryWhen: "commander_turn_end" }, isError: true };
          if (target) { (target as unknown as { commenced: boolean }).commenced = true; for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: target.id }); }
          return { content: [] };
        } }], observe: restClock((id) => ({ lifecycle: "live", activity: commanderActivity.get(id) ?? "idle", surface: "chat", supportedActions: [], attention: { kind: "none" }, output: { revision: 0, outcome: "none" } } as never)),
        notifyCommanderRest: async (id) => { restNotices.push(id); return true; },
        emit: (event) => { if (event.op === "run") runs.push(event); },
      });
      const tokens = () => h.store.transcriptRead("t1").entries.flatMap((entry) => entry.kind === "wake" ? [entry.reasons] : []);
      const sessionEvents = () => h.store.transcriptRead("t1").entries.flatMap((entry) => entry.kind === "session" ? [entry.event] : []);

      // 등록 복원 — 켜진 Theater 는 「재시작」 턴으로 깨어나고, 사령관이 운영하는 열린 목표가 없는 보드도 이유가 된다.
      supervisor.sync("restart");
      expect(supervisor.status("t1")).toMatchObject({ phase: "idle" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.options).toMatchObject({ model: "claude-sonnet-installed", effort: "medium" });
      expect(sessions[0]!.options.systemPrompt).toContain("The person reads the log in Korean.");
      expect(tokens()).toEqual([["restart", "empty"]]);
      expect(sessionEvents()).toEqual(["restarted"]);
      expect(h.store.transcriptRead("t1").entries.find((entry) => entry.kind === "session")).toMatchObject({ reason: "fallback:model_off:sonnet[1m]" });
      expect(h.store.read("t1")?.model).toBe("codex--gpt-6-luna");
      expect(sessions[0]!.sent[0]).toContain("Console restarted; the board has no open objective you operate");
      const patrolAt = supervisor.status("t1")!.nextWakeAt!;
      expect(supervisor.status("t1")!.phase).toBe("idle");
      expect(patrolAt).toBeGreaterThan(Date.now() + TEST_PATROL_MS - COALESCE_MS - 100);
      expect(patrolAt).toBeLessThanOrEqual(Date.now() + TEST_PATROL_MS);
      // 사람이 순찰 간격을 고치면 잡혀 있던 순찰이 마지막 턴에서 새 간격 뒤로 옮겨지고, 60분으로 되돌리면 원래 시각이다.
      h.store.setPatrol("t1", 15);
      expect(supervisor.status("t1")!.nextWakeAt).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
      h.store.setPatrol("t1", 60);
      expect(supervisor.status("t1")!.nextWakeAt).toBe(patrolAt);
      expect(h.store.read("t1")!.run).toMatchObject({ session: 1, costUsd: 0.01 });

      // 지시·정보·메시지 — 몇 초 안의 이유는 한 턴으로, 정보는 누적 수로, 메시지는 본문째.
      h.store.setDirective("t1", "Ship remote first.");
      const first = h.store.addIntel("t1", { text: "a" }).item; h.store.addIntel("t1", { text: "b" });
      // 수정은 새 정보가 아니라 수정으로 깨운다 — 같은 항목을 거듭 고쳐도 한 항목이다.
      h.store.editIntel("t1", first.id, "a2"); h.store.editIntel("t1", first.id, "a3");
      // 턴 전에 지운 새 정보는 추가·수정 이유 모두에서 빠져 기존 수와 문장을 바꾸지 않는다.
      const cancelled = h.store.addIntel("t1", { text: "cancelled" }).item;
      h.store.editIntel("t1", cancelled.id, "cancelled edit");
      h.store.removeIntel("t1", cancelled.id);
      h.store.transcriptAppend("t1", { kind: "message", text: "Keep objectives small." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["directive", "intel:2", "intel-edited:1", "message"]);
      const note = sessions[0]!.sent.at(-1)!;
      expect(note).toContain(`directive changed: rev 1; 2 new intel items; the person edited 1 intel item: ${first.id}; the person sent you a message`);
      expect(note).toContain("> Keep objectives small.");
      expect(note).not.toContain("Ship remote first.");

      // 남은 이유가 없는 취소는 모델 턴과 빈 깨움 기록을 만들지 않는다.
      const wakesBeforeCancel = tokens().length;
      const turnsBeforeCancel = sessions[0]!.sent.length;
      const transient = h.store.addIntel("t1", { text: "transient" }).item;
      h.store.editIntel("t1", transient.id, "transient edit");
      h.store.removeIntel("t1", transient.id);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens()).toHaveLength(wakesBeforeCancel);
      expect(sessions[0]!.sent).toHaveLength(turnsBeforeCancel);
      // 보드 — 사령관이 운영하는 목표의 상태가 한 단계 옮겨 갈 때마다(새 목표 포함) 깨우고, 대기 상태는 지금 그 상태인 목표 수로 함께 싣는다.
      // 진행 중에 모인 후속 후보는 깨우지 않는다 — 인계 뒤 검토와 함께 한 번에 선다(아래).
      objectives.push({ id: "o1", theaterId: "t1", title: "Remote pairing", createdAt: Date.now(), commodoreOperated: true, done: null, removed: null, commenced: true, planning: false, members: [], awaitingReview: false, awaitingHandoff: false, decisionRequest: { id: "q1" }, decisionRequestRevision: 1, criteriaProposals: [], followups: [{ id: "f1", rev: 1, state: "open", title: "Later" }], followupBatches: [], missions: [{ id: "m1", text: "x", done: false }] } as unknown as Objective);
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o1" });
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o1" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["decision:1", "status:1"]);
      expect(sessions[0]!.sent.at(-1)).toContain('1 objective status change: "Remote pairing" new → in progress');
      expect(sessions[0]!.sent).toHaveLength(3);
      // 구상이 내려앉으면(미션이 생긴 시작 전 목표) planned 로도 깨운다.
      objectives.push({ id: "o2", theaterId: "t1", title: "Lineup", createdAt: Date.now(), commodoreOperated: true, done: null, removed: null, commenced: false, planning: false, members: [], awaitingReview: false, awaitingHandoff: false, decisionRequest: null, decisionRequestRevision: 0, criteriaProposals: [], followups: [], followupBatches: [], missions: [{ id: "m1", text: "x", done: false }] } as unknown as Objective);
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o2" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["planned:1", "status:1"]);
      expect(sessions[0]!.sent.at(-1)).toContain("1 objective has a lineup ready to commence");
      // 그 뒤 지휘관이 일하면(steer 로 연 턴, 턴 뒤 남은 백그라운드 작업) 개시는 objective_busy·retryWhen commander_turn_end 로
      // 거절된다 — 그 일이 끝나 쉬게 될 때 다시 깨운다. 일의 시작과 끝은 보드 사건이 아니고, 턴 끝 신호는 플러그인이 띄우지 않은
      // 지휘관에게는 오지 않으므로 관측으로 본다.
      const turnsBefore = sessions[0]!.sent.length;
      for (const state of ["running", "background"] as const) {
        commanderActivity.set("o2", state);
        await vi.advanceTimersByTimeAsync(PLANNED_CHECK_MS + COALESCE_MS + 10);
        expect(sessions[0]!.sent).toHaveLength(turnsBefore);
      }
      commanderActivity.delete("o2");
      await vi.advanceTimersByTimeAsync(PLANNED_CHECK_MS + COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["planned:1"]);
      // 점검 주기보다 짧은 턴 — 사령관의 개시가 그 턴 중에 거절된 것만으로도 끝난 뒤 다시 깨운다.
      const board = sessions[0]!.options.tools!.custom!.find((group) => group.tools.some((tool) => tool.name === "console_objectives_detail"))!.tools.find((tool) => tool.name === "console_objectives_detail")!;
      commanderActivity.set("o2", "running");
      expect(await board.execute({ action: "commence", objectiveId: "o2" }, { cwd: theaterRoot })).toMatchObject({ isError: true });
      commanderActivity.delete("o2");
      await vi.advanceTimersByTimeAsync(PLANNED_CHECK_MS + COALESCE_MS + 10);
      expect(tokens().slice(-2)).toEqual([["planned:1"], ["planned:1"]]);
      // 임무가 끝나 인계를 기다리는 단계는 지휘관의 몫이다 — 깨우지 않는다.
      (objectives[0] as { awaitingHandoff: boolean }).awaitingHandoff = true;
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o1" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions[0]!.sent).toHaveLength(6);
      // 인계는 지휘관 턴 도중에 기록된다 — 그 턴이 끝난 뒤에 검토 대기로 깨운다(그 전의 완료는 objective_busy 다).
      commanderActivity.set("o1", "running");
      Object.assign(objectives[0]!, { awaitingHandoff: false, awaitingReview: true });
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o1" });
      await vi.advanceTimersByTimeAsync(PLANNED_CHECK_MS + COALESCE_MS + 10);
      expect(sessions[0]!.sent).toHaveLength(6);
      commanderActivity.delete("o1");
      await vi.advanceTimersByTimeAsync(PLANNED_CHECK_MS + COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["review:1", "followup:1", "status:1"]);
      expect(sessions[0]!.sent.at(-1)).toContain('"Remote pairing" missions done, awaiting hand-off → awaiting review');
      expect(sessions[0]!.sent).toHaveLength(7);
      // 사령관 자신의 쓰기(개시)로 바뀐 상태는 깨우지 않는다 — 제가 한 일을 다시 듣는 빈 턴을 만들지 않게.
      await board.execute({ action: "commence", objectiveId: "o2" }, { cwd: theaterRoot });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions[0]!.sent).toHaveLength(7);
      // 사람이 운영하는 목표 — 생기고 옮겨 가도 깨우지 않는다(다음 턴의 범위 줄에만 남는다). 사람이 맡기면 한 번 깨우고,
      // 그 턴의 범위 줄에 목표 id·운영 판정·코드가 남는다. 돌려받은 뒤의 변화는 다시 깨우지 않는다.
      const human = { id: "o3", theaterId: "t1", title: "Person's own", createdAt: Date.now(), done: null, removed: null, commenced: false, planning: false, members: [], awaitingReview: false, awaitingHandoff: false, decisionRequest: null, decisionRequestRevision: 0, criteriaProposals: [], followups: [], followupBatches: [], missions: [] as { id: string; text: string; done: boolean }[] } as unknown as Objective & { commodoreOperated?: boolean; planning: boolean; missions: { id: string; text: string; done: boolean }[] };
      objectives.push(human);
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o3" });
      human.planning = true;
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o3" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions[0]!.sent).toHaveLength(7);
      human.planning = false;
      human.commodoreOperated = true;
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o3" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["pending:1", "status:1"]);
      expect(sessions[0]!.sent.at(-1)).toContain('"Person\'s own" handed to you by the person (not started)');
      const entries = h.store.transcriptRead("t1").entries;
      expect(entries.at(-1)).toMatchObject({ kind: "result" });
      expect(entries.slice(-4, -2)).toMatchObject([{ kind: "wake", reasons: ["pending:1", "status:1"] }, { kind: "wake-scope", woke: [{ id: "o3", operator: "commodore", codes: ["pending", "status"] }], held: [{ id: "o3", operator: "human", codes: ["pending", "status"] }] }]);
      human.commodoreOperated = false;
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o3" });
      human.missions.push({ id: "m1", text: "x", done: false });
      for (const listener of boardListeners) listener({ op: "upsert", commodoreId: "t1", objectiveId: "o3" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions[0]!.sent).toHaveLength(8);
      (objectives[0] as { awaitingReview: boolean }).awaitingReview = false;
      (objectives[1] as unknown as { missions: { done: boolean }[] }).missions[0]!.done = true;

      // 정체 — 구성원이 일하는 동안 지휘관이 15분 쉬면 한 번 깨우고 지휘관에게 사실을 보낸다. 15분 안에 움직인 지휘관은 정체가 아니다.
      (objectives[0] as { decisionRequest: unknown }).decisionRequest = null;
      (objectives[0] as unknown as { members: unknown[] }).members.push({ id: "w1", role: "implementer", sessionName: "objective-o1-member-1" });
      commanderActivity.set("w1", "running");
      commanderActivity.set("o1", "running");
      await vi.advanceTimersByTimeAsync(STALL_CHECK_MS);
      commanderActivity.delete("o1");
      await vi.advanceTimersByTimeAsync(STALL_CHECK_MS);
      const beforeRest = sessions[0]!.sent.length;
      await vi.advanceTimersByTimeAsync(COMMANDER_REST_MS - STALL_CHECK_MS);
      expect(sessions[0]!.sent).toHaveLength(beforeRest);
      expect(restNotices).toEqual([]);
      await vi.advanceTimersByTimeAsync(STALL_CHECK_MS + COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["stalled:1"]);
      expect(sessions[0]!.sent.at(-1)).toContain("1 stalled objective: Remote pairing");
      expect(supervisor.status("t1")).toMatchObject({ stalled: ["o1"] });
      expect(restNotices).toEqual(["o1"]);
      // 통지 때문에 생긴 지휘관 턴은 같은 에피소드다 — 15분을 다시 쉬어도 깨우지 않고 통지도 없다.
      const sentAfterFirstStall = sessions[0]!.sent.length;
      const tokensAfterFirstStall = tokens().length;
      commanderActivity.set("o1", "running");
      await vi.advanceTimersByTimeAsync(STALL_CHECK_MS);
      commanderActivity.delete("o1");
      await vi.advanceTimersByTimeAsync(COMMANDER_REST_MS + STALL_CHECK_MS + COALESCE_MS + 10);
      expect(sessions[0]!.sent).toHaveLength(sentAfterFirstStall);
      expect(tokens()).toHaveLength(tokensAfterFirstStall);
      expect(restNotices).toEqual(["o1"]);
      expect(supervisor.status("t1")).toMatchObject({ stalled: ["o1"] });

      // 순찰 — 사령관의 next_wake 가 없으면 60분 상한에서 깨운다.
      await vi.advanceTimersByTimeAsync(TEST_PATROL_MS + COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["patrol"]);

      // 이미 전달한 항목의 삭제는 수정 이유를 걷고 별도 이유와 본문 발췌로 한 턴 깨운다.
      h.store.editIntel("t1", first.id, "x".repeat(70));
      h.store.removeIntel("t1", first.id);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["intel-removed:1"]);
      expect(sessions[0]!.sent.at(-1)).toContain(`the person removed 1 intel item: ${first.id} "${"x".repeat(59)}…"`);
      expect(h.store.read("t1")!.intel.some((item) => item.id === first.id)).toBe(false);

      // 오류 — 1·5·15분 뒤 재시도, 자율 운영은 그대로. 사람의 「지금 다시 시도」는 곧바로 한 턴.
      fail = "rate limit exceeded";
      h.store.addIntel("t1", { text: "c" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      const near = (at: number | undefined, expected: number) => { expect(at).toBeGreaterThan(expected - 100); expect(at).toBeLessThanOrEqual(expected); };
      expect(supervisor.status("t1")).toMatchObject({ phase: "retrying", reason: "rate_limited" });
      near(supervisor.status("t1")!.nextWakeAt, Date.now() + RETRY_DELAYS_MS[0]!);
      expect(h.store.transcriptRead("t1").entries.at(-1)).toMatchObject({ kind: "error", code: "rate_limited" });
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]! + 10);
      expect(supervisor.status("t1")!.phase).toBe("retrying");
      near(supervisor.status("t1")!.nextWakeAt, Date.now() + RETRY_DELAYS_MS[1]!);
      fail = null;
      await supervisor.retry("t1");
      expect(supervisor.status("t1")).toMatchObject({ phase: "idle" });
      expect(tokens().at(-1)).toEqual(["intel:1", "retry"]);
      await expect(supervisor.retry("t1")).rejects.toThrow("commodore_not_retrying");

      // 압축 — 문맥이 길어져도 세션을 바꾸지 않는다. 세션은 창(폴백 Sonnet 1M)의 75%를 압축 지점으로 받아 같은 세션에서
      // 대화를 요약해 이어 가고, 그 사실이 기록에 남는다. 미터는 턴 합계가 아니라 마지막 호출의 대화 크기와 그 지점을 읽는다.
      expect(sessions[0]!.options.compactAt).toBe(750_000);
      inputTokens = 760_000;
      h.store.addIntel("t1", { text: "d" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(supervisor.status("t1")).toMatchObject({ context: { window: 1_000_000, inputTokens: 760_000, compactAt: 750_000 } });
      compaction = { preTokens: 760_000, postTokens: 12_000 };
      inputTokens = 14_000;
      h.store.addIntel("t1", { text: "e" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.disposed).toBe(false);
      expect(h.store.transcriptRead("t1").entries.find((entry) => entry.kind === "compacted")).toMatchObject({ trigger: "auto", preTokens: 760_000, postTokens: 12_000 });
      expect(supervisor.status("t1")).toMatchObject({ context: { inputTokens: 14_000 } });

      // 교대 — 요약이 실패해 넘친 세션은 같은 세션으로 다시 시도하지 않는다. 다음 시도가 새 세션 + 최근 행위 요약으로 연다.
      compactionFails = true;
      h.store.addIntel("t1", { text: "f" });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(supervisor.status("t1")).toMatchObject({ phase: "retrying" });
      expect(sessions).toHaveLength(1);
      compactionFails = false;
      inputTokens = 1_000;
      await supervisor.retry("t1");
      expect(sessions).toHaveLength(2);
      expect(sessions[0]!.disposed).toBe(true);
      expect(sessionEvents()).toEqual(["restarted", "replaced"]);
      expect(tokens().at(-1)).toEqual(["intel:1", "retry", "rotated"]);
      expect(sessions[1]!.sent[0]).toContain("This is a replacement session. Summary of your recent actions");
      expect(h.store.read("t1")!.run!.session).toBe(2);

      // 사람에게 묻기 — 사령관의 질문은 기록에 구조화된 줄로 남고, 사람의 답이 사령관을 「사람이 답함」으로 깨우며 답은 asks 도구로 읽힌다.
      // 끝난 질문은 다른 답으로 덮이지 않고 거둘 수도 없다.
      const commodoreTool = (name: string) => sessions[1]!.options.tools!.custom!.find((group) => group.name === "commodore")!.tools.find((tool) => tool.name === name)!;
      const useTool = async (name: string, args: Record<string, unknown>) => ((await commodoreTool(name).execute(args, { cwd: theaterRoot })) as { structuredContent: Record<string, unknown> }).structuredContent;
      const asked = await useTool("ask_person", { questions: [{ header: "Candidates", text: "Open these candidates as objectives?", options: [{ label: "Open both" }, { label: "Only the first" }] }], reason: "Product direction is the person's call" });
      expect(h.store.transcriptRead("t1").entries.at(-1)).toMatchObject({ kind: "ask", askId: asked.askId, questions: [{ options: ["Open both", "Only the first"] }] });
      const ask = h.store.read("t1")!.asks!.find((entry) => entry.id === asked.askId)!;
      const answer = (optionIndex: number) => h.route("commodore/ask/answer", { commodoreId: "t1", askId: ask.id, answers: [{ questionId: ask.questions[0]!.id, selectedOptionIds: [ask.questions[0]!.options[optionIndex]!.id], text: "" }] });
      expect((await answer(1)).status).toBe(200);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(tokens().at(-1)).toEqual(["answered:1"]);
      expect(sessions[1]!.sent.at(-1)).toContain('the person answered 1 item you handed or asked them: your question "Open these candidates as objectives?"');
      expect(await useTool("asks", {})).toMatchObject({ open: 0, asks: [{ askId: ask.id, state: "answered", answers: [{ question: "Open these candidates as objectives?", selected: ["Only the first"] }] }] });
      expect((await answer(0)).value).toMatchObject({ error: "ask_already_answered" });
      expect((await answer(1)).value).toMatchObject({ repeated: true });
      expect(await useTool("withdraw_ask", { askId: ask.id })).toMatchObject({ error: "ask_already_answered" });
      expect(h.store.read("t1")!.asks!.find((entry) => entry.id === ask.id)!.settled).toMatchObject({ outcome: "answered", answers: [{ selectedOptionIds: [ask.questions[0]!.options[1]!.id] }] });

      // 안 함 — 진행 턴은 스스로 마치고, 아직 읽지 않은 다음 턴 메시지만 미전달로 남긴다.
      holdTurn = true;
      h.store.transcriptAppend("t1", { kind: "message", text: "Cancel this instruction." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(supervisor.status("t1")).toMatchObject({ phase: "turn" });
      expect(sessions[1]!.sent.at(-1)).toContain("Cancel this instruction.");
      const sentCount = sessions[1]!.sent.length;
      const pendingMessage = h.store.transcriptAppend("t1", { kind: "message", text: "Hold the release." });
      await vi.advanceTimersByTimeAsync(COALESCE_MS - 500);
      h.store.setPatrol("t1", "off");
      await vi.advanceTimersByTimeAsync(10);
      expect(sessions[1]!.disposed).toBe(false); // 진행 턴은 취소되지 않고 스스로 끝나야 한다.
      completeOnCancel = true;
      cancelTurn?.();
      await vi.advanceTimersByTimeAsync(10);
      expect(sessions[1]!.sent).toHaveLength(sentCount);
      expect(h.store.transcriptRead("t1").entries.slice(-3)).toMatchObject([{ kind: "result", outcome: "ok" }, { kind: "undelivered", seqs: [pendingMessage.seq] }, { kind: "session", event: "stopped" }]);
      expect(sessions[1]!.disposed).toBe(true);
      expect(supervisor.status("t1")).toBeNull();
      expect(sessionEvents().at(-1)).toBe("stopped");
      expect(runs.at(-1)).toMatchObject({ op: "run", run: { phase: "off", reason: "patrol off" } });
      h.store.addIntel("t1", { text: "f" });
      await vi.advanceTimersByTimeAsync(TEST_PATROL_MS);
      expect(sessions).toHaveLength(2);
      // 순찰을 재개하면 미전달 메시지만 다시 싣는다 — 이미 성공한 턴의 말은 중복 전달하지 않는다.
      // stop과 겹쳐도 성공 결말이면 전달 실패로 바꾸지 않는다.
      completeOnCancel = true;
      h.store.setPatrol("t1", 60);
      expect(h.store.transcriptRead("t1").entries.at(-1)).toMatchObject({ kind: "requeued", seqs: [pendingMessage.seq] });
      const delivered = await h.route("commodore/message", { commodoreId: "t1", text: "Already received." }, { run: (id) => supervisor.status(id) });
      expect(delivered.status).toBe(200);
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 10);
      expect(sessions).toHaveLength(3);
      expect(sessions[2]!.sent[0]).toContain("Already received.");
      expect(sessions[2]!.sent[0]).toContain("Hold the release.");
      expect(sessions[2]!.sent[0]).not.toContain("Cancel this instruction.");
      h.store.setPatrol("t1", "off");
      cancelTurn?.();
      await vi.advanceTimersByTimeAsync(10);
      expect(h.store.transcriptRead("t1").entries.slice(-2)).toMatchObject([{ kind: "result", outcome: "ok" }, { kind: "session", event: "stopped" }]);
      expect(h.store.transcriptRead("t1").entries.filter((entry) => entry.kind === "undelivered")).toHaveLength(1);
      await supervisor.dispose();
    } finally { vi.useRealTimers(); }
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OperationGroupedEvent, OperationNode } from "@fleet-console/sdk/operations";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { afterEach, describe, expect, it } from "vitest";

import { imageInfo } from "../server/attachments.js";
import { createLaunchService } from "../server/launch.js";
import { createObjectiveMcpTools } from "../server/objective-tools.js";
import { createObjectiveStore, ObjectiveStoreError } from "../server/store.js";
import type { ObjectiveItemEvent } from "../server/types.js";

/**
 * 목표의 필수 계약 — 목표는 곧 에이전트 Operation 이다: 목표를 만들면 지휘관 Operation 이 dormant 로 함께 태어나고,
 * 따로 만든 Operation 도 목표로 보인다(담당·플러그인 Operation 은 아니다). 저장 무결성(state.json 은 워크스페이스
 * 디렉터리에 목표 고유값만, 순환 거절, 계획이 잠긴 단계 보존, 기록 누적, 첨부는 Operation 이 사라질 때 함께), 권한 경계
 * (지휘관 = 목표 자신의 Operation 만 쓰기, 옛 보드로 쓴 계획 거절), 그룹 = 지휘관 Operation 의 그룹, 검토 대기는 모든 임무와
 * 근거 있는 기준 충족에서 저절로.
 */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

type Node = { -readonly [K in keyof OperationNode]: OperationNode[K] };

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-objectives-"));
  dirs.push(dir);
  const theaterPath = path.join(dir, "project");
  const workspace = path.join(dir, "data", "workspaces", "project");
  const events: ObjectiveItemEvent[] = [];
  const operations = new Map<string, Node>();
  let clock = 1_000;
  const add = (id: string, init: Partial<Node> = {}) => {
    const node: Node = { id, theaterId: "t1", type: "agent", pluginId: null, title: id, groupId: null, payload: {}, geometry: null, ts: { createdAt: clock++, updatedAt: clock }, ...init };
    operations.set(id, node);
    return node;
  };
  const grouped: ((event: OperationGroupedEvent) => void)[] = [];
  const deleted: string[] = [];
  const sent: { operationId: string; text: string }[] = [];
  const activity = new Map<string, "idle" | "running" | "awaiting" | "background" | "dormant">();
  const slept: string[] = [];
  const interrupted: string[] = [];
  const launches: { title?: string; sessionName?: string; viewMode?: string; text?: string; dormant?: boolean; disableSubagents?: boolean; groupId?: string }[] = [];
  const operationsHost = {
    get: (id: string) => operations.get(id) ?? null,
    list: () => [...operations.values()],
    patch: (id: string, input: { title?: string; payload?: Record<string, unknown>; groupId?: string | null }) => {
      const node = operations.get(id); if (!node) return null;
      if (input.payload) node.payload = input.payload;
      if (input.title) node.title = input.title;
      // 호스트처럼 그룹이 실제로 바뀌면 operation:grouped 를 낸다.
      if (input.groupId !== undefined && (node.groupId ?? null) !== input.groupId) { const previousGroupId = node.groupId ?? null; node.groupId = input.groupId; for (const listener of grouped) listener({ operationId: id, theaterId: node.theaterId, groupId: input.groupId, previousGroupId }); }
      return node;
    },
    delete: (id: string) => { deleted.push(id); return operations.delete(id); },
    groups: { list: () => [], get: (id: string) => (id.startsWith("g-") ? { id, theaterId: "t1" } : null), create: () => { throw new Error("unused"); }, patch: () => null, delete: () => false },
  };
  const store = createObjectiveStore({ dirOf: (theaterId) => (theaterId === "t1" ? path.join(workspace, "objectives") : null), operations: operationsHost, emit: (event) => events.push(event), now: () => clock++ });
  const ctx = {
    pluginId: "objectives",
    host: {
      operations: operationsHost,
      consoleControl: {
        request: async (input: { kind: string; operationId?: string; text?: string; title?: string; sessionName?: string; viewMode?: string; dormant?: boolean; disableSubagents?: boolean; model?: string; effort?: string; groupId?: string }) => {
          const receipt = { id: "r", requestId: "r", caller: { kind: "plugin", pluginId: "objectives" }, input, status: "running", createdAt: "", updatedAt: "", expiresAt: "" };
          if (input.kind === "send") { sent.push({ operationId: input.operationId!, text: input.text! }); return { ...receipt, operationId: input.operationId }; }
          // 호스트처럼 터미널은 실행 중일 때만 interrupt 를 받는다.
          if (input.kind === "interrupt") { if (activity.get(input.operationId!) !== "running") throw new Error("capability_unavailable"); interrupted.push(input.operationId!); activity.set(input.operationId!, "idle"); return { ...receipt, operationId: input.operationId }; }
          await new Promise((resolve) => setTimeout(resolve, 5));
          const id = `launched-${launches.length + 1}`;
          launches.push({ title: input.title, sessionName: input.sessionName, viewMode: input.viewMode, text: input.text, dormant: input.dormant, disableSubagents: input.disableSubagents, groupId: input.groupId });
          add(id, { title: input.title ?? id, groupId: input.groupId ?? null, payload: { session: { harness: "claude-code", ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}), ...(input.sessionName ? { sessionName: input.sessionName } : {}) } } });
          return { ...receipt, operationId: id };
        },
        observe: (id: string) => {
          const state = activity.get(id);
          return state ? { lifecycle: state === "dormant" ? "dormant" : "live", activity: state === "dormant" ? "idle" : state, surface: "terminal", supportedActions: ["send", ...(state === "running" ? ["interrupt"] : [])] } : null;
        },
        sleep: async (id: string, options?: { dropPendingInput?: boolean }) => {
          const state = activity.get(id);
          if (state !== "idle" && !(options?.dropPendingInput && state === "awaiting")) return { ok: false, error: "not_idle" };
          slept.push(id); activity.set(id, "dormant"); return { ok: true, lifecycle: "dormant" };
        },
      },
      paths: { resolveTheaterPath: () => theaterPath },
    },
  } as unknown as FleetPluginServerContext;
  const launch = createLaunchService(ctx, store);
  grouped.push((event) => launch.operationGrouped(event));
  const tools = createObjectiveMcpTools(ctx, store, launch);
  const call = async (name: string, args: Record<string, unknown>, operationId?: string) => await tools.find((tool) => tool.name === name)!.execute(args, { cwd: dir, ...(operationId ? { caller: { kind: "operation" as const, operationId } } : {}) }) as { isError: boolean; structuredContent: Record<string, unknown> };
  const stateFile = path.join(workspace, "objectives", "state.json");
  return { store, events, launch, call, operations, add, sent, launches, deleted, stateFile, workspace, activity, slept, interrupted };
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000030806000000", "hex");

describe("Objectives contract", () => {
  it("creates an objective as a dormant Commander Operation and keeps only objective-owned values in the workspace state.json", async () => {
    const { store, events, launch, operations, sent, launches, stateFile, workspace, activity, slept, interrupted } = harness();
    const item = await launch.create({ theaterId: "t1", title: "Release", groupId: "g-ship", note: "brief", steps: [{ text: "a" }, { text: "b", after: [0] }, { text: "c", after: [1] }] });
    // 목표 = 지휘관 Operation — 첫 프롬프트 없이 dormant 로, 이름 붙은 CLI 세션 사양과 그룹을 들고 태어난다.
    expect(launches).toEqual([expect.objectContaining({ dormant: true, viewMode: "terminal", title: "Release", groupId: "g-ship", text: undefined })]);
    const head = launches[0]!.sessionName!.replace(/-cmdr$/, "");
    expect(item).toMatchObject({ id: "launched-1", title: "Release", groupId: "g-ship", commander: { sessionName: `${head}-cmdr`, started: false }, note: "brief" });
    // 목표가 띄우는 세션은 콘솔 사용을 켜지 않는다 — 일은 fleet-objectives 로 한다.
    expect(operations.get(item.id)!.payload.consoleUse).toBeUndefined();
    const [a, b, c] = item.steps;
    // 순환은 저장 전에 거절된다.
    expect(() => store.stepPatch(item.id, a!.id, { after: [c!.id] })).toThrow(ObjectiveStoreError);
    // 시작은 새 Operation 을 띄우지 않고 그 지휘관에게 한 줄을 보내 깨운다.
    await launch.startCoordinator(item.id);
    expect(sent).toEqual([{ operationId: item.id, text: expect.stringContaining(item.id) }]);
    expect(launches).toHaveLength(1);
    // 위임 — 담당은 프롬프트 없이, 지휘관 세션 이름을 이어 받고 서브에이전트 없이 뜬다. 같은 단계를 두 번 위임할 수 없다.
    const delegated = await launch.delegateStep(item.id, a!.id);
    expect(delegated.session).toBe(`${head}-mission-1`);
    expect(launches.at(-1)).toMatchObject({ sessionName: `${head}-mission-1`, dormant: undefined, disableSubagents: true, text: undefined });
    await expect(launch.delegateStep(item.id, a!.id)).rejects.toMatchObject({ code: "slot_taken" });
    // 다시 작업해 다시 완료하면 기록이 쌓인다(종류는 위치로).
    store.stepDone(item.id, a!.id, ["a done"]);
    store.stepDone(item.id, a!.id, ["a redone", "fixed the gap"]);
    await expect(launch.delegateStep(item.id, a!.id)).rejects.toMatchObject({ code: "step_done" });
    await launch.delegateStep(item.id, b!.id);
    // 완료는 지휘관과 담당을 휴면시키되 연결을 풀지 않는다. 답을 기다리는 터미널 지휘관은 그 대기를 버리고, 실행 중인 담당은 중단한 뒤 재운다.
    activity.set(item.id, "awaiting");
    activity.set("launched-2", "running");
    activity.set("launched-3", "idle");
    expect(launch.complete(item.id).done).toBeTruthy();
    await expect.poll(() => slept.length).toBe(3);
    expect(interrupted).toEqual(["launched-2"]);
    expect(slept.sort()).toEqual([item.id, "launched-2", "launched-3"].sort());
    expect(store.reopen(item.id).steps.map((step) => step.operationId)).toEqual(["launched-2", "launched-3", null]);
    // 계획은 완료·위임된 단계를 보존하고 나머지를 바꾼다; 새 단계는 편성 순으로 선다.
    const planned = store.plan(item.id, { steps: [{ text: "x", after: [{ index: 1, why: "shares files" }] }, { text: "y", after: [{ stepId: a!.id, why: "builds on a" }] }] });
    expect(planned.steps.map((step) => step.text)).toEqual(["a", "b", "y", "x"]);
    expect(planned.steps[3]!.why[planned.steps[2]!.id]).toBe("shares files");
    // 저장 — 프로젝트 워크스페이스 디렉터리의 state.json 하나, Operation 이 가진 값은 싣지 않는다.
    expect(fs.existsSync(stateFile)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { version: number; objectives: Record<string, unknown>[] };
    expect(saved.version).toBe(2);
    expect(Object.keys(saved.objectives[0]!).sort()).toEqual(["note", "operationId", "steps"]);
    for (const key of ["by", "title", "theaterId", "groupId", "slot", "launch", "createdAt", "updatedAt", "history", "author", "review"]) expect(JSON.stringify(saved)).not.toContain(`"${key}"`);
    // 재시작 뒤에도 파일에서 같은 상태를 읽는다 — 제목·그룹은 Operation 에서 온다.
    const reloaded = createObjectiveStore({ dirOf: () => path.join(workspace, "objectives"), operations: { get: (id) => operations.get(id) ?? null, list: () => [...operations.values()] }, emit: () => undefined });
    expect(reloaded.find(item.id)).toMatchObject({ title: "Release", groupId: "g-ship" });
    expect(reloaded.find(item.id)!.steps[0]!.records.map((record) => [record.kind, record.lines])).toEqual([["done", ["a done"]], ["redone", ["a redone", "fixed the gap"]]]);
    // 모든 쓰기가 사건으로 나갔다 — 화면은 이 프레임으로 갱신된다.
    expect(events.filter((event) => event.op === "upsert" && event.itemId === item.id).length).toBeGreaterThanOrEqual(8);
    // 메모 첨부 — 머리 바이트가 이미지가 아니면 받지 않는다; 목표를 지우면 지휘관 Operation 이 닫히고 담당도 따라 닫히며,
    // 복원 불가로 확정될 때(purged) 레코드와 첨부가 사라진다.
    expect(imageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'))).toBeNull();
    const attached = store.attachmentAdd(item.id, { name: "shot.png", type: "image/png", data: PNG });
    const file = store.attachmentPath(attached.item, attached.attachment);
    expect(file.startsWith(path.join(workspace, "objectives"))).toBe(true);
    launch.remove(item.id);
    launch.operationDeleted(item.id);
    expect(operations.has("launched-2") || operations.has("launched-3")).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    launch.operationPurged(item.id);
    expect(fs.existsSync(file)).toBe(false);
    expect((JSON.parse(fs.readFileSync(stateFile, "utf8")) as { objectives: unknown[] }).objectives).toEqual([]);
  });

  it("shows every agent Operation created elsewhere as an objective, but not assignee or plugin Operations", async () => {
    const { store, launch, add, stateFile } = harness();
    add("sidebar", { title: "Made in the sidebar", groupId: "g-a" });
    add("wiki", { pluginId: "codex", type: "codex-wiki" });
    const made = await launch.create({ theaterId: "t1", title: "Made in Objectives", groupId: null, steps: [{ text: "one" }] });
    await launch.delegateStep(made.id, made.steps[0]!.id);
    // 레코드 없는 Operation 은 빈 목표로 선다 — 담당(launched-2)과 플러그인 Operation 은 목표가 아니다.
    expect(store.list("t1").map((item) => item.id).sort()).toEqual(["launched-1", "sidebar"]);
    expect(store.find("sidebar")).toMatchObject({ title: "Made in the sidebar", groupId: "g-a", note: "", steps: [], awaitingReview: false });
    expect(store.find("launched-2")).toBeNull();
    // 첫 편집이 레코드를 만든다.
    expect(JSON.stringify(JSON.parse(fs.readFileSync(stateFile, "utf8")))).not.toContain("sidebar");
    store.patch("sidebar", { note: "now it has a brief" });
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).objectives.map((entry: { operationId: string }) => entry.operationId)).toContain("sidebar");
  });

  it("keeps an objective in its Commander Operation's group and moves the assignees with it", async () => {
    const { store, launch, operations } = harness();
    const item = await launch.create({ theaterId: "t1", title: "Ship", groupId: "g-review", steps: [{ text: "a" }] });
    const worker = (await launch.delegateStep(item.id, item.steps[0]!.id)).operationId;
    expect(operations.get(worker)!.groupId).toBe("g-review");
    // 목표에서 옮기면 지휘관 Operation 이 옮겨지고, 담당이 따라간다 — 목표의 그룹은 저장하지 않는다.
    launch.regroup(item.id, "g-done");
    expect([operations.get(item.id)!.groupId, operations.get(worker)!.groupId, store.find(item.id)!.groupId]).toEqual(["g-done", "g-done", "g-done"]);
    // 사이드바에서 담당만 옮긴 것은 목표를 움직이지 않는다; 없는 그룹으로는 옮기지 않는다.
    operations.get(worker)!.groupId = "g-other";
    expect(store.find(item.id)!.groupId).toBe("g-done");
    expect(() => launch.regroup(item.id, "nope")).toThrow(ObjectiveStoreError);
  });

  it("lets only the objective's own Commander write, gives assignees read-only access and outsiders none, and keeps planning and the person's missions intact", async () => {
    const { store, call, launch } = harness();
    const item = await launch.create({ theaterId: "t1", title: "Guarded", groupId: null, steps: [{ text: "one" }, { text: "two", after: [0] }] });
    const commander = item.id;
    const other = (await launch.create({ theaterId: "t1", title: "Other", groupId: null })).id;
    // 다른 목표의 지휘관은 이 목표를 쓰지도 읽지도 못한다.
    expect((await call("plan", { itemId: item.id, steps: [{ text: "p" }] }, other)).structuredContent.error).toBe("not_participant");
    expect((await call("read", { itemId: item.id }, other)).structuredContent.error).toBe("not_participant");
    // 구상 중에는 편성만 — 계획·배치는 되고 임무 수행 쓰기는 거절된다.
    store.setCooking(item.id, true);
    expect((await call("plan", { itemId: item.id, steps: [{ text: "p1", assign: "route" }, { text: "p2", after: [{ index: 0 }] }] }, commander)).isError).toBe(false);
    expect((await call("complete_mission", { itemId: item.id, index: 0, summary: ["early"] }, commander)).structuredContent.error).toBe("planning_only");
    expect((await call("delegate_mission", { itemId: item.id, index: 0 }, commander)).structuredContent.error).toBe("planning_only");
    store.setCooking(item.id, false);
    // 위임 응답이 지휘관에게 담당은 읽기만 한다고 알린다.
    const delegated = await call("delegate_mission", { itemId: item.id, index: 0 }, commander);
    expect(delegated.structuredContent.assignee).toMatchObject({ access: "read-only" });
    const assignee = (delegated.structuredContent.assignee as { operationId: string }).operationId;
    // 담당은 제 목표를 읽지만 쓰지 못한다.
    expect((await call("mine", {}, assignee)).structuredContent).toMatchObject({ role: "assignee", access: "read-only", itemId: item.id });
    expect((await call("read", { itemId: item.id }, assignee)).isError).toBe(false);
    expect((await call("mine", {}, commander)).structuredContent).toMatchObject({ role: "commander", itemId: item.id });
    // 사람이 선행 없이 더한 단계는 미분류 — 지휘관이 자리를 정하기 전까지 준비되지 않는다.
    launch.stepAdded(item.id, { text: "missed" }, { by: "human" });
    const board = async () => ((await call("read", { itemId: item.id }, commander)).structuredContent.item as { graph: { steps: { unplaced?: boolean; ready: boolean; after: number[]; assign: string }[] } }).graph.steps;
    // 지휘관이 읽기 전에 사람이 바꾼 보드로는 계획을 쓸 수 없다.
    store.setEdited(item.id, ["steps"]);
    expect((await call("plan", { itemId: item.id, steps: [{ text: "stale" }] }, commander)).structuredContent.error).toBe("board_changed");
    const missed = (await board()).findIndex((step) => step.unplaced);
    expect((await board())[missed]).toMatchObject({ unplaced: true, ready: false });
    // 계획이 남기는 임무를 같은 문구로 다시 만들어 두 벌을 세우지 못한다.
    expect((await call("plan", { itemId: item.id, steps: [{ text: " Missed " }] }, commander)).structuredContent).toMatchObject({ error: "mission_kept", kept: [{ text: "missed", unplaced: true }] });
    // 배치는 지휘관만 — 위임 의도(route)도 함께 남는다.
    expect((await call("place_mission", { itemId: item.id, index: missed, after: [0] }, assignee)).structuredContent.error).toBe("not_commander");
    expect((await call("place_mission", { itemId: item.id, index: missed, after: [0], assign: "route" }, commander)).isError).toBe(false);
    expect((await board()).find((step) => step.after.includes(0) && step.unplaced === undefined && step.assign === "route")).toBeTruthy();
    // 완료는 결론 먼저 1–3줄의 기록과 함께이고, 산문 문단은 거절된다. 담당은 완료하지 못한다.
    expect((await call("complete_mission", { itemId: item.id, index: 0, summary: ["r"] }, assignee)).structuredContent.error).toBe("not_commander");
    expect((await call("complete_mission", { itemId: item.id, index: 0, summary: ["x".repeat(400)] }, commander)).structuredContent.error).toBe("summary_format");
    expect((await call("complete_mission", { itemId: item.id, index: 0, summary: ["shipped p1", "tests pass"] }, commander)).isError).toBe(false);
    // 같은 목표에 시작이 겹치면 하나만 간다.
    const results = await Promise.allSettled([launch.startCoordinator(other), launch.startCoordinator(other)]);
    expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
  });

  it("puts the objective up for review by itself once every mission is done and every criterion is met with evidence", async () => {
    const { store, call, launch } = harness();
    const item = await launch.create({ theaterId: "t1", title: "Criteria", groupId: null, steps: [{ text: "fix" }] });
    const as = item.id;
    store.criterionAdd(item.id, "tests pass", "human");
    store.criterionAdd(item.id, "copy unchanged", "human");
    // 사람이 쓴 기준이 있으면 지휘관은 기준을 덧붙이지 못한다.
    expect((await call("plan", { itemId: item.id, steps: [{ text: "patch" }], criteria: ["mine"] }, as)).structuredContent.error).toBe("criteria_exist");
    // 마지막 임무를 마치면 도구가 달성 점검을 되묻는다 — 아직 검토 대기가 아니다.
    const done = await call("complete_mission", { itemId: item.id, index: 0, summary: ["fixed"] }, as);
    expect(String(done.structuredContent.next)).toContain("copy unchanged");
    expect(store.find(item.id)!.awaitingReview).toBe(false);
    // 지휘관은 검토 대기를 쓰지 않는다 — 근거 없는 충족은 받지 않고, 기준마다 근거가 서면 저절로 검토 대기다.
    expect((await call("mark_criterion", { itemId: item.id, n: 1, met: true }, as)).structuredContent.error).toBe("evidence_required");
    expect((await call("mark_criterion", { itemId: item.id, n: 1, met: true, evidence: "12/12" }, as)).isError).toBe(false);
    expect(store.find(item.id)!.awaitingReview).toBe(false);
    const met = await call("mark_criterion", { itemId: item.id, n: 2, met: true, evidence: "diff shows no copy change" }, as);
    expect(met.structuredContent.next).toBeTruthy();
    expect(store.find(item.id)).toMatchObject({ awaitingReview: true, criteria: [{ met: "12/12" }, { met: "diff shows no copy change" }] });
    // 기준 문구가 바뀌면 그 기준만, 새 임무가 생기면 모든 충족 판단이 거둬진다 — 검토 대기도 함께 풀린다.
    store.criterionPatch(item.id, store.find(item.id)!.criteria[1]!.id, "copy unchanged in both languages");
    expect(store.find(item.id)!.criteria.map((criterion) => criterion.met ?? null)).toEqual(["12/12", null]);
    expect(store.find(item.id)!.awaitingReview).toBe(false);
    launch.stepAdded(item.id, { text: "one more" }, { by: "human" });
    expect(store.find(item.id)!.criteria.every((criterion) => !criterion.met)).toBe(true);
  });
});

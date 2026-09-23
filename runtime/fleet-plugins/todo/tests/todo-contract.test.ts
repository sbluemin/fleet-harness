import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OperationGroupedEvent } from "@fleet-console/sdk/operations";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { afterEach, describe, expect, it } from "vitest";

import { imageInfo } from "../server/attachments.js";
import { createTodoConsoleTools } from "../server/console-tools.js";
import { createGroupSync } from "../server/group-sync.js";
import { createLaunchService } from "../server/launch.js";
import { createTodoStore, TodoStoreError } from "../server/store.js";
import type { TodoItemEvent } from "../server/types.js";

/**
 * 할 일의 필수 계약 — 실행(시작 한 번이 조율자와 담당 세션을 이름 붙여 한꺼번에 띄우고 이름을 조율자에게 알린다),
 * 저장 무결성(완료가 슬롯을 놓고 되돌리기가 복원, 순환 거절, 계획이 잠긴 단계를 보존), 권한 경계(조율자만 완료·계획,
 * 계보 밖 연결 거절, 같은 슬롯의 겹친 시작 거절), 사건 방송(쓰기 한 번에 todo:item 한 프레임), 사람이 더한 단계는 셰프가 자리를
 * 정하기 전까지 준비되지 않음, 메모 첨부는 이미지 머리 바이트로만 받고 항목과 함께 지워짐, 단계 기록은 다시 완료해도 쌓이고
 * 옛 결과는 첫 기록으로 옮겨지며 셰프의 산문 요약은 거절됨.
 */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-todo-"));
  dirs.push(dir);
  const events: TodoItemEvent[] = [];
  const store = createTodoStore({ dir, emit: (event) => events.push(event) });
  const operations = new Map<string, { id: string; theaterId: string; title: string; payload: Record<string, unknown>; groupId?: string | null }>();
  operations.set("coord", { id: "coord", theaterId: "t1", title: "Coordinator", payload: { consoleUse: { enabled: true, language: "en" } } });
  operations.set("stranger", { id: "stranger", theaterId: "t1", title: "Stranger", payload: {} });
  const grouped: ((event: OperationGroupedEvent) => void)[] = [];
  const sent: { operationId: string; text: string }[] = [];
  const launches: { title?: string; sessionName?: string; viewMode?: string; text?: string; disableSubagents?: boolean }[] = [];
  const ctx = {
    pluginId: "todo",
    host: {
      operations: {
        get: (id: string) => operations.get(id) ?? null,
        list: () => [...operations.values()],
        patch: (id: string, input: { payload?: Record<string, unknown>; groupId?: string | null }) => {
          const node = operations.get(id); if (!node) return null; if (input.payload) node.payload = input.payload;
          // 호스트처럼 그룹이 실제로 바뀌면 operation:grouped 를 낸다.
          if (input.groupId !== undefined && (node.groupId ?? null) !== input.groupId) { const previousGroupId = node.groupId ?? null; node.groupId = input.groupId; for (const listener of grouped) listener({ operationId: id, theaterId: node.theaterId, groupId: input.groupId, previousGroupId }); }
          return node;
        },
        groups: { list: () => [], get: (id: string) => (id.startsWith("g-") ? { id, theaterId: "t1" } : null), create: () => { throw new Error("unused"); }, patch: () => null, delete: () => false },
      },
      consoleControl: {
        request: async (input: { kind: string; operationId?: string; text?: string; title?: string; sessionName?: string; viewMode?: string; disableSubagents?: boolean }) => {
          if (input.kind === "send") { sent.push({ operationId: input.operationId!, text: input.text! }); return { id: "r", requestId: "r", caller: { kind: "plugin", pluginId: "todo" }, input, status: "running", createdAt: "", updatedAt: "", expiresAt: "", operationId: input.operationId }; }
          await new Promise((resolve) => setTimeout(resolve, 5));
          const id = `launched-${launches.length + 1}`;
          launches.push({ title: input.title, sessionName: input.sessionName, viewMode: input.viewMode, text: input.text, disableSubagents: input.disableSubagents });
          operations.set(id, { id, theaterId: "t1", title: input.title ?? id, payload: {} });
          return { id: "r", requestId: "r", caller: { kind: "plugin", pluginId: "todo" }, input, status: "running", createdAt: "", updatedAt: "", expiresAt: "", operationId: id };
        },
        observe: () => null,
      },
      paths: { resolveTheaterPath: () => dir },
    },
  } as unknown as FleetPluginServerContext;
  const launch = createLaunchService(ctx, store);
  const [tool] = createTodoConsoleTools(ctx, store, launch);
  const call = async (args: Record<string, unknown>, caller?: { kind: "operation"; operationId: string }) => {
    const result = await tool!.execute(args, { cwd: dir, ...(caller ? { caller } : {}) }) as { isError: boolean; structuredContent: Record<string, unknown> };
    return result;
  };
  return { dir, store, events, launch, tool: tool!, call, operations, sent, launches, ctx, grouped };
}

describe("To-do contract", () => {
  it("keeps an item in its Chef's Operation group: follows the Chef, reconciles on start, and moves the Chef when the item moves", async () => {
    const { store, launch, operations, ctx, grouped } = harness();
    const sync = createGroupSync(ctx, store);
    grouped.push((event) => sync.operationGrouped(event));
    const item = store.create({ theaterId: "t1", title: "Ship", groupId: "g-review", steps: [{ text: "a" }, { text: "b" }] });
    store.stepPatch(item.id, item.steps[0]!.id, { assign: { mode: "model" } });
    const chef = (await launch.startCoordinator(item.id)).operationId;
    const worker = (await launch.delegateStep(item.id, item.steps[0]!.id)).operationId;
    await launch.complete(item.id, "human");
    // 사이드바에서 (완료된 항목의) 셰프를 옮기면 항목이 따라간다; 담당만 옮긴 것은 항목을 움직이지 않는다.
    ctx.host.operations.patch(chef, { groupId: "g-done" });
    expect(store.find(item.id)!.groupId).toBe("g-done");
    ctx.host.operations.patch(worker, { groupId: "g-other" });
    expect(store.find(item.id)!.groupId).toBe("g-done");
    // 이 동기화 전에 갈라진 항목은 기동 때 셰프의 그룹으로 맞춰진다.
    store.patch(item.id, { groupId: null });
    sync.reconcile();
    expect(store.find(item.id)!.groupId).toBe("g-done");
    // 할 일에서 항목을 옮기면 셰프와 담당이 따라가고, 되돌아온 사건은 항목을 다시 쓰지 않는다.
    const moved = store.patch(item.id, { groupId: "g-review" });
    const writes = store.find(item.id)!.updatedAt;
    sync.itemRegrouped(moved);
    expect([operations.get(chef)!.groupId, operations.get(worker)!.groupId]).toEqual(["g-review", "g-review"]);
    expect(store.find(item.id)!.updatedAt).toBe(writes);
  });

  it("starts the coordinator and one named assignee session per step at once, and keeps storage consistent across completion, reopen and re-plan", async () => {
    const { dir, store, events, launch, sent, launches } = harness();
    const item = store.create({ theaterId: "t1", title: "Release", steps: [{ text: "a" }, { text: "b", after: [0] }, { text: "c", after: [1] }] });
    // 새 단계의 기본은 「셰프 직접」— 담당을 띄우려면 배정이 있어야 한다.
    for (const step of item.steps) store.stepPatch(item.id, step.id, { assign: { mode: "model" } });
    const [a, , c] = item.steps;
    // 순환은 저장 전에 거절된다.
    expect(() => store.stepPatch(item.id, a!.id, { after: [c!.id] })).toThrow(TodoStoreError);
    expect(store.find(item.id)!.steps[0]!.after).toEqual([]);
    // 시작 한 번 — 셰프만 이름 붙은 CLI 세션으로 뜬다. 담당은 셰프가 위임하는 순간에 프롬프트 없이 뜬다.
    const started = await launch.startCoordinator(item.id);
    const head = `todo-${item.id.slice(0, 6)}`;
    expect(launches.map((entry) => entry.sessionName)).toEqual([`${head}-chef`]);
    expect(launches[0]!.viewMode).toBe("terminal");
    expect(launches[0]!.text).toContain(item.id);
    expect(started.item.slot?.sessionName).toBe(`${head}-chef`);
    const delegated = await launch.delegateStep(item.id, a!.id);
    expect(delegated.session).toBe(`${head}-step-1`);
    expect(launches.at(-1)).toMatchObject({ sessionName: `${head}-step-1`, viewMode: "terminal", disableSubagents: true });
    expect(launches[0]!.disableSubagents).toBeUndefined();
    expect(launches.at(-1)!.text).toBeUndefined();
    // 같은 단계를 두 번 위임할 수 없고, 끝난 단계도 위임할 수 없다.
    await expect(launch.delegateStep(item.id, a!.id)).rejects.toMatchObject({ code: "slot_taken" });
    await launch.stepPatched(item.id, a!.id, { done: true }, "human");
    await expect(launch.delegateStep(item.id, a!.id)).rejects.toMatchObject({ code: "step_done" });
    await launch.delegateStep(item.id, item.steps[1]!.id);
    await launch.delegateStep(item.id, c!.id);
    await launch.stepPatched(item.id, item.steps[1]!.id, { done: true }, "human");
    // 완료해도 매핑은 남는다 — 카드의 Operation 이동과 묶음이 그대로다; 되돌리기도 그대로 잇는다.
    const done = await launch.complete(item.id, "human");
    expect(done.done?.released.map((entry) => entry.slot.operationId)).toEqual([started.operationId, "launched-2", "launched-3", "launched-4"]);
    expect(done.slot?.operationId).toBe(started.operationId);
    expect(done.steps.map((step) => step.slot?.operationId)).toEqual(["launched-2", "launched-3", "launched-4"]);
    const reopened = store.reopen(item.id);
    expect(reopened.slot?.operationId).toBe(started.operationId);
    expect(reopened.steps[1]!.slot?.operationId).toBe("launched-3");
    // 계획은 완료·배정된 단계를 보존하고 나머지를 바꾼다; 새 단계는 stepId 로 기존 단계 뒤에 설 수 있다.
    // 단계는 레시피 순으로 선다 — 계획이 뒤에 적은 선행(y)이 그 후속(x)보다 앞으로 온다.
    store.setSlot(item.id, c!.id, null);
    // 다시 작업해 다시 완료하면 기록이 덮이지 않고 쌓인다.
    store.stepDone(item.id, a!.id, ["a done"], "human");
    store.stepDone(item.id, a!.id, ["a redone", "fixed the gap"], "human");
    const planned = store.plan(item.id, { steps: [{ text: "x", after: [{ index: 1, why: "shares files" }] }, { text: "y", after: [{ stepId: a!.id, why: "builds on a" }] }] }, "human");
    expect(planned.steps.map((step) => step.text)).toEqual(["a", "b", "y", "x"]);
    expect(planned.steps[2]!.after).toEqual([a!.id]);
    expect(planned.steps[3]!.why?.[planned.steps[2]!.id]).toBe("shares files");
    // 재시작 뒤에도 파일에서 같은 상태를 읽는다.
    const reloaded = createTodoStore({ dir, emit: () => undefined });
    expect(reloaded.find(item.id)?.steps[0]?.records?.map((record) => [record.kind, record.lines])).toEqual([["done", ["a done"]], ["redone", ["a redone", "fixed the gap"]]]);
    // 이 판 이전의 파일 — 단계마다 덮어쓰던 결과 한 줄은 시각 없는 첫 기록(읽음)으로 옮겨진다.
    fs.writeFileSync(path.join(dir, "legacy.json"), JSON.stringify({ version: 1, items: [{ ...item, id: "legacy-item", theaterId: "legacy", steps: [{ id: "s", text: "old", done: true, after: [], slot: null, result: "shipped\nverified" }] }] }));
    const legacy = createTodoStore({ dir, emit: () => undefined }).find("legacy-item")!.steps[0]!;
    expect(legacy).toMatchObject({ records: [{ at: null, kind: "done", lines: ["shipped", "verified"] }], seen: 1 });
    expect("result" in legacy).toBe(false);
    // 모든 쓰기가 사건으로 나갔다 — 화면은 이 프레임으로 갱신된다.
    expect(events.filter((event) => event.op === "upsert" && event.itemId === item.id).length).toBeGreaterThanOrEqual(8);
    // 메모 첨부 — 머리 바이트가 이미지가 아니면(SVG·HTML) 받지 않는다; 받은 파일은 항목과 함께 지워진다.
    expect(imageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'))).toBeNull();
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000030806000000", "hex");
    expect(imageInfo(png)).toEqual({ type: "image/png", width: 2, height: 3 });
    const attached = store.attachmentAdd(item.id, { name: "shot.png", type: "image/png", data: png });
    const file = store.attachmentPath(attached.item, attached.attachment);
    expect(path.isAbsolute(file) && fs.existsSync(file)).toBe(true);
    store.remove(item.id);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("lets only the Chef plan and mark steps, keeps completion and linking human-only, and refuses overlapping starts", async () => {
    const { store, call, launch, sent, launches } = harness();
    const item = store.create({ theaterId: "t1", title: "Guarded", steps: [{ text: "one" }, { text: "two", after: [0] }] });
    // 조율자 슬롯이 비어 있으면 아무 Operation 도 완료·계획할 수 없다.
    expect((await call({ plan: { itemId: item.id, steps: [{ text: "p" }] } }, { kind: "operation", operationId: "stranger" })).structuredContent.error).toBe("not_item_operation");
    // 연결은 사람의 일이다 — 도구에는 link 가 없다. 사람이 연결한 뒤 계획을 쓴다.
    expect((await call({ link: { itemId: item.id, operationId: "coord" } }, { kind: "operation", operationId: "coord" })).isError).toBe(true);
    await launch.linkCoordinator(item.id, "coord");
    const planned = await call({ plan: { itemId: item.id, steps: [{ text: "p1", assign: "route" }, { text: "p2", after: [{ index: 0 }], assign: "route" }] } }, { kind: "operation", operationId: "coord" });
    expect(planned.isError).toBe(false);
    // 계획은 담당을 띄우지 않는다 — 셰프가 위임할 때 뜬다.
    expect(launches).toEqual([]);
    const delegated = await call({ step: { itemId: item.id, index: 0, delegate: true } }, { kind: "operation", operationId: "coord" });
    expect(delegated.structuredContent.session).toBe(`todo-${item.id.slice(0, 6)}-step-1`);
    expect(launches.map((entry) => entry.sessionName)).toEqual([`todo-${item.id.slice(0, 6)}-step-1`]);
    // 사람이 선행 없이 더한 단계는 미분류 — 셰프가 자리를 정하기 전까지 준비되지 않는다. 셰프의 step after 가 자리를 정한다.
    const added = await launch.stepAdded(item.id, { text: "missed" }, { by: "human" });
    let missed = added.steps.length - 1;
    const board = async () => ((await call({ view: "item", itemId: item.id }, { kind: "operation", operationId: "coord" })).structuredContent.item as { graph: { steps: { unplaced?: boolean; ready: boolean; after: number[] }[] } }).graph.steps;
    expect((await board())[missed]).toMatchObject({ unplaced: true, ready: false });
    // 셰프가 읽기 전에 사람이 바꾼 보드(edited)로는 계획도 검토 요청도 쓸 수 없다 — 옛 보드로 한 일이 사람의 편집을 덮거나 지나치지 않는다.
    store.setEdited(item.id, ["steps"]);
    expect((await call({ plan: { itemId: item.id, steps: [{ text: "stale" }] } }, { kind: "operation", operationId: "coord" })).structuredContent.error).toBe("board_changed");
    expect((await call({ review: { itemId: item.id, summary: "stale" } }, { kind: "operation", operationId: "coord" })).structuredContent.error).toBe("board_changed");
    // 다시 읽은 뒤의 계획은 받되, 사람이 더한 미분류 단계는 지우지 않는다.
    await board();
    expect((await call({ plan: { itemId: item.id, steps: [{ text: "replanned" }] } }, { kind: "operation", operationId: "coord" })).isError).toBe(false);
    missed = (await board()).findIndex((step) => step.unplaced);
    expect(missed).toBeGreaterThanOrEqual(0);
    expect((await call({ step: { itemId: item.id, index: missed, after: [0] } }, { kind: "operation", operationId: "launched-1" })).structuredContent.error).toBe("not_item_operation");
    expect((await call({ step: { itemId: item.id, index: missed, after: [0] } }, { kind: "operation", operationId: "coord" })).isError).toBe(false);
    expect((await board())[missed]).toMatchObject({ after: [0] });
    expect((await board())[missed]!.unplaced).toBeUndefined();
    // 완료 표시와 완료는 조율자만 — 완료는 결론 먼저 1–3줄의 기록과 함께이고, 산문 문단은 거절된다.
    expect((await call({ step: { itemId: item.id, doneIndex: 0, summary: ["r"] } }, { kind: "operation", operationId: "launched-1" })).structuredContent.error).toBe("not_item_operation");
    expect((await call({ step: { itemId: item.id, doneIndex: 0, summary: ["x".repeat(400)] } }, { kind: "operation", operationId: "coord" })).structuredContent.error).toBe("summary_format");
    expect(store.find(item.id)!.steps[0]!.done).toBe(false);
    expect((await call({ step: { itemId: item.id, doneIndex: 0, summary: ["shipped p1", "tests pass"] } }, { kind: "operation", operationId: "coord" })).isError).toBe(false);
    // 다음 단계가 받는 것 — 가장 최근 기록과 기록 수.
    expect(((await call({ view: "item", itemId: item.id }, { kind: "operation", operationId: "coord" })).structuredContent.item as { graph: { steps: { record: { lines: string[] }; records: number }[] } }).graph.steps[0]).toMatchObject({ record: { lines: ["shipped p1", "tests pass"] }, records: 1 });
    // 할 일 자체의 완료는 AI 도구에 없다 — 사람의 완료는 매핑을 남긴다.
    expect((await call({ done: { itemId: item.id } }, { kind: "operation", operationId: "coord" })).isError).toBe(true);
    expect((await launch.complete(item.id, "human")).slot?.operationId).toBe("coord");
    expect(store.find(item.id)!.done).not.toBeNull();
    // 같은 슬롯에 시작이 겹치면 하나만 뜬다.
    const other = store.create({ theaterId: "t1", title: "Twice", steps: [{ text: "s1" }, { text: "s2" }] });
    const results = await Promise.allSettled([launch.startCoordinator(other.id), launch.startCoordinator(other.id)]);
    expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
    expect(results.some((result) => result.status === "rejected" && (result.reason as TodoStoreError).code === "slot_taken")).toBe(true);
  });
});

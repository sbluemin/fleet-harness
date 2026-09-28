import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OperationGroupedEvent, OperationNode } from "@fleet-console/sdk/operations";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import objectivesPlugin from "../routes.js";
import { clustersOf } from "../client/clusters.js";
import { imageInfo } from "../server/attachments.js";
import { createObjectiveConsoleTools } from "../server/console-tools.js";
import { createLaunchService } from "../server/launch.js";
import { createObjectiveMcpTools } from "../server/objective-tools.js";
import { createObjectiveRoutes } from "../server/routes.js";
import { createObjectiveStore, ObjectiveStoreError, type ObjectiveStore } from "../server/store.js";
import { MAX_FOLLOWUPS, type ObjectiveEvent } from "../server/types.js";
import { RESULT_LIMITS, type ObjectiveResult } from "../server/results.js";
import { createGhPrLookup, createPrStatusService } from "../server/pr-status.js";

/**
 * 목표의 필수 계약 — 목표 레코드는 Operation 없이 태어나고, 개시·구상 때 같은 id 의 지휘관이 한 번만 선다.
 * 따로 만든 Agent Operation 은 가상 목표로 남고, 저장·권한·그룹·검토 계약을 보존한다.
 */

const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

type Node = { -readonly [K in keyof OperationNode]: OperationNode[K] };

/** 저장된 레코드 — 이 계약이 들여다보는 값만. */
type Saved = {
  readonly operationId: string;
  readonly rank: number;
  readonly note?: string;
  readonly members?: readonly { readonly role: string; readonly subagents?: boolean }[];
  readonly criteriaProposals?: readonly unknown[];
  readonly followupBatches?: readonly { readonly items: readonly unknown[] }[];
  readonly operationIntent?: { readonly requestId: string; readonly action: "archive" | "ensure-active" };
  readonly results?: readonly ObjectiveResult[];
};

function harness(routingOrigin: () => string | null = () => null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-objectives-"));
  dirs.push(dir);
  const theaterPath = path.join(dir, "project");
  const workspace = path.join(dir, "data", "workspaces", "project");
  const events: ObjectiveEvent[] = [];
  class OperationRecords extends Map<string, Node> {
    override get(id: string): Node | undefined {
      const parent = super.get(id);
      if (parent) return parent;
      for (const owner of super.values()) {
        const child = owner.childSessions?.find((entry) => entry.id === id);
        if (child) return { id, theaterId: owner.theaterId, type: "agent", pluginId: null,
          title: String((child.payload.session as { sessionName?: string } | undefined)?.sessionName ?? id.slice(0, 8)),
          parentOperationId: owner.id, payload: child.payload, geometry: null, ts: child.ts };
      }
      return undefined;
    }
    override has(id: string): boolean { return !!this.get(id); }
    override delete(id: string): boolean {
      if (super.delete(id)) return true;
      for (const owner of super.values()) {
        if (!owner.childSessions?.some((child) => child.id === id)) continue;
        const rest = owner.childSessions.filter((child) => child.id !== id);
        owner.childSessions = rest.length ? rest : undefined;
        return true;
      }
      return false;
    }
  }
  const operations = new OperationRecords();
  // Core 저장소 구현을 재현하지 않는다. 플러그인 경계에서는 지정 ID의 위치만 바꾸는 adapter다.
  const archivedOperations = new OperationRecords();
  const archiveCalls: string[] = [];
  const accessCalls: string[] = [];
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
  const interrupted: string[] = [];
  const launches: { title?: string; sessionName?: string; viewMode?: string; text?: string; dormant?: boolean; disableSubagents?: boolean; disableUserQuestions?: boolean; groupId?: string }[] = [];
  const resumed: string[] = [];
  const subagentSpawns: { operationId: string; policy: "blocked" | "default" }[] = [];
  const userQuestions: { operationId: string; policy: "blocked" | "default" }[] = [];
  // 호스트처럼 표면은 채팅 표식이 말하고, 살아 있는 세션은 지금 보이는 표면으로 덮을 수 있다.
  const surfaces = new Map<string, "chat" | "terminal">();
  // 호스트의 멱등 기동 키 — 키 하나에 Operation 하나, 지운 키는 다시 만들지 않는다. hostFault 는 생성 뒤 응답을 잃는 장애다.
  const keyed = new Map<string, string>();
  const deletedKeys = new Set<string>();
  const reservedKeys = new Set<string>();
  const hostFault = { afterCreate: 0, sendError: null as string | null };
  const operationsHost = {
    describe: (id: string) => {
      const operation = operations.get(id) ?? archivedOperations.get(id);
      return operation ? { operation, location: archivedOperations.has(id) ? "archived" as const : "active" as const, rootOperationId: operation.parentOperationId ?? id, archivedAt: archivedOperations.has(id) ? 1 : null } : null;
    },
    archive: async (id: string) => {
      archiveCalls.push(id);
      const operation = operations.get(id) ?? archivedOperations.get(id);
      if (!operation) throw new Error("unknown_operation");
      archivedOperations.set(id, operation); operations.delete(id); activity.set(id, "dormant");
      return { archiveId: `archive-${id}`, targetId: id, rootOperationId: id, operationIds: [id], archivedAt: 1, revision: archiveCalls.length };
    },
    access: async (id: string, _intent?: string) => {
      accessCalls.push(id);
      const target = operations.get(id) ?? archivedOperations.get(id);
      if (!target) throw new Error("unknown_operation");
      const rootId = target.parentOperationId ?? id;
      const operation = operations.get(rootId) ?? archivedOperations.get(rootId)!;
      const restoredIds = archivedOperations.has(rootId) ? [rootId] : [];
      operations.set(rootId, operation); archivedOperations.delete(rootId);
      if (restoredIds.length) activity.set(rootId, "dormant");
      return { targetId: id, rootOperationId: rootId, restoredIds, operations: [operation] };
    },
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
    // 호스트처럼 지운 Operation 의 기동 키는 삭제로 읽힌다(유예·purge).
    delete: (id: string) => { deleted.push(id); for (const [key, target] of keyed) if (target === id) deletedKeys.add(key); return operations.delete(id) || archivedOperations.delete(id); },
    deleteChild: (id: string) => { if (!operations.get(id)?.parentOperationId) return false; deleted.push(id); return operations.delete(id); },
    groups: { list: () => [], get: (id: string) => (id.startsWith("g-") ? { id, theaterId: "t1" } : null), create: () => { throw new Error("unused"); }, patch: () => null, delete: () => false },
  };
  const store = createObjectiveStore({ dirOf: (theaterId) => (theaterId === "t1" ? path.join(workspace, "objectives") : null), operations: operationsHost, emit: (event) => events.push(event), now: () => clock++ });
  let routeBody: unknown;
  let authorized = true;
  let routeResult: { status: number; value: unknown } = { status: 0, value: null };
  const ctx = {
    pluginId: "objectives",
    host: {
      security: { isTerminalAuthorized: () => authorized },
      http: { readJsonBody: async () => routeBody, writeJson: (_res: unknown, status: number, value: unknown) => { routeResult = { status, value }; } },
      server: { origin: routingOrigin },
      operations: operationsHost,
      consoleControl: {
        launchState: ({ key }: { theaterId: string; key: string }) => deletedKeys.has(key) ? { state: "purged" } : keyed.has(key) && operations.has(keyed.get(key)!) ? { state: "live", operationId: keyed.get(key) } : reservedKeys.has(key) ? { state: "reserved" } : { state: "absent" },
        reserveLaunchKeys: ({ keys }: { theaterId: string; keys: readonly string[] }) => { for (const key of keys) reservedKeys.add(key); },
        request: async (input: { kind: string; operationId?: string; text?: string; title?: string; sessionName?: string; viewMode?: string; dormant?: boolean; disableSubagents?: boolean; disableUserQuestions?: boolean; model?: string; effort?: string; groupId?: string; launchKey?: string; newOperationId?: string; parentOperationId?: string; childSessionId?: string }) => {
          if (input.kind === "send") { if (hostFault.sendError) { const code = hostFault.sendError; hostFault.sendError = null; throw new Error(code); } sent.push({ operationId: input.operationId!, text: input.text! }); if (activity.get(input.operationId!) === "dormant") activity.set(input.operationId!, "idle"); return { operationId: input.operationId }; }
          // 호스트처럼 터미널은 실행 중일 때만 interrupt 를 받는다.
          if (input.kind === "interrupt") { if (activity.get(input.operationId!) !== "running") throw new Error("capability_unavailable"); interrupted.push(input.operationId!); activity.set(input.operationId!, "idle"); return { operationId: input.operationId }; }
          // resume 은 휴면만 세션째 되살린다.
          if (input.kind === "resume") { if (activity.get(input.operationId!) !== "dormant") throw new Error("not_dormant"); resumed.push(input.operationId!); activity.set(input.operationId!, "idle"); return { operationId: input.operationId }; }
          if (input.launchKey && deletedKeys.has(input.launchKey)) throw new Error("launch_key_deleted");
          if (input.launchKey && keyed.has(input.launchKey)) return { operationId: keyed.get(input.launchKey) };
          await new Promise((resolve) => setTimeout(resolve, 5));
          const id = input.childSessionId ?? input.newOperationId ?? `launched-${launches.length + 1}`;
          if (input.childSessionId && operations.has(id)) {
            if (operations.get(id)?.parentOperationId !== input.parentOperationId) throw new Error("operation_id_taken");
            return { operationId: id };
          }
          if (input.launchKey) keyed.set(input.launchKey, id);
          launches.push({ title: input.title, sessionName: input.sessionName, viewMode: input.viewMode, text: input.text, dormant: input.dormant, disableSubagents: input.disableSubagents, disableUserQuestions: input.disableUserQuestions, groupId: input.groupId });
          // 호스트 관측 — 첫 메시지 없이 띄운 세션은 유휴(대기), dormant 로 만든 것은 휴면.
          activity.set(id, input.dormant ? "dormant" : "idle");
          const payload = { ...(input.viewMode === "chat" ? { chatMode: true } : {}), ...(input.launchKey ? { launchKey: { owner: "objectives", key: input.launchKey } } : {}), session: { harness: "claude-code", ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}), ...(input.sessionName ? { sessionName: input.sessionName } : {}) } };
          if (input.childSessionId && input.parentOperationId) {
            const parent = operations.get(input.parentOperationId)!;
            parent.childSessions = [...(parent.childSessions ?? []), { id, payload, ts: { createdAt: clock++, updatedAt: clock } }];
          } else add(id, { title: input.title ?? id, groupId: input.groupId ?? null, payload });
          if (input.launchKey && hostFault.afterCreate > 0) { hostFault.afterCreate -= 1; throw new Error("request_timeout"); }
          return { operationId: id };
        },
        observe: (id: string) => {
          const state = activity.get(id);
          return state ? { lifecycle: state === "dormant" ? "dormant" : "live", activity: state === "dormant" ? "idle" : state, surface: surfaces.get(id) ?? (operations.get(id)?.payload.chatMode === true ? "chat" : "terminal"), supportedActions: ["send", ...(state === "running" ? ["interrupt"] : [])] } : null;
        },
        setSubagentSpawn: (operationId: string, policy: "blocked" | "default") => { subagentSpawns.push({ operationId, policy }); },
        setUserQuestions: (operationId: string, policy: "blocked" | "default") => { userQuestions.push({ operationId, policy }); },
      },
      paths: { resolveTheaterPath: () => theaterPath },
    },
  } as unknown as FleetPluginServerContext;
  const launch = createLaunchService(ctx, store);
  grouped.push((event) => launch.operationGrouped(event));
  // 결정 요청은 기본으로 기다리지 않는다 — 기다림은 그 계약을 다루는 테스트가 따로 켠다.
  const tools = createObjectiveMcpTools(ctx, store, launch, undefined, { decisionWaitMs: 0 });
  const call = async (name: string, args: Record<string, unknown>, operationId?: string) => await tools.find((tool) => tool.name === name)!.execute(args, { cwd: dir, ...(operationId ? { caller: { kind: "operation" as const, operationId } } : {}) }) as { isError: boolean; structuredContent: Record<string, unknown> };
  const consoleTool = createObjectiveConsoleTools(ctx, store, launch)[0]!;
  const route = async (name: string, body: Record<string, unknown>): Promise<{ status: number; value: Record<string, unknown> }> => {
    routeBody = body;
    routeResult = { status: 0, value: null };
    const handler = createObjectiveRoutes(ctx, store, launch).find((entry) => entry.name === name)!.handler;
    await handler({ req: { method: "POST" } as never, res: {} as never, pathname: name });
    return routeResult as { status: number; value: Record<string, unknown> };
  };
  const resultFile = async (objectiveId: string, resultId: string, allow = true) => {
    authorized = allow;
    routeResult = { status: 0, value: null };
    const output = { status: 0, headers: {} as Record<string, string | number>, data: Buffer.alloc(0) as Buffer };
    try {
      await createObjectiveRoutes(ctx, store, launch).find((entry) => entry.name === "result/file")!.handler({ req: { method: "GET", url: `/?objectiveId=${encodeURIComponent(objectiveId)}&resultId=${encodeURIComponent(resultId)}` } as never,
        res: { writeHead: (status: number, headers: Record<string, string | number>) => { output.status = status; output.headers = headers; }, end: (data: Buffer) => { output.data = data; } } as never, pathname: "result/file" });
      return { ...output, status: output.status || routeResult.status, error: (routeResult.value as { error?: string } | null)?.error };
    } finally { authorized = true; }
  };
  // 저장은 목표마다 디렉터리 하나 — `<objectives>/<목표>/objective.json`.
  const objectivesDir = path.join(workspace, "objectives");
  const objectiveFile = (objectiveId: string) => path.join(objectivesDir, objectiveId, "objective.json");
  const savedObjective = (objectiveId: string) => JSON.parse(fs.readFileSync(objectiveFile(objectiveId), "utf8")) as Saved;
  const savedIds = () => (fs.existsSync(objectivesDir) ? fs.readdirSync(objectivesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : []);
  return { ctx, store, events, launch, call, consoleTool, route, resultFile, operations, archivedOperations, archiveCalls, accessCalls, operationsHost, add, sent, launches, deleted, objectivesDir, objectiveFile, savedObjective, savedIds, workspace, activity, interrupted, resumed, subagentSpawns, userQuestions, surfaces, keyed, deletedKeys, reservedKeys, hostFault };
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000030806000000", "hex");

describe("Objectives contract", () => {
  // Core의 두 파일 복구 시험으로는 목표 파일의 done와 미완료 요청 사이 틈을 검증할 수 없다.
  it("recovers a completion request from its record and retains that record until public purge", async () => {
    const h = harness();
    h.add("completion-recovery", { payload: { session: { harness: "claude-code", sessionName: "existing-session" } } });
    h.store.adopt("completion-recovery", { note: "retain this record" });
    // 캡션에서 수동 보관한 미완료 목표도 기존 편집 API가 같은 Operation을 되찾는다.
    await h.operationsHost.archive("completion-recovery");
    const preset = await h.route("objective/patch", { objectiveId: "completion-recovery", patch: { launch: { model: "sonnet", viewMode: "chat" } } });
    expect(preset.status).toBe(200);
    expect(h.operations.get("completion-recovery")?.payload.session).toMatchObject({ model: "sonnet", sessionName: "existing-session" });
    await h.operationsHost.archive("completion-recovery");
    const renamed = await h.route("objective/patch", { objectiveId: "completion-recovery", patch: { title: "Edited after closing", groupId: "g-edit" } });
    expect(renamed.status).toBe(200);
    expect(h.operations.get("completion-recovery")).toMatchObject({ title: "Edited after closing", groupId: "g-edit" });
    expect(h.launches).toEqual([]);
    vi.spyOn(h.operationsHost, "archive").mockRejectedValueOnce(new Error("archive_stop_failed"));
    await expect(h.launch.complete("completion-recovery")).rejects.toThrow("archive_stop_failed");
    expect(h.savedObjective("completion-recovery").operationIntent?.action).toBe("archive");
    const reloaded = createObjectiveStore({ dirOf: () => h.objectivesDir, theaterIds: () => ["t1"], operations: h.operationsHost, emit: () => {} });
    const launch = createLaunchService(h.ctx, reloaded);
    await launch.resumeOperationIntents();
    expect(h.operations.has("completion-recovery")).toBe(false);
    expect(reloaded.find("completion-recovery")).toMatchObject({ done: expect.any(Object), note: "retain this record", commander: { sessionName: "existing-session" } });
    expect(h.savedObjective("completion-recovery").operationIntent).toBeUndefined();
    const accesses = h.accessCalls.length;
    await expect(launch.rename("completion-recovery", "must stay read-only")).rejects.toThrow("objective_done");
    expect(h.accessCalls).toHaveLength(accesses);
    expect(h.archivedOperations.has("completion-recovery")).toBe(true);
    launch.remove("completion-recovery");
    expect(h.archivedOperations.has("completion-recovery")).toBe(false);
    expect(fs.existsSync(h.objectiveFile("completion-recovery"))).toBe(true);
    launch.operationPurged("completion-recovery");
    expect(fs.existsSync(h.objectiveFile("completion-recovery"))).toBe(false);
    launch.dispose();
  });

  it("lets a person opt one member into subagents without blocking the others or the live process", async () => {
    let routingOrigin: string | null = null;
    const { store, launch, call, launches, resumed, activity, interrupted, subagentSpawns, userQuestions, savedObjective, operations, operationsHost, surfaces } = harness(() => routingOrigin);
    const objective = await launch.create({ theaterId: "t1", title: "Opt in", groupId: null, note: "brief" });
    const allowed = store.memberAdd(objective.id, { role: "build", subagents: true }, "human").members[0]!;
    const blocked = store.memberAdd(objective.id, { role: "research" }, "human").members[1]!;
    expect(store.find(objective.id)!.members.map((member) => member.subagents)).toEqual([true, false]);
    await launch.requestPlan(objective.id);
    store.setPlanning(objective.id, false);
    await launch.muster(objective.id);
    expect(launches.slice(1).map((entry) => entry.disableSubagents)).toEqual([undefined, true]);
    // 구성원만 사람에게 묻지 않는다 — 지휘관은 질문을 그대로 가진다.
    expect(launches.map((entry) => entry.disableUserQuestions)).toEqual([true, true, true]);
    // 새 구성원은 지휘관의 뷰와 무관하게 채팅으로 뜬다 — 미기동 지휘관의 저장된 시작 뷰가 터미널이어도.
    expect(launches.slice(1).map((entry) => entry.viewMode)).toEqual(["chat", "chat"]);
    const roster = store.find(objective.id)!;
    const blockedOperationId = blocked.id;
    activity.set(blockedOperationId, "dormant");
    await operationsHost.archive(objective.id);
    await launch.memberPatched(objective.id, blocked.id, { subagents: true });
    expect(store.find(objective.id)!.members.find((member) => member.id === blocked.id)!.subagents).toBe(true);
    const allowedOperationId = allowed.id;
    expect(subagentSpawns).toEqual([
      { operationId: allowedOperationId, policy: "default" },
      { operationId: blockedOperationId, policy: "blocked" },
      { operationId: blockedOperationId, policy: "default" },
    ]);
    expect(interrupted).toEqual([]);
    subagentSpawns.length = 0;
    expect((await launch.muster(objective.id)).find((member) => member.id === blocked.id)!.state).toBe("resumed");
    expect(subagentSpawns).toEqual([{ operationId: blockedOperationId, policy: "default" }]);
    expect(resumed).toEqual([blockedOperationId]);
    // 재개 전에 질문 차단을 다시 채운다 — 이 정책 전에 뜬 구성원도 재개로 풀려나지 않는다.
    expect(userQuestions).toContainEqual({ operationId: blockedOperationId, policy: "blocked" });
    await launch.memberPatched(objective.id, allowed.id, { subagents: false });
    expect(store.find(objective.id)!.members.find((member) => member.id === allowed.id)!.subagents).toBe(false);
    expect(subagentSpawns.at(-1)).toEqual({ operationId: allowed.id, policy: "blocked" });
    const stored = savedObjective(objective.id).members!;
    expect(stored.find((member) => member.role === "research")!.subagents).toBe(true);
    expect(stored.find((member) => member.role === "build")).not.toHaveProperty("subagents");
    expect(stored.every((member) => !Object.keys(member).some((key) => ["operationId", "session", "sessionName", "model", "effort"].includes(key)))).toBe(true);
    const refused = await call("plan", { objectiveId: objective.id, missions: [{ text: "next" }], members: [{ role: "extra", subagents: true }] }, objective.id);
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.error).toBe("invalid_arguments");

    // 라우팅 응답을 기다리는 동안 해제한 허용은 아직 뜨지 않은 구성원의 첫 기동부터 반영한다.
    const routed = store.memberAdd(objective.id, { role: "review", subagents: true }, "human").members.at(-1)!;
    let finishRouting!: (response: Response) => void;
    const routingResponse = new Promise<Response>((resolve) => { finishRouting = resolve; });
    let enteredRouting!: () => void;
    const routingStarted = new Promise<void>((resolve) => { enteredRouting = resolve; });
    vi.stubGlobal("fetch", () => { enteredRouting(); return routingResponse; });
    routingOrigin = "http://routing.invalid";
    // 휴면 지휘관이 채팅으로 저장돼 있어도 새 구성원은 채팅으로 태어난다.
    operations.get(objective.id)!.payload = { ...operations.get(objective.id)!.payload, chatMode: true };
    const pendingMuster = launch.muster(objective.id);
    await routingStarted;
    await launch.memberPatched(objective.id, routed.id, { subagents: false });
    finishRouting(Response.json({ mode: "model", decisions: [{ key: routed.id, model: "sonnet", label: "sonnet", because: "sonnet · AI model", fallback: false }] }));
    await pendingMuster;
    expect(launches.at(-1)?.disableSubagents).toBe(true);
    expect(launches.at(-1)?.viewMode).toBe("chat");

    // 명단에서 뺀 구성원은 코어 부모의 childSessions에서도 없어진다.
    await operationsHost.archive(objective.id);
    await launch.memberRemoved(objective.id, routed.id);
    expect(operations.has(routed.id)).toBe(false);
    expect(operations.get(objective.id)!.childSessions?.some((child) => child.id === routed.id)).toBe(false);

    // 살아 있는 지휘관이 터미널로 떠 있어도 새 구성원은 채팅으로 태어난다.
    vi.unstubAllGlobals();
    routingOrigin = null;
    activity.set(objective.id, "idle");
    surfaces.set(objective.id, "terminal");
    const late = store.memberAdd(objective.id, { role: "late" }, "human").members.at(-1)!;
    await launch.muster(objective.id);
    expect(launches.at(-1)?.viewMode).toBe("chat");
    await launch.memberRemoved(objective.id, late.id);

    // 부모 삭제는 자식 레코드도 함께 거두며, 재기동 대상으로 다시 분리되지 않는다.
    operations.delete(objective.id);
    expect(operations.has(blockedOperationId)).toBe(false);
    expect(operations.has(allowedOperationId)).toBe(false);
    launch.operationPurged(objective.id);
    expect(store.find(blockedOperationId)).toBeNull();
  });

  it("batch-updates member launch mode to same or route while preserving custom models", async () => {
    const { store, launch, route } = harness();
    const objective = await launch.create({ theaterId: "t1", title: "Batch Launch Test", groupId: null, note: "brief" });
    const m1 = store.memberAdd(objective.id, { role: "architect" }, "human").members[0]!;
    const m2 = store.memberAdd(objective.id, { role: "backend", launch: { mode: "same" } }, "human").members[1]!;
    const m3 = store.memberAdd(objective.id, { role: "frontend", launch: { mode: "model", model: "sonnet[1m]", effort: "high" } }, "human").members[2]!;

    // 1. 일괄 "same" 적용: m1(route) -> same, m2(same) -> same, m3(model) -> preserved
    const resSame = await route("member/batch-launch", { objectiveId: objective.id, mode: "same" });
    expect(resSame.status).toBe(200);
    const updated1 = store.find(objective.id)!;
    expect(updated1.members.find((m) => m.id === m1.id)!.launch).toEqual({ mode: "same" });
    expect(updated1.members.find((m) => m.id === m2.id)!.launch).toEqual({ mode: "same" });
    expect(updated1.members.find((m) => m.id === m3.id)!.launch).toEqual({ mode: "model", model: "sonnet[1m]", effort: "high" });
    expect(updated1.edited?.kinds).toContain("members");

    // 2. 일괄 "route" 적용: m1, m2 -> route, m3(model) -> preserved
    const resRoute = await route("member/batch-launch", { objectiveId: objective.id, mode: "route" });
    expect(resRoute.status).toBe(200);
    const updated2 = store.find(objective.id)!;
    expect(updated2.members.find((m) => m.id === m1.id)!.launch).toEqual({ mode: "route" });
    expect(updated2.members.find((m) => m.id === m2.id)!.launch).toEqual({ mode: "route" });
    expect(updated2.members.find((m) => m.id === m3.id)!.launch).toEqual({ mode: "model", model: "sonnet[1m]", effort: "high" });
  });

  it("creates a pending objective and launches its Commander once on demand", async () => {
    const { store, events, launch, call, route, resultFile, operations, operationsHost, archivedOperations, archiveCalls, accessCalls, sent, launches, objectiveFile, savedObjective, savedIds, objectivesDir, workspace, activity, interrupted, resumed, hostFault } = harness();
    const objective = await launch.create({ theaterId: "t1", title: "Release", groupId: "g-ship", note: "brief", missions: [{ text: "a" }, { text: "b", prerequisites: [1] }, { text: "c", prerequisites: [2] }] });
    expect(launches).toEqual([]);
    expect(operations.has(objective.id)).toBe(false);
    expect(store.list("t1")).toContainEqual(expect.objectContaining({ id: objective.id, title: "Release", groupId: "g-ship" }));
    expect(savedObjective(objective.id).operationId).toBe(objective.id);
    expect(savedObjective(objective.id)).toHaveProperty("pending.title", "Release");
    const head = objective.commander.sessionName!.replace(/-cmdr$/, "");
    const [a, b, c] = objective.missions;
    expect(() => store.missionPatch(objective.id, a!.id, { prerequisites: [c!.id] })).toThrow(ObjectiveStoreError);
    // 공개 편집 경로의 명시적 잇기/끊기는 중복 전달돼도 반대로 토글되지 않는다(간선 보존 계약).
    const edge = (linked: boolean) => route("edge/toggle", { objectiveId: objective.id, from: a!.id, to: b!.id, linked });
    expect((await edge(true)).value.linked).toBe(true);
    expect(store.find(objective.id)!.missions.find(m => m.id === b!.id)!.prerequisites).toEqual([a!.id]);
    await edge(false);
    expect((await edge(false)).value.linked).toBe(false);
    expect(store.find(objective.id)!.missions.find(m => m.id === b!.id)!.prerequisites).toEqual([]);
    await edge(true);
    expect((await route("edge/toggle", { objectiveId: objective.id, from: c!.id, to: a!.id, linked: true })).status).toBeGreaterThanOrEqual(400);
    expect(store.find(objective.id)!.missions.find(m => m.id === a!.id)!.prerequisites).toEqual([]);
    expect((await launch.setPreset(objective.id, { viewMode: "chat" })).commander.viewMode).toBe("chat");
    expect((await launch.setPreset(objective.id, { viewMode: "terminal" })).commander.viewMode).toBe("terminal");
    await launch.rename(objective.id, "Release renamed");
    expect(store.find(objective.id)!.title).toBe("Release renamed");
    // 구성원 명단 — 임무는 구성원만 가리킨다. 두 임무가 한 구성원을 나눠 쓴다.
    const research = store.memberAdd(objective.id, { role: "research" }, "human").members[0]!.id;
    const build = store.memberAdd(objective.id, { role: "build" }, "human").members[1]!.id;
    store.missionPatch(objective.id, a!.id, { member: research });
    store.missionPatch(objective.id, b!.id, { member: build }, { by: "human" });
    store.missionPatch(objective.id, c!.id, { member: build });
    // 개시 — 구성원 전원을 한꺼번에, 첫 메시지 없이(대기) 서브에이전트 없이 띄운 뒤 지휘관에게만 한 줄을 보낸다.
    hostFault.afterCreate = 1;
    await expect(launch.startCommander(objective.id)).rejects.toThrow("request_timeout");
    expect(savedObjective(objective.id)).toHaveProperty("pending.title", "Release renamed");
    hostFault.sendError = "claude_trust_required";
    await expect(launch.startCommander(objective.id)).rejects.toThrow("claude_trust_required");
    expect(store.find(objective.id)?.title).toBe("Release renamed");
    const starts = await Promise.all([launch.startCommander(objective.id), launch.startCommander(objective.id)]);
    expect(starts.map((entry) => entry.operationId)).toEqual([objective.id, objective.id]);
    expect(launches.filter((entry) => entry.dormant)).toHaveLength(1);
    expect(savedObjective(objective.id)).not.toHaveProperty("pending");
    expect(operations.get(objective.id)!.payload.consoleUse).toBeUndefined();
    expect(sent).toEqual([{ operationId: objective.id, text: expect.stringContaining(objective.id) }]);
    expect(launches.slice(1)).toEqual([
      expect.objectContaining({ sessionName: `${head}-member-1`, dormant: undefined, disableSubagents: true, text: undefined }),
      expect.objectContaining({ sessionName: `${head}-member-2`, dormant: undefined, disableSubagents: true, text: undefined }),
    ]);
    // 첫 세션이 잡힌 뒤에는 유휴 상태여도 모델·뷰를 바꾸지 못한다.
    const node = operations.get(objective.id)!;
    node.payload.session = { ...(node.payload.session as object), id: "captured-session", capturedAt: "2026-09-25T00:00:00Z", source: "hook" };
    await expect(launch.setPreset(objective.id, { viewMode: "chat" })).rejects.toThrow("objective_busy");
    expect(store.find(objective.id)!.commander.viewMode).toBe("terminal");
    // 위임할 때마다 새 Operation 을 만들지 않는다 — 같은 구성원의 임무는 같은 Operation 이다.
    expect(store.find(objective.id)!.missions.map((mission) => mission.operationId)).toEqual([research, build, build]);
    // 임무 진행(blocked/done)은 그대로 두되, 실제 구성원 입력 대기를 별도 신호로 cluster 서술자에 전달한다.
    const clusterMember = (id: string) => clustersOf([store.find(objective.id)!], new Map([...activity].map(([key, value]) => [key, value])))[0]!.members.find((member) => member.operationId === id)!;
    activity.set(build, "awaiting");
    expect(clusterMember(build)).toMatchObject({ progress: "blocked", awaitingInput: true });
    activity.set(build, "idle");
    expect(clusterMember(build)).toMatchObject({ progress: "blocked", awaitingInput: false });
    // 다시 세워도 살아 있는 구성원은 그대로, 휴면한 구성원은 새로 띄우지 않고 세션째 재개한다.
    activity.set(research, "dormant");
    expect((await launch.muster(objective.id)).map((member) => member.state)).toEqual(["resumed", "live"]);
    expect([launches.length, resumed]).toEqual([3, [research]]);
    // 다시 작업해 다시 완료하면 기록이 쌓인다(종류는 위치로).
    store.missionDone(objective.id, a!.id, ["a done"]);
    store.missionDone(objective.id, a!.id, ["a redone", "fixed the gap"]);
    activity.set(research, "awaiting");
    expect(clusterMember(research)).toMatchObject({ progress: "done", awaitingInput: true });
    activity.set(research, "idle");
    // 완료는 Core에 지휘관 ID 하나만 요청한다. active 목록에서 빠져도 기록·연결은 계속 보인다.
    activity.set(objective.id, "awaiting");
    expect((await launch.complete(objective.id)).done).toBeTruthy();
    expect(archiveCalls.filter((id) => id === objective.id)).toEqual([objective.id]);
    expect(operations.has(objective.id)).toBe(false);
    expect(archivedOperations.has(objective.id)).toBe(true);
    expect(store.list("t1").find((item) => item.id === objective.id)?.done).toBeTruthy();
    expect((await launch.reopen(objective.id)).missions.map((mission) => mission.member)).toEqual([research, build, build]);
    expect(accessCalls.at(-1)).toBe(objective.id);
    expect(operations.has(objective.id)).toBe(true);
    // 옛 완료 기록은 active에 그대로 남을 수 있다. 완료 해제는 성공하고, 재완료부터 새 경로를 탄다.
    store.complete(objective.id);
    expect(operations.has(objective.id)).toBe(true);
    await launch.reopen(objective.id);
    await launch.complete(objective.id);
    expect(archiveCalls.filter((id) => id === objective.id)).toEqual([objective.id, objective.id]);
    await launch.reopen(objective.id);
    // 계획은 완료·기록·사람이 담당을 정한 임무를 보존하고 나머지를 바꾼다; 새 임무는 편성 순으로 선다.
    const planned = store.plan(objective.id, { missions: [{ text: "x", prerequisites: [{ n: 2, why: "shares files" }] }, { text: "y", prerequisites: [{ missionId: a!.id, why: "builds on a" }] }] });
    expect(planned.missions.map((mission) => mission.text)).toEqual(["a", "b", "y", "x"]);
    expect(planned.missions[3]!.why[planned.missions[2]!.id]).toBe("shares files");
    // 저장 — 목표마다 자기 디렉터리의 objective.json 하나, Operation 이 가진 값은 싣지 않는다.
    expect(savedIds()).toEqual([objective.id]);
    const saved = savedObjective(objective.id);
    expect(Object.keys(saved).sort()).toEqual(["commenced", "enlisted", "members", "missions", "note", "operationId", "rank"]);
    expect(saved.operationId).toBe(objective.id);
    for (const key of ["title", "theaterId", "groupId", "slot", "createdAt", "updatedAt", "history", "author", "review"]) expect(JSON.stringify(saved)).not.toContain(`"${key}"`);
    // 재시작 뒤에도 파일에서 같은 상태를 읽는다 — 제목·그룹은 Operation 에서 온다.
    const reloaded = createObjectiveStore({ dirOf: () => path.join(workspace, "objectives"), operations: { get: (id) => operations.get(id) ?? null, list: () => [...operations.values()] }, emit: () => undefined });
    expect(reloaded.find(objective.id)).toMatchObject({ title: "Release renamed", groupId: "g-ship", criteriaOpen: false, criteriaProposals: [] });
    expect(reloaded.find(objective.id)!.missions[0]!.records.map((record) => [record.kind, record.lines])).toEqual([["done", ["a done"]], ["redone", ["a redone", "fixed the gap"]]]);
    // 결과물은 임무 기록과 독립된 지휘관 도구다. 이전 저장에는 없고, 등록·수정·재시작을 지나 ID와 참조가 남는다.
    expect(reloaded.find(objective.id)!.results).toEqual([]);
    const pr = await call("attach_result", { objectiveId: objective.id, result: { kind: "pr", url: "https://github.com/Example/Project/pull/12/", sourceMissionId: a!.id } }, objective.id);
    expect(pr.isError).toBe(false);
    const prId = pr.structuredContent.resultId as string;
    expect(store.find(objective.id)!.results).toContainEqual(expect.objectContaining({ id: prId, kind: "pr", url: "https://github.com/example/project/pull/12", observation: { state: "unchecked", checkedAt: null, stale: true } }));
    expect((await call("attach_result", { objectiveId: objective.id, result: { kind: "pr", url: "https://github.com/example/project/pull/12" } }, objective.id)).structuredContent).toMatchObject({ error: "result_exists", resultId: prId });
    expect((await call("update_result", { objectiveId: objective.id, resultId: prId, patch: { url: "https://github.com/example/project/pull/13", label: "Review", note: "Ready" } }, objective.id)).isError).toBe(false);
    const restored = createObjectiveStore({ dirOf: () => objectivesDir, operations: { get: (id) => operations.get(id) ?? null, list: () => [...operations.values()] }, emit: () => undefined });
    expect(restored.find(objective.id)!.results).toEqual(store.find(objective.id)!.results);
    expect(restored.find(objective.id)!.results).toContainEqual(expect.objectContaining({ id: prId, url: "https://github.com/example/project/pull/13", label: "Review", note: "Ready" }));
    expect((await route("objective/get", { objectiveId: objective.id })).value.objective).toHaveProperty("results", restored.find(objective.id)!.results);
    expect((await call("update_result", { objectiveId: objective.id, resultId: prId, patch: { label: null, note: null } }, objective.id)).isError).toBe(false);
    expect(store.find(objective.id)!.results[0]).not.toHaveProperty("label");
    expect((await call("detach_result", { objectiveId: objective.id, resultId: prId }, objective.id)).isError).toBe(false);
    expect((await call("detach_result", { objectiveId: objective.id, resultId: prId }, objective.id)).structuredContent.error).toBe("unknown_result");
    expect(savedObjective(objective.id).results).toBeUndefined();
    // 구성원은 자기 증거를 seal하고 지휘관이 결과물로 붙인다. 원본·세션 종료 후에도 목표의 복사본이 열린다.
    const ownedRoot = store.sharedDir(objective.theaterId, objective.id);
    fs.mkdirSync(ownedRoot, { recursive: true, mode: 0o700 });
    const screenshot = path.join(fs.realpathSync(ownedRoot), "G01.png");
    const document = path.join(fs.realpathSync(ownedRoot), "EVIDENCE.md");
    fs.writeFileSync(screenshot, PNG); fs.writeFileSync(document, "# 검증\n\n확인했습니다.\n");
    const image = await call("seal_evidence_from_path", { objectiveId: objective.id, path: screenshot }, research);
    const text = await call("seal_evidence_from_path", { objectiveId: objective.id, path: document }, research);
    const pendingEvidence = await call("seal_evidence_from_path", { objectiveId: objective.id, path: screenshot }, research);
    expect(image.structuredContent).not.toHaveProperty("error");
    expect(text.structuredContent).not.toHaveProperty("error");
    expect(pendingEvidence.structuredContent).not.toHaveProperty("error");
    expect(store.find(objective.id)!.results).toEqual([]);
    const imageResult = await call("attach_result", { objectiveId: objective.id, result: { kind: "evidence", evidenceId: image.structuredContent.evidenceId } }, objective.id);
    expect(imageResult.isError).toBe(false);
    const imageId = imageResult.structuredContent.resultId as string;
    expect((await resultFile(objective.id, imageId, false)).status).toBe(401);
    const imageResponse = await resultFile(objective.id, imageId);
    expect(imageResponse).toMatchObject({ status: 200, headers: { "Content-Type": "image/png", "X-Content-Type-Options": "nosniff" } });
    expect(imageResponse.data).toEqual(PNG);
    // 같은 결과물의 bytes를 바꾸려면 별도로 seal한 immutable evidenceId로 교체한다.
    expect((await call("update_result", { objectiveId: objective.id, resultId: imageId, patch: { evidenceId: text.structuredContent.evidenceId } }, objective.id)).isError).toBe(false);
    expect(fs.existsSync(path.join(objectivesDir, objective.id, "evidence", `${image.structuredContent.evidenceId}.png`))).toBe(false);
    const textResponse = await resultFile(objective.id, imageId);
    expect(textResponse).toMatchObject({ status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": "inline", "Cache-Control": "private, no-store" } });
    expect(textResponse.data.toString("utf8")).toBe("# 검증\n\n확인했습니다.\n");
    fs.rmSync(ownedRoot, { recursive: true }); operations.delete(research);
    const evidenceReload = createObjectiveStore({ dirOf: () => objectivesDir, operations: { get: (id) => operations.get(id) ?? null, list: () => [...operations.values()] }, emit: () => undefined });
    expect((await evidenceReload.evidenceRead(objective.id, imageId)).data).toEqual(textResponse.data);
    expect(JSON.stringify((await route("objective/get", { objectiveId: objective.id })).value)).not.toContain(ownedRoot);
    expect(JSON.stringify(events)).not.toContain("ownerOperationId");
    expect((await call("detach_result", { objectiveId: objective.id, resultId: imageId }, objective.id)).isError).toBe(false);
    expect((await resultFile(objective.id, imageId)).status).toBe(404);
    const pendingFile = path.join(objectivesDir, objective.id, "evidence", `${pendingEvidence.structuredContent.evidenceId}.png`);
    expect(fs.existsSync(pendingFile)).toBe(true);
    // 모든 쓰기가 사건으로 나갔다 — 화면은 이 프레임으로 갱신된다.
    expect(events.filter((event) => event.op === "upsert" && event.objectiveId === objective.id).length).toBeGreaterThanOrEqual(8);
    // 메모 첨부 — 머리 바이트가 이미지가 아니면 받지 않는다; 목표를 지우면 지휘관 Operation 이 닫히고 구성원도 따라 닫히며,
    // 복원 불가로 확정될 때(purged) 레코드와 첨부가 사라진다.
    expect(imageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'))).toBeNull();
    const attached = store.attachmentAdd(objective.id, { name: "shot.png", type: "image/png", data: PNG });
    const file = store.attachmentPath(attached.objective, attached.attachment);
    // 첨부는 그 목표 디렉터리 안에 산다 — 경로는 store 가 정하고 바깥으로 새지 않는다.
    expect(path.dirname(file)).toBe(path.join(objectivesDir, objective.id, "attachments"));
    launch.remove(objective.id);
    launch.operationDeleted(objective.id);
    expect(operations.has(research) || operations.has(build)).toBe(false);
    // 유예 동안은 디렉터리째 남아 있다(복원하면 목표도 돌아온다).
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(pendingFile)).toBe(true);
    expect(fs.existsSync(objectiveFile(objective.id))).toBe(true);
    // 확정 삭제는 그 목표의 디렉터리 전체를 거둔다.
    launch.operationPurged(objective.id);
    expect(fs.existsSync(path.join(objectivesDir, objective.id))).toBe(false);
    expect(savedIds()).toEqual([]);
  });

  it("writes one objective's file per change and turns no link, failed write, failed read or failed delete into success", async () => {
    const { store, events, call, add, operations, objectivesDir, objectiveFile, savedIds, workspace } = harness();
    const bytes = (objectiveId: string) => fs.readFileSync(objectiveFile(objectiveId));
    const reload = () => createObjectiveStore({ dirOf: (theaterId) => (theaterId === "t1" ? objectivesDir : null), operations: { get: (id) => operations.get(id) ?? null, list: () => [...operations.values()] }, emit: () => undefined });
    add("alpha");
    add("beta");
    // 레코드 없는 Operation 은 파일 없이 보드에 선다 — 첫 편집이 그 목표의 파일 하나를 만든다.
    expect(savedIds()).toEqual([]);
    store.patch("alpha", { note: "a" });
    store.patch("beta", { note: "b" });
    expect(savedIds().sort()).toEqual(["alpha", "beta"]);

    // 한 목표의 편집은 그 목표의 파일만 다시 쓴다.
    const alphaBefore = bytes("alpha");
    store.patch("beta", { note: "b, revised" });
    expect(bytes("alpha")).toEqual(alphaBefore);

    // 쓰기가 실패하면 디스크도 캐시도 그대로다 — 반쯤 적용된 목표를 남기지 않는다.
    const failing = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw new Error("ENOSPC: no space left on device"); });
    expect(() => store.patch("alpha", { note: "lost" })).toThrow(/ENOSPC/);
    failing.mockRestore();
    expect(store.find("alpha")!.note).toBe("a");
    expect(bytes("alpha")).toEqual(alphaBefore);
    expect(reload().find("alpha")!.note).toBe("a");
    const sourceDir = store.sharedDir("t1", "alpha"); fs.mkdirSync(sourceDir, { recursive: true });
    const source = path.join(fs.realpathSync(sourceDir), "EVIDENCE.md"); fs.writeFileSync(source, "# preserved source");
    const binaryDir = path.join(objectivesDir, "alpha", "evidence");
    const write = fs.writeFileSync.bind(fs); let writes = 0;
    const beforeBinary = bytes("alpha"); const beforeEvents = events.length;
    const failMetadata = vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => { if (++writes === 2) throw new Error("ENOSPC"); return write(...args); });
    expect((await call("seal_evidence_from_path", { objectiveId: "alpha", path: source }, "alpha")).isError).toBe(true);
    failMetadata.mockRestore();
    expect(bytes("alpha")).toEqual(beforeBinary);
    expect(events).toHaveLength(beforeEvents);
    expect(fs.readdirSync(binaryDir)).toEqual([]);
    expect(fs.readFileSync(source, "utf8")).toBe("# preserved source");

    // 읽기 실패는 빈 보드가 아니다 — 없는 폴더만 빈 보드이고, 권한·입출력 오류는 전파돼 남은 파일을 빈 편집으로 덮지 않는다.
    const guarded = reload();
    const denied = vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); });
    expect(() => guarded.list("t1")).toThrow(/EACCES/);
    denied.mockRestore();
    expect(guarded.find("alpha")!.note).toBe("a");

    // 지우지 못한 목표를 지운 척하지 않는다 — 캐시도 방송도 그대로 남는다(다음 기동이 되살릴 목표를 만들지 않는다).
    const undeletable = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); });
    expect(() => store.forget("beta")).toThrow(/EPERM/);
    undeletable.mockRestore();
    expect(store.find("beta")!.note).toBe("b, revised");
    expect(events.some((event) => event.op === "remove")).toBe(false);

    // 목표의 파일이 밖을 가리키는 링크면 따라가지 않는다 — 그 목표만 빈 목표가 되고 밖의 파일은 그대로다.
    const outside = path.join(workspace, "outside.json");
    fs.writeFileSync(outside, JSON.stringify({ operationId: "beta", rank: -9, note: "밖" }));
    fs.rmSync(objectiveFile("beta"));
    fs.symlinkSync(outside, objectiveFile("beta"));
    const linked = reload();
    expect(linked.find("beta")).toMatchObject({ note: "", missions: [] });
    expect(linked.find("alpha")!.note).toBe("a");
    expect(JSON.parse(fs.readFileSync(outside, "utf8")).note).toBe("밖");
    expect(fs.readdirSync(path.join(objectivesDir, "beta")).some((name) => name.startsWith("objective.json.broken-"))).toBe(true);

    // 첨부 폴더가 링크여도 마찬가지 — 밖에는 한 바이트도 쓰지 않는다.
    const stray = path.join(workspace, "stray");
    fs.mkdirSync(stray);
    fs.symlinkSync(stray, path.join(objectivesDir, "alpha", "attachments"));
    expect(() => linked.attachmentAdd("alpha", { name: "shot.png", type: "image/png", data: PNG })).toThrow(/unsafe_path/);
    expect(fs.readdirSync(stray)).toEqual([]);
    fs.rmdirSync(binaryDir); fs.symlinkSync(stray, binaryDir);
    expect((await call("seal_evidence_from_path", { objectiveId: "alpha", path: source }, "alpha")).structuredContent.error).toBe("unsafe_path");
    expect(fs.readdirSync(stray)).toEqual([]);
    fs.unlinkSync(binaryDir);

    // 깨진 파일 하나는 그 목표만 빈 목표로 돌리고 격리 사본을 남긴다.
    fs.writeFileSync(objectiveFile("alpha"), "{ not json");
    const recovered = reload();
    expect(recovered.find("alpha")).toMatchObject({ note: "", missions: [] });
    expect(fs.readdirSync(path.join(objectivesDir, "alpha")).some((name) => name.startsWith("objective.json.broken-"))).toBe(true);
    // 손상된 results는 기존 JSON 손상과 같은 경계다. 그 목표의 원본을 격리하고 다른 목표는 그대로 읽는다.
    recovered.patch("alpha", { note: "other objective survives" });
    const priorBackups = new Set(fs.readdirSync(path.join(objectivesDir, "beta")));
    const recoveryBytes = path.join(objectivesDir, "beta", "evidence", "12345678-1234-4123-8123-123456789012.txt");
    fs.mkdirSync(path.dirname(recoveryBytes), { recursive: true }); fs.writeFileSync(recoveryBytes, "recovery evidence");
    fs.writeFileSync(objectiveFile("beta"), JSON.stringify({ operationId: "beta", rank: 1, note: "preserve", missions: [], results: [{ kind: "pr", url: "invalid" }], evidence: [{ evidenceId: "12345678-1234-4123-8123-123456789012" }] }));
    const corruptResults = bytes("beta");
    const isolated = reload();
    expect(isolated.list("t1")).toHaveLength(2);
    expect(isolated.find("alpha")!.note).toBe("other objective survives");
    expect(isolated.find("beta")).toMatchObject({ note: "", results: [] });
    const backup = fs.readdirSync(path.join(objectivesDir, "beta")).find((name) => name.startsWith("objective.json.broken-") && !priorBackups.has(name))!;
    expect(fs.readFileSync(path.join(objectivesDir, "beta", backup))).toEqual(corruptResults);
    isolated.patch("beta", { note: "new record" });
    expect(fs.readFileSync(path.join(objectivesDir, "beta", backup))).toEqual(corruptResults);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    isolated.evidenceCollect(); warning.mockRestore();
    expect(fs.readFileSync(recoveryBytes, "utf8")).toBe("recovery evidence");
  });

  it("keeps the dropped position of objectives with and without records, through reload and a stopped respread", () => {
    const { store, events, add, operations, objectivesDir, objectiveFile, savedIds } = harness();
    const reload = (emit: (event: ObjectiveEvent) => void = () => undefined) =>
      createObjectiveStore({ dirOf: (theaterId) => (theaterId === "t1" ? objectivesDir : null), operations: { get: (id) => operations.get(id) ?? null, list: () => [...operations.values()] }, emit });
    const order = (board: ObjectiveStore) => board.list("t1").map((objective) => objective.id);
    add("one");
    add("two");
    add("three");
    // 레코드 없는 목표의 자리는 만든 시각이다 — 새것이 위.
    expect(order(store)).toEqual(["three", "two", "one"]);

    // 레코드 없는 두 목표 사이로 떨어뜨린다 — 파일을 얻는 목표는 옮긴 하나뿐이고, 그 자리는 다시 읽어도 그대로다.
    store.move("one", { afterId: "three" });
    expect(order(store)).toEqual(["three", "one", "two"]);
    expect(savedIds()).toEqual(["one"]);
    expect(events.at(-1)).toMatchObject({ op: "upsert", objectiveId: "one", order: ["three", "one", "two"] });
    expect(order(reload())).toEqual(["three", "one", "two"]);
    // 순서 이동은 사람이 목표로 다룬다는 뜻이 아니다 — 레코드가 된 뒤 임무가 붙어도 「목표 밖」에 남는다(구상·개시만 올린다).
    store.missionAdd("one", { text: "x" }, { by: "human" });
    expect(reload().find("one")).toMatchObject({ enlisted: false });

    // 첫 편집도 지금 자리를 그대로 받는다(레코드가 되면서 튀지 않는다) — 바뀐 줄은 방송에 실린다.
    store.patch("two", { note: "b" });
    expect(order(store)).toEqual(["three", "one", "two"]);
    expect(events.at(-1)).toMatchObject({ op: "upsert", objectiveId: "two", order: ["three", "one", "two"] });
    // 새로 세운 목표는 저장된 자리의 맨 아래에 선다.
    add("four");
    store.adopt("four", { note: "d" });
    expect(order(store)).toEqual(["three", "one", "two", "four"]);

    // 이웃한 실수 둘 사이에는 남은 자리가 없다 — 그때만 레코드 없는 목표 경계 안의 저장 목표들을 다시 벌린다.
    for (const [id, rank] of [["left", 0], ["right", Number.MIN_VALUE], ["spare", 10]] as const) {
      add(id);
      fs.mkdirSync(path.join(objectivesDir, id), { recursive: true });
      fs.writeFileSync(objectiveFile(id), JSON.stringify({ operationId: id, rank, note: id, missions: [] }));
    }
    const spread: ObjectiveEvent[] = [];
    const packed = reload((event) => spread.push(event));
    const before = order(packed);
    expect(before).toEqual(["three", "one", "two", "left", "right", "spare", "four"]);

    // 다시 벌리는 도중 쓰기가 실패하면 성공한 앞몫만 남고 줄의 순서는 하나도 뒤집히지 않는다 — 캐시·디스크·방송이 같은 줄을 말한다.
    const realWrite = fs.writeFileSync;
    let writes = 0;
    const flaky = vi.spyOn(fs, "writeFileSync").mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
      writes += 1;
      if (writes === 2) throw new Error("EIO: i/o error");
      return realWrite(...args);
    }) as typeof fs.writeFileSync);
    expect(() => packed.move("spare", { afterId: "left" })).toThrow(/EIO/);
    flaky.mockRestore();
    expect(order(packed)).toEqual(before);
    expect(order(reload())).toEqual(before);
    expect(spread.at(-1)).toMatchObject({ op: "upsert", objectiveId: "spare", order: before });

    // 같은 이동을 다시 하면 자리가 벌어지고, 레코드 없는 목표는 끝까지 파일을 얻지 않는다.
    packed.move("spare", { afterId: "left" });
    expect(order(packed)).toEqual(["three", "one", "two", "left", "spare", "right", "four"]);
    expect(order(reload())).toEqual(["three", "one", "two", "left", "spare", "right", "four"]);
    expect(savedIds()).not.toContain("three");

    // 같은 밀리초에 태어난 목표들 — id 안정 해시가 1/1024 칸으로 가른다. `tie-*` 세 개는 칸까지 겹쳐 자리가 완전히
    // 같고, `adj-0`/`adj-416` 은 이웃 칸(지금 시각에서 4 ulp)이다.
    const born = 1_790_000_000_000;
    const tail = ["three", "one", "two", "left", "spare", "right", "four"];
    for (const id of ["adj-0", "adj-416", "tie-10", "tie-591", "tie-762"]) add(id, { ts: { createdAt: born, updatedAt: born } });
    expect(order(packed)).toEqual(["adj-416", "adj-0", "tie-10", "tie-591", "tie-762", ...tail]);

    // 자리가 완전히 같은 셋 사이로 떨어뜨린다 — 그 자리만으로는 실수가 없으니 구간을 위로 넓혀 자리를 만든다.
    // 넓힌 구간의 레코드 없는 목표만 레코드가 되고(tie-10), 건드릴 필요 없는 tie-591 은 그대로 남는다.
    packed.move("tie-762", { afterId: "tie-10" });
    expect(order(packed)).toEqual(["adj-416", "adj-0", "tie-10", "tie-762", "tie-591", ...tail]);
    expect(order(reload())).toEqual(["adj-416", "adj-0", "tie-10", "tie-762", "tie-591", ...tail]);
    expect(savedIds()).toContain("tie-10");
    expect(savedIds()).not.toContain("tie-591");

    // 이웃 칸 사이에는 중간값이 남아 있다 — 구간을 넓히지 않고 옮긴 파일 하나로 끝난다.
    packed.move("tie-591", { beforeId: "adj-0" });
    expect(order(packed)).toEqual(["adj-416", "tie-591", "adj-0", "tie-10", "tie-762", ...tail]);
    expect(order(reload())).toEqual(["adj-416", "tie-591", "adj-0", "tie-10", "tie-762", ...tail]);
    expect(savedIds()).not.toContain("adj-0");
    expect(savedIds()).not.toContain("adj-416");
  });

  // 실수의 자리가 정말 바닥난 보드 — 1024 걸음이 자리로 남지 않는 크기(ulp ≥ 1024)에서만 일어난다.
  it("renumbers a board whose ranks leave no representable gap, and refuses the drop instead of corrupting the order", () => {
    const { operations, add, workspace } = harness();
    const objectivesDir = path.join(workspace, "objectives-packed");
    const open = () => createObjectiveStore({ dirOf: (theaterId) => (theaterId === "t2" ? objectivesDir : null), operations: { get: (id) => operations.get(id) ?? null, list: () => [...operations.values()] }, emit: () => undefined });
    const board = (rank: number) => {
      fs.rmSync(objectivesDir, { recursive: true, force: true });
      for (const id of ["pack-a", "pack-b", "pack-c"]) {
        fs.mkdirSync(path.join(objectivesDir, id), { recursive: true });
        fs.writeFileSync(path.join(objectivesDir, id, "objective.json"), JSON.stringify({ operationId: id, rank, note: id, missions: [] }));
      }
      return open();
    };
    for (const id of ["pack-a", "pack-b", "pack-c"]) add(id, { theaterId: "t2" });
    const order = (store: ObjectiveStore) => store.list("t2").map((objective) => objective.id);
    const rankOf = (id: string) => (JSON.parse(fs.readFileSync(path.join(objectivesDir, id, "objective.json"), "utf8")) as Saved).rank;

    // 1.5×2^62 에서 ulp 는 1024 다 — 1024 를 뺀 자리까지는 있어도 그 사이 중간값이 없어, 구간을 보드 전체로 넓혀도
    // 자리가 나오지 않는다. 그때 보드 전체를 1024 간격으로 다시 깔아 떨어뜨린 자리를 지킨다.
    const crowded = board(3 * 2 ** 61);
    crowded.move("pack-c", { afterId: "pack-a" });
    expect(order(crowded)).toEqual(["pack-a", "pack-c", "pack-b"]);
    expect([rankOf("pack-a"), rankOf("pack-c"), rankOf("pack-b")]).toEqual([3 * 2 ** 61 + 1024, 3 * 2 ** 61 + 2048, 3 * 2 ** 61 + 3072]);
    expect(order(board(3 * 2 ** 61))).toEqual(["pack-a", "pack-b", "pack-c"]); // 같은 폴더를 다시 깔았으니 원래 줄로 돌아온다

    // 균등 재번호도 아래에서 위로 쓴다 — 도중에 실패하면 쓴 몫은 안 쓴 몫 아래에 그대로 남아 줄이 뒤집히지 않고,
    // 캐시·디스크가 같은 몫에서 멈추며 어느 목표도 내용을 잃지 않는다.
    const flaky = board(3 * 2 ** 61);
    const realWrite = fs.writeFileSync;
    let writes = 0;
    const stub = vi.spyOn(fs, "writeFileSync").mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
      writes += 1;
      if (writes === 2) throw new Error("EIO: i/o error");
      return realWrite(...args);
    }) as typeof fs.writeFileSync);
    expect(() => flaky.move("pack-c", { afterId: "pack-a" })).toThrow(/EIO/);
    stub.mockRestore();
    expect(order(flaky)).toEqual(order(open()));
    expect([rankOf("pack-a"), rankOf("pack-c"), rankOf("pack-b")]).toEqual([3 * 2 ** 61, 3 * 2 ** 61, 3 * 2 ** 61 + 3072]);
    expect(flaky.find("pack-b")!.note).toBe("pack-b");

    // 1024 걸음조차 자리로 남지 않는 크기(1.5×2^63, ulp 2048)에서는 아무 것도 뒤집지 않고 거절한다 — 내용도 자리도 그대로다.
    const exhausted = board(3 * 2 ** 62);
    expect(() => exhausted.move("pack-c", { afterId: "pack-a" })).toThrow(ObjectiveStoreError);
    expect(order(exhausted)).toEqual(["pack-a", "pack-b", "pack-c"]);
    expect([rankOf("pack-a"), rankOf("pack-b"), rankOf("pack-c")]).toEqual([3 * 2 ** 62, 3 * 2 ** 62, 3 * 2 ** 62]);
  });

  it("adds an objective from Console Use with brief and criteria only, through the same exposed-schema gate the host checks", async () => {
    const { store, operations, add, savedIds, workspace, launches, consoleTool } = harness();
    const caller = add("console-caller", { title: "Console caller", groupId: "g-console" });
    // 호스트와 같은 선검사 — 노출 스키마를 되살려 먼저 통과시킨 뒤, 호스트처럼 파싱된 값(parsed.data)으로 execute 가 돈다.
    // 노출 스키마가 알 수 없는 키를 strip 하는 회귀는 조용한 생성으로 드러난다.
    const gate = z.fromJSONSchema(consoleTool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
    const throughGate = async (args: Record<string, unknown>) => {
      const parsed = gate.safeParse(args);
      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error("exposed schema rejected representative input");
      return (await consoleTool.execute(parsed.data, { cwd: workspace, caller: { kind: "operation" as const, operationId: caller.id } })) as { isError: boolean; structuredContent: Record<string, unknown> };
    };
    const created = await throughGate({ add: { title: "From Console Use", note: "brief", criteria: ["ships", "tested"] } });
    expect(created.isError).toBe(false);
    const id = created.structuredContent.objectiveId as string;
    // 브리핑·기준은 기본 요구사항으로, 임무·구성원 없이, 호출 Operation 의 그룹과 만든 표시를 들고 태어난다.
    expect(store.find(id)).toMatchObject({ note: "brief", groupId: "g-console", missions: [], members: [], addedBy: { operationId: caller.id } });
    expect(store.find(id)!.criteria).toMatchObject([{ text: "ships", by: "human" }, { text: "tested", by: "human" }]);
    // 저장 무결성 — 파일에서 다시 읽어도 기준이 기본 요구사항으로 남는다.
    const reloaded = createObjectiveStore({ dirOf: () => path.join(workspace, "objectives"), operations: { get: (oid) => operations.get(oid) ?? null, list: () => [...operations.values()] }, emit: () => undefined });
    expect(reloaded.find(id)!.criteria).toMatchObject([{ text: "ships", by: "human" }, { text: "tested", by: "human" }]);
    // 편성 키도 오타도 add 에 없다 — 선검사에서 막혀 사람의 권한 요청까지 가지 않는다.
    for (const args of [{ add: { title: "Typo", criterai: ["x"] } }, { add: { title: "Missions inline", missions: ["x"] } }, { add: { title: "Top-level missions" }, missions: ["x"] }]) {
      expect(gate.safeParse(args).success).toBe(false);
    }
    // 읽기 전용 키는 선검사를 지나므로 execute 가 이유 있게 거절한다 — 기동도 Operation 도 레코드도 늘지 않는다.
    const fenced = { launches: launches.length, operations: operations.size, listed: store.list("t1").length };
    const refused = await throughGate({ add: { title: "Borrowed group", note: "b" }, groupId: "g-other" });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.error).toBe("add_brief_criteria_only");
    // 이유 안내는 제공되지만 전문을 고정하지는 않는다 — 문구는 다듬을 수 있고 경계가 담기면 된다.
    expect(typeof refused.structuredContent.hint).toBe("string");
    expect((refused.structuredContent.hint as string).length).toBeGreaterThan(0);
    expect({ launches: launches.length, operations: operations.size, listed: store.list("t1").length }).toEqual(fenced);
    expect(savedIds()).toEqual([id]);
  });

  it("lets Console Use tell objectives without an Operation apart and merge or remove only those, keeping briefs and criteria, and lets the person restore them", async () => {
    const { store, launch, add, workspace, consoleTool, operations, route, savedIds } = harness();
    const caller = add("tidy-caller", { title: "Tidy caller" });
    const use = async (args: Record<string, unknown>) => (await consoleTool.execute(args, { cwd: workspace, caller: { kind: "operation" as const, operationId: caller.id } })) as { isError: boolean; structuredContent: Record<string, unknown> };
    const waiting = await launch.create({ theaterId: "t1", title: "Waiting", groupId: null, note: "long brief ".repeat(100), criteria: ["one", "two"] });
    const started = await launch.create({ theaterId: "t1", title: "Started", groupId: null });
    await launch.requestPlan(started.id);
    type Row = { id: string; kind: string; operation: boolean; done: boolean; self?: boolean; brief?: string; briefTruncated?: boolean; criteria?: string[] };
    const rows = async (filter?: string) => ((await use({ view: "objectives", ...(filter ? { filter } : {}) })).structuredContent.objectives as Row[]);
    const byId = (list: Row[]) => new Map(list.map((row) => [row.id, row]));
    // 한 번 읽은 목록만으로 Operation 유무·보드 목표와 대화 세션·자기 세션·브리핑과 기준을 가른다.
    const open = byId(await rows());
    expect(open.get(waiting.id)).toMatchObject({ kind: "objective", operation: false, briefTruncated: true, criteria: ["one", "two"] });
    expect(open.get(waiting.id)!.brief!.length).toBeLessThan(waiting.note.length);
    expect(open.get(started.id)).toMatchObject({ kind: "objective", operation: true });
    expect(open.get(caller.id)).toMatchObject({ kind: "session", operation: true, self: true });
    // 시작 전 목표의 지휘관은 닫힘이 아니다.
    const detail = (await use({ view: "objective", objectiveId: waiting.id })).structuredContent as { objective: { graph: { commander: { state: string } } } };
    expect(detail.objective.graph.commander.state).toBe("not_started");
    // 완료한 목표는 기본 목록에서 빠지지만 all 에서는 비교 대상으로 남는다.
    await launch.complete(started.id);
    expect(byId(await rows()).has(started.id)).toBe(false);
    expect(byId(await rows("all")).get(started.id)).toMatchObject({ done: true });

    const duplicate = await launch.create({ theaterId: "t1", title: "Duplicate", groupId: null, note: "dup brief", criteria: ["two", "three"] });
    const planned = await launch.create({ theaterId: "t1", title: "Planned by hand", groupId: null, missions: [{ text: "keep me" }] });
    const stale = await launch.create({ theaterId: "t1", title: "Stale", groupId: null });
    const before = store.find(waiting.id)!;
    // Operation 이 있는 목표·대화 세션·옮길 수 없는 것을 가진 원본이 하나라도 끼면 아무것도 바꾸지 않고 이유를 하나씩 댄다.
    const refused = await use({ merge: { into: waiting.id, from: [duplicate.id, started.id, caller.id, planned.id] } });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ error: "tidy_refused", refusals: expect.arrayContaining([
      expect.objectContaining({ objectiveId: started.id, reason: "has_operation" }),
      expect.objectContaining({ objectiveId: caller.id, reason: "conversation_session" }),
      expect.objectContaining({ objectiveId: planned.id, reason: "merge_would_drop", kinds: ["missions"] }),
    ]) });
    expect(store.find(waiting.id)).toMatchObject({ note: before.note, removed: null });
    expect(store.find(duplicate.id)!.removed).toBeNull();
    expect((await use({ remove: { objectiveIds: [caller.id] } })).structuredContent).toMatchObject({ error: "tidy_refused" });
    expect(operations.has(caller.id)).toBe(true);

    // 합치면 원본의 브리핑과 기준이 받는 목표로 옮겨 가고(같은 문장은 한 번), 원본은 지운 표시로 남아 기동되지 않는다.
    expect((await use({ merge: { into: waiting.id, from: [duplicate.id], reason: "same ask" } })).isError).toBe(false);
    expect(store.find(waiting.id)!.note).toContain("dup brief");
    expect(store.find(waiting.id)!.criteria.map((criterion) => criterion.text)).toEqual(["one", "two", "three"]);
    expect(store.find(duplicate.id)!.removed).toMatchObject({ by: { operationId: caller.id }, reason: "same ask", mergedInto: { id: waiting.id } });
    expect(byId(await rows()).has(duplicate.id)).toBe(false);
    expect(byId(await rows("all")).get(duplicate.id)).toMatchObject({ removed: true, mergedInto: waiting.id });
    await expect(launch.requestPlan(duplicate.id)).rejects.toMatchObject({ code: "objective_removed" });
    expect((await use({ remove: { objectiveIds: [stale.id] } })).isError).toBe(false);
    // 저장 무결성 — 다시 읽어도 지운 표시와 합친 기록이 그대로다.
    const reloaded = createObjectiveStore({ dirOf: () => path.join(workspace, "objectives"), operations: { get: (oid) => operations.get(oid) ?? null, list: () => [...operations.values()] }, emit: () => undefined });
    expect(reloaded.find(stale.id)!.removed).not.toBeNull();
    expect(reloaded.find(waiting.id)!.merged.map((entry) => entry.sourceId)).toEqual([duplicate.id]);

    // 사람이 보드에서 되돌린다 — 합친 원본을 되돌리면 받은 목표에서 덧붙인 구간과 옮긴 기준이 걷힌다.
    expect((await route("objective/restore", { objectiveId: stale.id })).status).toBe(200);
    expect(store.find(stale.id)!.removed).toBeNull();
    expect((await route("objective/restore", { objectiveId: duplicate.id })).status).toBe(200);
    expect(store.find(duplicate.id)).toMatchObject({ removed: null, note: "dup brief" });
    expect(store.find(waiting.id)).toMatchObject({ note: before.note, merged: [] });
    expect(store.find(waiting.id)!.criteria.map((criterion) => criterion.text)).toEqual(["one", "two"]);
    // 받은 목표까지 지운 뒤 원본부터 되돌려도 내용이 겹치지 않고, 받을 수 없는 id 가 낀 되돌리기는 아무것도 바꾸지 않는다.
    await use({ merge: { into: waiting.id, from: [duplicate.id] } });
    await use({ remove: { objectiveIds: [waiting.id] } });
    expect((await use({ restore: [duplicate.id, "missing"] })).structuredContent).toMatchObject({ error: "tidy_refused" });
    expect(store.find(duplicate.id)!.removed).not.toBeNull();
    expect((await use({ restore: [duplicate.id, waiting.id] })).isError).toBe(false);
    expect(store.find(waiting.id)).toMatchObject({ note: before.note, merged: [], removed: null });
    expect(store.find(waiting.id)!.criteria.map((criterion) => criterion.text)).toEqual(["one", "two"]);
    // 두 원본이 같은 기준을 가져왔으면 한쪽을 되돌려도 남은 원본의 기준은 받은 목표에 남는다.
    const left = await launch.create({ theaterId: "t1", title: "Left", groupId: null, criteria: ["shared"] });
    const right = await launch.create({ theaterId: "t1", title: "Right", groupId: null, criteria: ["shared"] });
    await use({ merge: { into: waiting.id, from: [left.id, right.id] } });
    await route("objective/restore", { objectiveId: left.id });
    expect(store.find(waiting.id)!.criteria.map((criterion) => criterion.text)).toEqual(["one", "two", "shared"]);
    await route("objective/restore", { objectiveId: right.id });
    expect(store.find(waiting.id)).toMatchObject({ note: before.note, merged: [] });
    expect(store.find(waiting.id)!.criteria.map((criterion) => criterion.text)).toEqual(["one", "two"]);

    // 사람이 지운 기동 전 목표도 같은 자리에 남아 되돌릴 수 있고, 거기서 한 번 더 지우면(비우기) 영구 삭제된다.
    expect((await route("objective/remove", { objectiveId: stale.id })).status).toBe(200);
    expect(store.find(stale.id)!.removed).toMatchObject({ by: null });
    expect((await route("objective/remove", { objectiveId: stale.id })).status).toBe(200);
    expect(store.find(stale.id)).toBeNull();
    expect(savedIds()).not.toContain(stale.id);
  });

  it("shows every agent Operation created elsewhere as an objective, but not member or plugin Operations", async () => {
    const { store, launch, add, savedIds, launches, call } = harness();
    add("sidebar", { title: "Made in the sidebar", groupId: "g-a" });
    add("wiki", { pluginId: "codex", type: "codex-wiki" });
    const made = await launch.create({ theaterId: "t1", title: "Made in Objectives", groupId: null, missions: [{ text: "one" }] });
    const madeMember = store.memberAdd(made.id, { role: "build" }, "human").members[0]!;
    await launch.requestPlan(made.id);
    store.setPlanning(made.id, false);
    await launch.muster(made.id);
    // 레코드 없는 Operation 은 빈 목표로 선다 — 구성원(launched-2)과 플러그인 Operation 은 목표가 아니다.
    expect(store.list("t1").map((objective) => objective.id).sort()).toEqual([made.id, "sidebar"].sort());
    expect(store.find("sidebar")).toMatchObject({ title: "Made in the sidebar", groupId: "g-a", note: "", missions: [], awaitingReview: false });
    expect(store.find(madeMember.id)).toBeNull();
    // 첫 편집이 레코드를 만든다 — 그래도 목표로 올리지는 않는다. 보드에서 만든 목표만 처음부터 목표다.
    expect(savedIds()).not.toContain("sidebar");
    store.patch("sidebar", { note: "now it has a brief" });
    expect(savedIds()).toContain("sidebar");
    expect(store.find("sidebar")).toMatchObject({ enlisted: false, commenced: false });
    expect(store.find(made.id)).toMatchObject({ enlisted: true, commenced: false });
    // 구상하면 시작 전 목표가 되고, 개시가 닿으면 진행 중이 된다 — 다시 읽어도 그대로다.
    await launch.requestPlan("sidebar");
    expect(store.find("sidebar")).toMatchObject({ enlisted: true, commenced: false });
    store.setPlanning("sidebar", false);
    await launch.startCommander("sidebar");
    expect(store.find("sidebar")).toMatchObject({ enlisted: true, commenced: true });
    // 따로 만든 지휘관에게는 고정 이름이 없다 — 구성원은 그래도 사람에게 묻지 않고, 주소를 지어내지 않고 null 로 받는다.
    const helper = store.memberAdd("sidebar", { role: "helper" }, "human").members.at(-1)!;
    await launch.muster("sidebar");
    expect(launches.at(-1)?.disableUserQuestions).toBe(true);
    const helperOperation = helper.id;
    expect((await call("mine", {}, helperOperation)).structuredContent).toMatchObject({ role: "member", commander: { session: null } });
  });

  it("keeps the group on the parent without adding group metadata to children", async () => {
    const { store, launch, operations } = harness();
    const objective = await launch.create({ theaterId: "t1", title: "Ship", groupId: "g-review", missions: [{ text: "a" }] });
    store.memberAdd(objective.id, { role: "build" }, "human");
    await launch.requestPlan(objective.id);
    store.setPlanning(objective.id, false);
    const worker = (await launch.muster(objective.id))[0]!.operationId;
    expect(operations.get(worker)!.groupId).toBeUndefined();
    expect(operations.get(objective.id)!.childSessions?.map((child) => child.id)).toEqual([worker]);
    await launch.regroup(objective.id, "g-done");
    expect([operations.get(objective.id)!.groupId, store.find(objective.id)!.groupId]).toEqual(["g-done", "g-done"]);
    expect(operations.get(worker)!.groupId).toBeUndefined();
    await expect(launch.regroup(objective.id, "nope")).rejects.toThrow(ObjectiveStoreError);
  });

  it("lets only the objective's own Commander write, gives members read-only access and outsiders none, and keeps planning and the person's missions and assignments intact", async () => {
    const { store, call, launch, workspace, events } = harness();
    const objective = await launch.create({ theaterId: "t1", title: "Guarded", groupId: null, missions: [{ text: "one" }, { text: "two", prerequisites: [1] }] });
    await launch.requestPlan(objective.id);
    const commander = objective.id;
    const other = (await launch.create({ theaterId: "t1", title: "Other", groupId: null })).id;
    // 다른 목표의 지휘관은 이 목표를 쓰지도 읽지도 못한다.
    expect((await call("plan", { objectiveId: objective.id, missions: [{ text: "p" }] }, other)).structuredContent.error).toBe("not_participant");
    expect((await call("read", { objectiveId: objective.id }, other)).structuredContent.error).toBe("not_participant");
    // 구상 중에는 편성만 — 명단이 비었을 때만 지휘관이 구성원을 제안하고(모델은 고르지 않아 라우팅), 임무에 구성원을 표시한다.
    // 임무 수행 쓰기와 구성원 기동은 거절된다.
    store.setPlanning(objective.id, true);
    expect((await call("plan", { objectiveId: objective.id, missions: [{ text: "p1", member: "build" }, { text: "p2", prerequisites: [{ n: 1 }] }], members: [{ role: "build", brief: "implements" }] }, commander)).isError).toBe(false);
    expect(store.find(objective.id)!.members).toMatchObject([{ role: "build", by: "commander", launch: { mode: "route" } }]);
    expect((await call("complete_mission", { objectiveId: objective.id, n: 1, summary: ["early"] }, commander)).structuredContent.error).toBe("planning_only");
    expect((await call("muster", { objectiveId: objective.id }, commander)).structuredContent.error).toBe("planning_only");
    // 명단이 있으면 지휘관은 명단을 다시 쓰지 못한다(빈 명단으로 지우는 것도).
    expect((await call("plan", { objectiveId: objective.id, missions: [{ text: "p3" }], members: [] }, commander)).structuredContent.error).toBe("members_exist");
    store.setPlanning(objective.id, false);
    const mustered = await call("muster", { objectiveId: objective.id }, commander);
    const member = (mustered.structuredContent.members as { id: string; state: string }[])[0]!;
    expect(member.state).toBe("launched");
    // 구성원은 제 역할과 맡은 임무를 읽지만 쓰지 못한다.
    // 구성원은 보고·판단 요청을 보낼 지휘관의 세션 주소를 함께 받는다.
    expect((await call("mine", {}, member.id)).structuredContent).toMatchObject({ role: "member", access: "read-only", objectiveId: objective.id, commander: { session: store.find(objective.id)!.commander.sessionName }, member: { role: "build", brief: "implements" }, missions: [{ n: 1, text: "p1" }] });
    expect(store.find(objective.id)!.commander.sessionName).toMatch(/-cmdr$/);
    expect((await call("read", { objectiveId: objective.id }, member.id)).isError).toBe(false);
    expect((await call("mine", {}, commander)).structuredContent).toMatchObject({ role: "commander", objectiveId: objective.id });
    // 새 결과물 도구도 같은 인증 caller 경계를 지난다. 구성원·외부·호출자 없음이 보드 쓰기로 이어지지 않는다.
    const resultInput = { kind: "pr", url: "https://github.com/example/project/pull/1" };
    expect((await call("attach_result", { objectiveId: objective.id, result: resultInput }, member.id)).structuredContent.error).toBe("not_commander");
    const attached = await call("attach_result", { objectiveId: objective.id, result: resultInput }, commander);
    const resultId = attached.structuredContent.resultId;
    expect(attached.isError).toBe(false);
    expect((await call("update_result", { objectiveId: objective.id, resultId, patch: { label: "foreign" } }, other)).structuredContent.error).toBe("not_participant");
    expect((await call("detach_result", { objectiveId: objective.id, resultId })).structuredContent.error).toBe("not_participant");
    expect((await call("update_result", { objectiveId: objective.id, resultId, patch: { path: "/private/user-file" } }, commander)).structuredContent.error).toBe("invalid_arguments");
    expect((await call("attach_result", { objectiveId: objective.id, result: { kind: "evidence", evidenceId: "12345678-1234-4123-8123-123456789012" } }, commander)).structuredContent.error).toBe("unknown_evidence");
    expect((await call("attach_result", { objectiveId: objective.id, result: { kind: "evidence", path: "/private/user-file" } }, commander)).structuredContent.error).toBe("invalid_arguments");
    expect((await call("attach_result", { objectiveId: objective.id, result: { kind: "pr", url: "https://elsewhere.invalid/o/r/pull/1" } }, commander)).structuredContent.error).toBe("unsupported_pr_host");
    expect((await call("read", { objectiveId: objective.id }, member.id)).structuredContent.objective).toHaveProperty("results", expect.arrayContaining([expect.objectContaining({ id: resultId })]));
    expect(store.find(objective.id)!.results).toHaveLength(1);
    const own = store.sharedDir(objective.theaterId, objective.id); fs.mkdirSync(own, { recursive: true });
    const root = fs.realpathSync(own);
    const ownFile = path.join(root, "EVIDENCE.md"); fs.writeFileSync(ownFile, "shared evidence");
    const seal = (source: string, by = member.id) => call("seal_evidence_from_path", { objectiveId: objective.id, path: source }, by);
    expect((await seal(ownFile, other)).structuredContent.error).toBe("not_participant");
    expect((await call("evidence_dir", { objectiveId: objective.id }, member.id)).structuredContent.root).toBe(root);
    const foreign = path.join(workspace, "other-session.md"); fs.writeFileSync(foreign, "not this session");
    expect((await seal(foreign)).structuredContent.error).toBe("evidence_outside_dir");
    fs.renameSync(root, `${root}-saved`);
    fs.symlinkSync(`${root}-saved`, root);
    expect((await seal(path.join(root, "EVIDENCE.md"))).structuredContent.error).toBe("unsafe_path");
    fs.rmSync(root); fs.renameSync(`${root}-saved`, root);
    fs.symlinkSync(foreign, path.join(root, "link.md"));
    expect((await seal(path.join(root, "link.md"))).structuredContent.error).toBe("evidence_symlink");
    fs.linkSync(foreign, path.join(root, "hard.md"));
    expect((await seal(path.join(root, "hard.md"))).structuredContent.error).toBe("evidence_hardlink");
    const directory = path.join(root, "folder"); fs.mkdirSync(directory);
    expect((await seal(directory)).structuredContent.error).toBe("evidence_not_regular");
    fs.writeFileSync(path.join(root, "active.svg"), '<svg onload="alert(1)"/>');
    expect((await seal(path.join(root, "active.svg"))).structuredContent.error).toBe("evidence_type");
    fs.writeFileSync(path.join(root, "large.txt"), Buffer.alloc(RESULT_LIMITS.imageBytes + 1));
    expect((await seal(path.join(root, "large.txt"))).structuredContent.error).toBe("evidence_too_large");
    // 실제 source를 읽는 도중 바꾼다. 스토어/SSE는 반쪽 증거를 받지 않는다.
    const originalOpen = fs.promises.open.bind(fs.promises);
    const changed = vi.spyOn(fs.promises, "open").mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      const read = handle.read.bind(handle);
      handle.read = (async (...readArgs: Parameters<typeof read>) => { const result = await read(...readArgs); fs.appendFileSync(ownFile, " changed"); return result; }) as typeof handle.read;
      return handle;
    });
    const beforeSeal = events.length;
    expect((await seal(ownFile)).structuredContent.error).toBe("evidence_changed");
    changed.mockRestore();
    expect(events).toHaveLength(beforeSeal);
    const sealed = await seal(ownFile);
    expect(sealed.isError).toBe(false);
    expect((await call("attach_result", { objectiveId: other, result: { kind: "evidence", evidenceId: sealed.structuredContent.evidenceId } }, other)).structuredContent.error).toBe("unknown_evidence");
    expect((await call("attach_result", { objectiveId: objective.id, result: { kind: "evidence", evidenceId: sealed.structuredContent.evidenceId } }, member.id)).structuredContent.error).toBe("not_commander");
    // 사람이 선행 없이 더한 임무는 미분류 — 지휘관이 자리를 정하기 전까지 준비되지 않는다.
    launch.missionAdded(objective.id, { text: "missed" }, { by: "human" });
    const board = async () => ((await call("read", { objectiveId: objective.id }, commander)).structuredContent.objective as { graph: { missions: { n: number; unplaced?: boolean; ready: boolean; prerequisites: number[]; member: { role: string } | null }[] } }).graph.missions;
    // 지휘관이 읽기 전에 사람이 바꾼 보드로는 계획을 쓸 수 없다.
    store.setEdited(objective.id, ["missions"]);
    expect((await call("update_result", { objectiveId: objective.id, resultId, patch: { note: "Stored independently" } }, commander)).isError).toBe(false);
    expect(store.find(objective.id)!.edited?.kinds).toEqual(["missions"]);
    expect((await call("plan", { objectiveId: objective.id, missions: [{ text: "stale" }] }, commander)).structuredContent.error).toBe("board_changed");
    const missed = (await board()).find((mission) => mission.unplaced)!;
    expect(missed).toMatchObject({ unplaced: true, ready: false });
    // 계획이 남기는 임무를 같은 문구로 다시 만들어 두 벌을 세우지 못한다.
    expect((await call("plan", { objectiveId: objective.id, missions: [{ text: " Missed " }] }, commander)).structuredContent).toMatchObject({ error: "mission_kept", kept: [{ text: "missed", unplaced: true }] });
    // 배치는 지휘관만 — 담당 구성원도 함께 정한다.
    expect((await call("place_mission", { objectiveId: objective.id, n: missed.n, prerequisites: [1] }, member.id)).structuredContent.error).toBe("not_commander");
    expect((await call("place_mission", { objectiveId: objective.id, n: missed.n, prerequisites: [1], member: "build" }, commander)).isError).toBe(false);
    expect((await board()).find((mission) => mission.prerequisites.includes(1) && mission.unplaced === undefined && mission.member?.role === "build")).toBeTruthy();
    // 사람이 정한 담당은 「지휘관 직접」이라도 지휘관이 덮지 못한다(계획 보존은 첫 계약에서).
    const p2 = store.find(objective.id)!.missions.find((mission) => mission.text === "p2")!;
    store.missionPatch(objective.id, p2.id, { member: null }, { by: "human" });
    await call("read", { objectiveId: objective.id }, commander);
    const p2N = store.find(objective.id)!.missions.findIndex((mission) => mission.id === p2.id) + 1;
    await call("place_mission", { objectiveId: objective.id, n: p2N, prerequisites: [1], member: "build" }, commander);
    expect(store.find(objective.id)!.missions.find((mission) => mission.id === p2.id)!.member).toBeNull();
    // 완료는 결론 먼저 1–3줄의 기록과 함께이고, 산문 문단은 거절된다. 구성원은 완료하지 못한다.
    expect((await call("complete_mission", { objectiveId: objective.id, n: 1, summary: ["r"] }, member.id)).structuredContent.error).toBe("not_commander");
    expect((await call("complete_mission", { objectiveId: objective.id, n: 1, summary: ["x".repeat(400)] }, commander)).structuredContent.error).toBe("summary_format");
    expect((await call("complete_mission", { objectiveId: objective.id, n: 1, summary: ["shipped p1", "tests pass"] }, commander)).isError).toBe(false);
    // 같은 목표에 시작이 겹치면 하나만 간다.
    const results = await Promise.allSettled([launch.startCommander(other), launch.startCommander(other)]);
    expect(results.filter((result) => result.status === "fulfilled").length).toBe(2);
    // 결과물 수의 상한과 완료 잠금은 도구 호출을 우회한 저장에서도 유지된다.
    for (let n = 2; n <= RESULT_LIMITS.count; n += 1) store.resultAdd(objective.id, { kind: "pr", url: `https://github.com/example/project/pull/${n}` });
    expect((await call("attach_result", { objectiveId: objective.id, result: { kind: "pr", url: "https://github.com/example/project/pull/999" } }, commander)).structuredContent.error).toBe("too_many_results");
    store.complete(objective.id);
    expect((await call("detach_result", { objectiveId: objective.id, resultId }, commander)).structuredContent.error).toBe("objective_done");
  });

  it("keeps the person's answers to a decision request as decisions only once delivered, and clears a request the board no longer supports without recording one", async () => {
    const { ctx, store, call, launch, route, sent, activity, hostFault, operationsHost, objectivesDir } = harness();
    const objective = await launch.create({ theaterId: "t1", title: "Ask", groupId: null, missions: [{ text: "ship" }] });
    await launch.requestPlan(objective.id);
    const commander = objective.id;
    await call("plan", { objectiveId: commander, missions: [{ text: "ship", member: "build" }], members: [{ role: "build" }] }, commander);
    store.setPlanning(commander, false);
    const member = ((await call("muster", { objectiveId: commander }, commander)).structuredContent.members as { id: string }[])[0]!.id;
    const missionId = store.find(commander)!.missions[0]!.id;
    const questions = [
      { text: "How far should publishing go?", options: [{ label: "Open the PR" }, { label: "Merge" }], missionId, memberId: member },
      { text: "Anything else?", options: [] },
    ];
    // 요청은 지휘관만 올린다. 늦은 revision 은 새 보드를 덮지 못한다.
    expect((await call("request_decision", { objectiveId: commander, expectedRevision: 0, questions }, member)).structuredContent.error).toBe("not_commander");
    const first = await call("request_decision", { objectiveId: commander, expectedRevision: 0, questions }, commander);
    expect(first.isError).toBe(false);
    expect((await call("request_decision", { objectiveId: commander, expectedRevision: 0, questions }, commander)).structuredContent.error).toBe("decision_request_changed");
    // 사람의 보드 편집은 옛 보드에 대한 요청을 정리하고, 결정은 남기지 않는다. 지휘관은 다시 읽기 전까지 새 요청을 올리지 못한다.
    await route("mission/add", { objectiveId: commander, mission: { text: "docs" } });
    expect(store.find(commander)).toMatchObject({ decisionRequest: null, decisions: [] });
    const docsId = store.find(commander)!.missions.find(mission => mission.text === "docs")!.id;
    const link = { objectiveId: commander, from: missionId, to: docsId, linked: true };
    await route("edge/toggle", link);
    const revision = store.find(commander)!.decisionRequestRevision;
    expect((await call("request_decision", { objectiveId: commander, expectedRevision: revision, questions }, commander)).structuredContent.error).toBe("board_changed");
    await call("read", { objectiveId: commander }, commander);
    const requested = (await call("request_decision", { objectiveId: commander, expectedRevision: revision, questions }, commander)).structuredContent;
    // 쓰기 응답은 새 요청 id만 — 질문·선택지 id는 사람이 보는 보드에서 읽는다.
    expect(requested).not.toHaveProperty("objective");
    const placed = store.find(commander)!.decisionRequest!;
    expect(placed.id).toBe(requested.requestId);
    // 연결 뒤 새 질문이 선 동안 늦게 도착한 중복 잇기는 보드 편집이 아니다. 새 요청을 지우지 않는다.
    expect((await route("edge/toggle", link)).value.linked).toBe(true);
    expect(store.find(commander)!.decisionRequest).toEqual(placed);
    const answers = [{ questionId: placed.questions[0]!.id, selectedOptionIds: [placed.questions[0]!.options[0]!.id], text: "then stop" }, { questionId: placed.questions[1]!.id, selectedOptionIds: [], text: "no" }];
    // 빈 답·빠진 질문은 받지 않는다. 전달이 실패하면 요청이 남고 결정은 쌓이지 않는다.
    expect((await route("decision/answer", { objectiveId: commander, requestId: placed.id, answers: [answers[0]] })).value.error).toBe("invalid_answers");
    hostFault.sendError = "capability_unavailable";
    expect((await route("decision/answer", { objectiveId: commander, requestId: placed.id, answers })).value.error).toBe("decision_delivery_failed");
    expect(store.find(commander)).toMatchObject({ decisionRequest: { id: placed.id }, decisionDelivery: null, decisions: [] });
    // 기준 제안이 남아도(스티어링·개시는 거절되는 상태) 답은 휴면 지휘관을 깨워 닿고, 제안은 사람의 판단으로 남는다.
    store.setCriteriaOpen(commander, true);
    await call("read", { objectiveId: commander }, commander);
    // 완료된 임무는 계획이 남긴다 — 질문이 가리키는 임무가 보드에 있는 동안 요청은 그대로다.
    await call("complete_mission", { objectiveId: commander, missionId, summary: ["committed"] }, commander);
    await call("plan", { objectiveId: commander, missions: [{ text: "later" }], criteria: [{ text: "documented" }] }, commander);
    expect(store.find(commander)).toMatchObject({ decisionRequest: { id: placed.id }, criteriaProposals: [{ text: "documented" }] });
    activity.set(commander, "dormant");
    const delivered = await route("decision/answer", { objectiveId: commander, requestId: placed.id, answers });
    expect(delivered.value).toMatchObject({ objective: { id: commander } });
    expect(sent.at(-1)).toMatchObject({ operationId: commander, text: expect.stringContaining("then stop") });
    expect(activity.get(commander)).toBe("idle");
    const answered = store.find(commander)!;
    expect(answered.decisionRequest).toBeNull();
    expect(answered.criteriaProposals).toHaveLength(1);
    expect(answered.decisions).toMatchObject([
      { requestId: placed.id, question: { text: "How far should publishing go?", options: [{ label: "Open the PR" }, { label: "Merge" }] }, answer: { text: "then stop" }, missionId, memberId: member },
      { requestId: placed.id, answer: { selectedOptionIds: [], text: "no" } },
    ]);
    // 같은 답의 재전송은 다시 보내지도 쌓지도 않는다. 다른 답은 남은 결정을 덮지 않는다.
    const sends = sent.length;
    expect((await route("decision/answer", { objectiveId: commander, requestId: placed.id, answers })).status).toBe(200);
    expect((await route("decision/answer", { objectiveId: commander, requestId: placed.id, answers: [{ ...answers[0]!, text: "merge" }, answers[1]] })).value.error).toBe("decision_already_submitted");
    expect(sent.length).toBe(sends);
    // 구성원은 사람의 답을 보드에서 읽고, 결정은 다시 읽어 들인 저장에도 그대로다.
    expect((await call("read", { objectiveId: commander }, member)).structuredContent.objective).toMatchObject({ decisions: [{ question: "How far should publishing go?", text: "then stop", missionId, memberId: member }, { text: "no" }] });
    const reloaded = createObjectiveStore({ dirOf: (theaterId) => (theaterId === "t1" ? objectivesDir : null), operations: operationsHost, emit: () => {} });
    expect(reloaded.find(commander)!.decisions).toHaveLength(2);
    // 기다리는 요청 — 그 안에 온 답은 도구 응답으로 돌아가고 결정으로 남는다. 프롬프트는 보내지 않는다.
    const waiting = createObjectiveMcpTools(ctx, store, launch, undefined, { decisionWaitMs: 60_000 }).find((tool) => tool.name === "request_decision")!;
    const ask = (revision: number) => waiting.execute({ objectiveId: commander, expectedRevision: revision, questions: [{ text: "Publish?", options: [{ label: "Yes" }, { label: "No" }] }] }, { cwd: "/", caller: { kind: "operation", operationId: commander } }) as Promise<{ structuredContent: Record<string, unknown> }>;
    const pendingAsk = ask(store.find(commander)!.decisionRequestRevision);
    await vi.waitFor(() => { expect(store.find(commander)!.decisionRequest).not.toBeNull(); });
    const live = store.find(commander)!.decisionRequest!;
    const beforeAnswer = sent.length;
    expect((await route("decision/answer", { objectiveId: commander, requestId: live.id, answers: [{ questionId: live.questions[0]!.id, selectedOptionIds: [live.questions[0]!.options[0]!.id], text: "" }] })).status).toBe(200);
    expect((await pendingAsk).structuredContent).toMatchObject({ answered: true, answers: [{ question: "Publish?", selected: ["Yes"] }] });
    expect(sent.length).toBe(beforeAnswer);
    expect(store.find(commander)).toMatchObject({ decisionRequest: null });
    expect(store.find(commander)!.decisions.at(-1)).toMatchObject({ requestId: live.id });
  });

  it("automatically observes shared PRs, shows failed lookups instead of stale success, and discards late or disposed requests", async () => {
    const { store, add, events } = harness();
    add("pr-owner"); add("also-owner");
    const url = "https://github.com/example/project/pull/7";
    const first = store.resultAdd("pr-owner", { kind: "pr", url }).result;
    store.resultAdd("also-owner", { kind: "pr", url });
    const mission = store.missionAdd("pr-owner", { text: "Ready" }).missions[0]!;
    store.missionDone("pr-owner", mission.id, ["Done"]);
    store.handOff("pr-owner", { by: "human" });
    const handoff = store.find("pr-owner")!.handoff;
    const updatedAt = first.updatedAt;
    let mode: "open" | "merged" | "closed" | "auth" | "pending" = "open";
    let finish: (() => void) | undefined;
    let aborted = false;
    const execute = vi.fn(async (_args: readonly string[], signal: AbortSignal) => {
      if (mode === "auth") throw Object.assign(new Error("failed"), { stderr: "gh auth login: secret-stderr-token" });
      if (mode === "pending") return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        finish = () => resolve({ stdout: JSON.stringify({ number: 7, html_url: url, state: "closed", merged: true, merged_at: "2026-01-01T00:00:00Z" }), stderr: "" });
        signal.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("aborted"), { code: "ABORT_ERR" })); }, { once: true });
      });
      if (mode === "open") await new Promise((resolve) => setTimeout(resolve, 250));
      return { stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ title: "Review\u0000\nresult", number: 7, html_url: "https://github.com/Example/Project/pull/7", state: mode === "open" ? "open" : "closed", merged: mode === "merged", merged_at: mode === "merged" ? "2026-01-01T00:00:00Z" : null })}`, stderr: "" };
    });
    vi.useFakeTimers();
    const service = createPrStatusService(store, { lookup: createGhPrLookup({ cwd: ".", execute }) });
    const observed = () => store.find("pr-owner")!.results.find((entry) => entry.id === first.id) as Extract<ObjectiveResult, { kind: "pr" }>;
    try {
      await vi.advanceTimersByTimeAsync(250);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(observed().observation).toMatchObject({ state: "open", stale: false, title: "Review result" });
      expect(store.find("also-owner")!.results[0]).toHaveProperty("observation.state", "open");
      mode = "auth";
      await vi.advanceTimersByTimeAsync(RESULT_LIMITS.prRefreshMs);
      expect(observed().observation).toMatchObject({ state: "error", error: { code: "auth_required" }, lastSuccess: { state: "open" } });
      expect(JSON.stringify(events)).not.toContain("secret-stderr-token");
      const count = execute.mock.calls.length;
      service.refresh(); service.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(execute).toHaveBeenCalledTimes(count);
      mode = "closed";
      await vi.advanceTimersByTimeAsync(RESULT_LIMITS.prRefreshMs);
      expect(observed().observation.state).toBe("closed");
      mode = "merged";
      await vi.advanceTimersByTimeAsync(RESULT_LIMITS.prRefreshMs);
      expect(observed().observation.state).toBe("merged");
      expect(observed().updatedAt).toBe(updatedAt);
      expect(store.find("pr-owner")!.handoff).toEqual(handoff);
      expect(store.find("pr-owner")!.awaitingReview).toBe(true);
      mode = "pending";
      await vi.advanceTimersByTimeAsync(RESULT_LIMITS.prSettledRefreshMs);
      expect(observed().observation.stale).toBe(true);
      store.resultUpdate("pr-owner", first.id, { url: "https://github.com/example/project/pull/8" });
      store.resultRemove("also-owner", store.find("also-owner")!.results[0]!.id);
      finish!();
      await vi.advanceTimersByTimeAsync(0);
      expect(observed().observation.state).toBe("unchecked");
      service.refresh("pr-owner");
      await vi.advanceTimersByTimeAsync(0);
      const beforeDispose = events.length;
      await service.dispose();
      expect(aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(RESULT_LIMITS.prSettledRefreshMs);
      expect(events).toHaveLength(beforeDispose);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await service.dispose(); vi.useRealTimers(); }
  });

  it("keeps criteria proposed until the person decides, then awaits hand-off and reaches review only through hand_off", async () => {
    const { store, call, route, launch, events, savedObjective, launches, operations } = harness();
    const objective = await launch.create({ theaterId: "t1", title: "Criteria", groupId: null, missions: [{ text: "fix" }] });
    const as = objective.id;
    const first = store.criterionAdd(as, "tests pass", "human").criteria[0]!;
    const second = store.criterionAdd(as, "copy unchanged", "human").criteria[1]!;
    const plan = (criteria: unknown) => call("plan", { objectiveId: as, missions: [{ text: "fix" }], criteria }, as);
    // 기준 제안은 사람이 구상을 명시적으로 요청한 국면에서만 열린다.
    expect((await plan([{ text: "new" }])).structuredContent.error).toBe("criteria_not_planning");
    expect((await route("plan/request", { objectiveId: as })).status).toBe(200);
    expect((await route("plan/request", { objectiveId: as })).status).toBe(200);
    expect(launches.filter((entry) => entry.dormant)).toHaveLength(1);
    expect(operations.has(as)).toBe(true);
    const before = events.length;
    expect((await plan([{ revise: 1, text: "tests and types pass" }, { text: "lint passes" }, { retire: second.id, reason: "redundant" }])).isError).toBe(false);
    expect(events.length).toBe(before + 1); // 임무와 제안을 한 번의 저장/방송으로 적용한다.
    expect(store.find(as)!.criteria).toMatchObject([{ text: "tests pass" }, { text: "copy unchanged" }]);
    expect(store.find(as)!.criteriaProposals).toHaveLength(3);
    expect(store.find(as)!.awaitingReview).toBe(false);
    expect((await route("commander/start", { objectiveId: as })).value.error).toBe("criteria_pending");
    expect((await route("commander/steer", { objectiveId: as })).value.error).toBe("criteria_pending");
    expect((await call("mark_criterion", { objectiveId: as, n: 1, met: true, evidence: "12/12" }, as)).structuredContent.error).toBe("criteria_pending");
    const [revise, added, retire] = store.find(as)!.criteriaProposals;
    expect((await route("criterion/reject", { objectiveId: as, proposalId: retire!.id })).status).toBe(200);
    expect((await route("criterion/annotate", { objectiveId: as, proposalId: revise!.id, annotation: "check both languages" })).status).toBe(200);
    expect((await route("plan/request", { objectiveId: as })).status).toBe(200);
    expect((await call("read", { objectiveId: as }, as)).structuredContent.objective).toMatchObject({ criteriaProposals: [{ annotation: "check both languages", targetN: 1 }, { kind: "add" }] });
    const replanned = events.length;
    expect((await plan([{ revise: first.id, text: "one" }, { retire: first.id, reason: "duplicate" }])).structuredContent.error).toBe("duplicate_criterion_proposal");
    expect(events.length).toBe(replanned);
    expect(store.find(as)!.criteriaProposals[0]!.annotation).toBe("check both languages");
    expect((await plan([{ revise: first.id, text: "tests pass in both languages" }, { text: "lint passes" }])).isError).toBe(false);
    expect(events.length).toBe(replanned + 1);
    expect(store.find(as)!.criteriaProposals).toHaveLength(2);
    expect(store.find(as)!.criteriaProposals.every((proposal) => !proposal.annotation && proposal.id !== added!.id)).toBe(true);
    expect(savedObjective(as).criteriaProposals).toHaveLength(2);
    const replacement = store.find(as)!.criteriaProposals[0]!;
    expect((await route("criterion/approve", { objectiveId: as, proposalId: replacement.id })).status).toBe(200);
    expect(store.find(as)!.criteria[0]).toMatchObject({ id: first.id, by: "human", text: "tests pass in both languages" });
    expect((await route("criterion/approve-all", { objectiveId: as })).status).toBe(200);
    expect(store.find(as)!.criteria[2]).toMatchObject({ by: "commander", text: "lint passes" });
    expect((await route("commander/start", { objectiveId: as })).status).toBe(200);
    expect(store.find(as)!.criteriaOpen).toBe(false);
    // 마지막 임무를 마친 뒤에도 지휘관이 근거를 적기 전에는 검토 대기가 아니다.
    const done = await call("complete_mission", { objectiveId: as, n: 1, summary: ["fixed"] }, as);
    expect(String(done.structuredContent.next)).toContain("copy unchanged");
    expect((await call("mark_criterion", { objectiveId: as, n: 1, met: true }, as)).structuredContent.error).toBe("evidence_required");
    for (const n of [1, 2, 3]) await call("mark_criterion", { objectiveId: as, n, met: true, evidence: `checked ${n}` }, as);
    // 할 일이 끝나면 인계 대기다 — 완료는 넘기기를 거쳐야 하고, 검토 대기는 회고를 실은 hand_off 뒤에만 온다.
    expect(store.find(as)!).toMatchObject({ awaitingHandoff: true, awaitingReview: false, handoff: null });
    expect((await route("objective/complete", { objectiveId: as })).value.error).toBe("not_in_review");
    const retrospective = { wentWell: [{ point: "p", because: "b" }], fellShort: [{ point: "p", ifOnly: "i" }] };
    const handOff = async (value: unknown) => (await call("hand_off", { objectiveId: as, retrospective: value }, as)).structuredContent;
    expect((await handOff({ ...retrospective, fellShort: [] })).error).toBe("retrospective_format");
    expect((await handOff(retrospective)).ok).toBe(true);
    expect(store.find(as)!).toMatchObject({ awaitingHandoff: false, awaitingReview: true, handoff: { by: "commander", retrospective } });
    expect((await handOff(retrospective)).error).toBe("not_awaiting_handoff");
    // 사람의 문구 변경과 새 작업은 앞선 충족 판단을 해당 기준/전체에서 거두고, 함께 인계 기록도 거둬 진행 중으로 돌린다.
    store.criterionPatch(as, second.id, "copy unchanged in both languages");
    expect(store.find(as)!.criteria.map((criterion) => criterion.met ?? null)).toEqual(["checked 1", null, "checked 3"]);
    expect(store.find(as)!).toMatchObject({ awaitingHandoff: false, awaitingReview: false, handoff: null });
    expect(savedObjective(as)).not.toHaveProperty("handoff");
    launch.missionAdded(as, { text: "one more" }, { by: "human" });
    expect(store.find(as)!.criteria.every((criterion) => !criterion.met)).toBe(true);
    // 구상 중 스티어링 뒤의 턴은 planning=true여도 기준 제안 권한이 닫힌다.
    await route("plan/request", { objectiveId: as });
    expect((await route("commander/steer", { objectiveId: as })).status).toBe(200);
    expect(store.find(as)!.planning).toBe(true);
    expect((await plan([{ text: "unauthorized" }])).structuredContent.error).toBe("criteria_not_planning");
    await route("plan/request", { objectiveId: as });
    await plan([{ revise: second.id, text: "new copy" }]);
    store.criterionRemove(as, second.id);
    expect(store.find(as)!.criteriaProposals).toEqual([]); // 대상 기준 삭제와 제안 삭제는 같은 보드 변경이다.
  });

  it("hands a later Commander this Theater's past roles and hand-off ratings as the person curates them, without other objectives' titles, briefs, records or models", async () => {
    const { store, call, route, launch, objectivesDir } = harness();
    const past = (await launch.create({ theaterId: "t1", title: "Secret title", groupId: null })).id;
    await launch.requestPlan(past);
    store.setPlanning(past, true);
    await call("plan", { objectiveId: past, missions: [{ text: "look", member: "Researcher" }, { text: "draft a", member: "Drafter A" }, { text: "draft b", member: "Drafter B" }], members: [{ role: "Researcher", brief: "private brief" }, { role: "Drafter A" }, { role: "Drafter B" }] }, past);
    store.setPlanning(past, false);
    const [researcher] = store.find(past)!.members;
    await route("member/patch", { objectiveId: past, memberId: researcher!.id, patch: { launch: { mode: "model", model: "secret-model" } } });
    for (const n of [1, 2, 3]) await call("complete_mission", { objectiveId: past, n, summary: ["private record"] }, past);
    await call("read", { objectiveId: past }, past);
    const retrospective = { wentWell: [{ point: "p", because: "b" }], fellShort: [{ point: "p", ifOnly: "i" }] };
    const handOff = async (ratings: unknown) => (await call("hand_off", { objectiveId: past, retrospective, ratings }, past)).structuredContent;
    expect((await handOff([{ member: "Researcher", rating: "great", note: "n" }])).error).toBe("ratings_format");
    expect((await handOff([{ member: "Researcher", rating: "well", note: "n" }, { member: researcher!.id, rating: "short", note: "n" }])).error).toBe("ratings_format");
    expect((await handOff([{ member: "Researcher", rating: "well", note: "found the cause" }, { member: "Drafter A", rating: "short", note: "missed a case", as: "Drafter" }, { member: "Drafter B", rating: "well", note: "clear options", as: "Drafter" }])).ok).toBe(true);
    expect(store.find(past)!.handoff!.ratings).toMatchObject([{ role: "Researcher", rating: "well" }, { role: "Drafter A", as: "Drafter", rating: "short" }, { role: "Drafter B", as: "Drafter" }]);
    // 다음 목표의 지휘관은 명단이 비어 있는 동안 역할 이름·숫자·평가 한 줄만 받는다.
    const next = (await launch.create({ theaterId: "t1", title: "Next", groupId: null })).id;
    const pastRolesOf = async () => ((await call("read", { objectiveId: next }, next)).structuredContent.objective as { pastRoles?: unknown }).pastRoles;
    const roles = await pastRolesOf();
    expect(roles).toEqual([
      { role: "Researcher", objectives: 1, members: 1, missions: "1/1", ratings: { well: 1, short: 0 }, notes: [{ rating: "well", note: "found the cause" }] },
      { role: "Drafter", aliases: ["Drafter A", "Drafter B"], objectives: 1, members: 2, maxParallel: 2, missions: "2/2", ratings: { well: 1, short: 1 }, notes: [{ rating: "short", note: "missed a case" }, { rating: "well", note: "clear options" }] },
    ]);
    expect(JSON.stringify(roles)).not.toMatch(/Secret title|private brief|private record|secret-model/);
    expect(((await call("read", { objectiveId: past }, past)).structuredContent.objective as { pastRoles?: unknown }).pastRoles).toBeUndefined();
    // 사람의 정리 — 숨긴 역할은 지휘관 보기에서 빠지고, 합침은 고리를 만들지 않으며, 정리는 목표가 아닌 Theater 파일에 남는다.
    expect((await route("roles/curate", { theaterId: "t1", action: { kind: "merge", role: "Drafter", into: "Researcher" } })).status).toBe(200);
    expect((await route("roles/curate", { theaterId: "t1", action: { kind: "merge", role: "Researcher", into: "Drafter" } })).value.error).toBe("role_merge_cycle");
    expect(await pastRolesOf()).toMatchObject([{ role: "Researcher", aliases: ["Drafter", "Drafter A", "Drafter B"], members: 3, ratings: { well: 2, short: 1 } }]);
    await route("roles/curate", { theaterId: "t1", action: { kind: "hide", role: "Researcher" } });
    expect(await pastRolesOf()).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(objectivesDir, "roles.json"), "utf8"))).toEqual({ hidden: ["Researcher"], merged: { Drafter: "Researcher" } });
    expect(store.list("t1").map((objective) => objective.id).sort()).toEqual([next, past].sort());
    // 같은 역할 이름의 구성원이 둘이면 역할 이름으로 가리킨 임무를 첫 번째에게 몰지 않고 거절한다.
    await launch.requestPlan(next);
    store.setPlanning(next, true);
    expect((await call("plan", { objectiveId: next, missions: [{ text: "a", member: "Drafter" }], members: [{ role: "Drafter" }, { role: "Drafter" }] }, next)).structuredContent.error).toBe("ambiguous_member");
  });

  it("admits observable follow-ups and creates records once after hand-off without launching their Operations", async () => {
    const { store, route, call, launch, launches, operations, savedObjective } = harness();
    const source = await launch.create({ theaterId: "t1", title: "Source", groupId: "g-a", missions: [{ text: "fix" }] });
    await launch.requestPlan(source.id);
    const missionId = store.find(source.id)!.missions[0]!.id;
    store.missionDone(source.id, missionId, ["fixed"]);
    // 후보는 이 목표의 임무에서 나오고, 근거 하나는 관찰할 수 있어야 하며(줄 있는 파일·명령), 활성 후보는 상한까지다.
    const body = { title: "Next", summary: "Next step", userImpact: "Users see the next step", fromMission: missionId, brief: "Next brief", criteria: ["Verified"], evidence: [{ kind: "command", text: "pnpm test" }] };
    const add = async (value: unknown) => (await call("followup", { objectiveId: source.id, add: value }, source.id)).structuredContent;
    expect((await add({ ...body, fromMission: "elsewhere" })).error).toBe("unknown_mission");
    expect((await add({ ...body, evidence: [{ kind: "file", path: "src/a.ts" }] })).error).toBe("evidence_not_observable");
    for (let n = 0; n < MAX_FOLLOWUPS; n += 1) expect((await add(body)).ok).toBe(true);
    expect((await add(body)).error).toBe("too_many_followups");
    for (const extra of store.find(source.id)!.followups.slice(1)) store.followupWithdraw(source.id, extra.id);
    const candidate = store.find(source.id)!.followups[0]!;
    const batchId = "3f1c8f3e-1111-4a8b-9c0d-000000000001";
    const pick = () => route("objective/complete", { objectiveId: source.id, batchId, followups: [{ id: candidate.id, rev: candidate.rev }] });
    // 후보 선택은 검토 대기에서만 — 지휘관이 넘기지 않았으면 사람이 회고 없이 넘긴다.
    expect((await pick()).value.error).toBe("not_in_review");
    expect((await route("objective/hand-off", { objectiveId: source.id })).status).toBe(200);
    expect(store.find(source.id)!.handoff).toMatchObject({ by: "human", retrospective: null });
    // 생성이 한 번 실패하면 배치 항목은 failed 로 남고, 재시도는 같은 키로 한 번만 만든다.
    const interrupted = vi.spyOn(launch, "create").mockImplementationOnce(() => Promise.reject(new Error("record_failed")));
    expect((await pick()).status).toBe(200);
    expect((await pick()).status).toBe(200);
    await vi.waitFor(() => expect(store.find(source.id)!.followupBatches[0]!.items[0]!).toMatchObject({ state: "failed", error: "record_failed" }));
    interrupted.mockRestore();
    expect((await route("followup/retry", { objectiveId: source.id, batchId, candidateId: candidate.id })).status).toBe(200);
    await vi.waitFor(() => expect(store.find(source.id)!.followupBatches[0]!.items[0]!.state).toBe("created"));
    const targetId = store.list("t1").find((entry) => entry.origin?.candidateId === candidate.id)!.id;
    expect(store.find(source.id)!.followupBatches[0]!.items[0]!.operationId).toBe(targetId);
    expect(store.find(targetId)).toMatchObject({ title: "Next", note: "Next brief", commander: { started: false }, origin: { objectiveId: source.id, candidateId: candidate.id, userImpact: "Users see the next step" } });
    expect(savedObjective(targetId)).toHaveProperty("pending.title", "Next");
    expect(operations.has(targetId)).toBe(false);
    expect(launches).toHaveLength(1);
    launch.resumeFollowups(source.id);
    expect(store.list("t1").filter((entry) => entry.id === targetId)).toHaveLength(1);
    launch.remove(targetId);
    expect(store.find(source.id)!.followupBatches[0]!.items[0]!.state).toBe("deleted");
  });

  it("registers even when a registered Theater folder is gone", () => {
    // 등록된 Theater 폴더는 사라질 수 있다(옮김·외장 디스크). 등록이 그 Theater 를 읽다 던지면 Console 전체가 뜨지 않는다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-objectives-register-"));
    dirs.push(dir);
    const workspaceOf = (theaterId: string) => path.join(dir, "workspaces", theaterId);
    fs.mkdirSync(path.join(workspaceOf("present"), "objectives", "cmdr"), { recursive: true });
    fs.writeFileSync(path.join(workspaceOf("present"), "objectives", "cmdr", "objective.json"), JSON.stringify({ operationId: "cmdr", rank: 0, note: "", missions: [], members: [{ id: "m1", role: "보조", by: "human", operationId: "member" }] }));
    const node = (id: string, theaterId: string): Node => ({ id, theaterId, type: "agent", pluginId: null, title: id, payload: {}, geometry: null, ts: { createdAt: 1, updatedAt: 1 } });
    const operations = new Map<string, Node>([["cmdr", node("cmdr", "present")], ["member", node("member", "present")], ["lost", node("lost", "gone")]]);
    const noop = () => () => undefined;
    const ctx = {
      pluginId: "objectives",
      registerRouter: () => undefined,
      host: {
        operations: {
          get: (id: string) => operations.get(id) ?? null,
          list: () => [...operations.values()],
          patch: (id: string, input: { parentOperationId?: string | null }) => {
            const target = operations.get(id);
            if (!target) return null;
            if (input.parentOperationId) target.parentOperationId = input.parentOperationId;
            return target;
          },
        },
        paths: {
          resolveTheaterPath: (theaterId: string) => path.join(dir, "theaters", theaterId),
          // 호스트처럼 폴더의 실경로를 풀지 못하면 던진다.
          ensureWorkspaceDirectory: (theaterPath: string) => {
            const theaterId = path.basename(theaterPath);
            if (theaterId === "gone") throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${theaterPath}'`), { code: "ENOENT" });
            return { path: workspaceOf(theaterId), id: theaterId };
          },
        },
        events: { registerSseChannel: noop, subscribe: noop, publish: () => undefined },
        lifecycle: { registerCleanup: () => undefined },
        consoleUse: { contribute: noop },
        admiralMcp: { register: noop },
      },
    } as unknown as FleetPluginServerContext;
    expect(() => objectivesPlugin.register!(ctx)).not.toThrow();
  });
});

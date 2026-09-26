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
};

function harness(routingOrigin: () => string | null = () => null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-objectives-"));
  dirs.push(dir);
  const theaterPath = path.join(dir, "project");
  const workspace = path.join(dir, "data", "workspaces", "project");
  const events: ObjectiveEvent[] = [];
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
  const hostFault = { afterCreate: 0 };
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
    // 호스트처럼 지운 Operation 의 기동 키는 삭제로 읽힌다(유예·purge).
    delete: (id: string) => { deleted.push(id); for (const [key, target] of keyed) if (target === id) deletedKeys.add(key); return operations.delete(id); },
    groups: { list: () => [], get: (id: string) => (id.startsWith("g-") ? { id, theaterId: "t1" } : null), create: () => { throw new Error("unused"); }, patch: () => null, delete: () => false },
  };
  const store = createObjectiveStore({ dirOf: (theaterId) => (theaterId === "t1" ? path.join(workspace, "objectives") : null), operations: operationsHost, emit: (event) => events.push(event), now: () => clock++ });
  let routeBody: unknown;
  let routeResult: { status: number; value: unknown } = { status: 0, value: null };
  const ctx = {
    pluginId: "objectives",
    host: {
      security: { isTerminalAuthorized: () => true },
      http: { readJsonBody: async () => routeBody, writeJson: (_res: unknown, status: number, value: unknown) => { routeResult = { status, value }; } },
      server: { origin: routingOrigin },
      operations: operationsHost,
      consoleControl: {
        launchState: ({ key }: { theaterId: string; key: string }) => deletedKeys.has(key) ? { state: "purged" } : keyed.has(key) && operations.has(keyed.get(key)!) ? { state: "live", operationId: keyed.get(key) } : reservedKeys.has(key) ? { state: "reserved" } : { state: "absent" },
        reserveLaunchKeys: ({ keys }: { theaterId: string; keys: readonly string[] }) => { for (const key of keys) reservedKeys.add(key); },
        request: async (input: { kind: string; operationId?: string; text?: string; title?: string; sessionName?: string; viewMode?: string; dormant?: boolean; disableSubagents?: boolean; disableUserQuestions?: boolean; model?: string; effort?: string; groupId?: string; launchKey?: string; newOperationId?: string }) => {
          if (input.kind === "send") { sent.push({ operationId: input.operationId!, text: input.text! }); if (activity.get(input.operationId!) === "dormant") activity.set(input.operationId!, "idle"); return { operationId: input.operationId }; }
          // 호스트처럼 터미널은 실행 중일 때만 interrupt 를 받는다.
          if (input.kind === "interrupt") { if (activity.get(input.operationId!) !== "running") throw new Error("capability_unavailable"); interrupted.push(input.operationId!); activity.set(input.operationId!, "idle"); return { operationId: input.operationId }; }
          // resume 은 휴면만 세션째 되살린다.
          if (input.kind === "resume") { if (activity.get(input.operationId!) !== "dormant") throw new Error("not_dormant"); resumed.push(input.operationId!); activity.set(input.operationId!, "idle"); return { operationId: input.operationId }; }
          if (input.launchKey && deletedKeys.has(input.launchKey)) throw new Error("launch_key_deleted");
          if (input.launchKey && keyed.has(input.launchKey)) return { operationId: keyed.get(input.launchKey) };
          await new Promise((resolve) => setTimeout(resolve, 5));
          const id = input.newOperationId ?? `launched-${launches.length + 1}`;
          if (input.launchKey) keyed.set(input.launchKey, id);
          launches.push({ title: input.title, sessionName: input.sessionName, viewMode: input.viewMode, text: input.text, dormant: input.dormant, disableSubagents: input.disableSubagents, disableUserQuestions: input.disableUserQuestions, groupId: input.groupId });
          // 호스트 관측 — 첫 메시지 없이 띄운 세션은 유휴(대기), dormant 로 만든 것은 휴면.
          activity.set(id, input.dormant ? "dormant" : "idle");
          add(id, { title: input.title ?? id, groupId: input.groupId ?? null, payload: { ...(input.viewMode === "chat" ? { chatMode: true } : {}), ...(input.launchKey ? { launchKey: { owner: "objectives", key: input.launchKey } } : {}), session: { harness: "claude-code", ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}), ...(input.sessionName ? { sessionName: input.sessionName } : {}) } } });
          if (input.launchKey && hostFault.afterCreate > 0) { hostFault.afterCreate -= 1; throw new Error("request_timeout"); }
          return { operationId: id };
        },
        observe: (id: string) => {
          const state = activity.get(id);
          return state ? { lifecycle: state === "dormant" ? "dormant" : "live", activity: state === "dormant" ? "idle" : state, surface: surfaces.get(id) ?? (operations.get(id)?.payload.chatMode === true ? "chat" : "terminal"), supportedActions: ["send", ...(state === "running" ? ["interrupt"] : [])] } : null;
        },
        setSubagentSpawn: (operationId: string, policy: "blocked" | "default") => { subagentSpawns.push({ operationId, policy }); },
        setUserQuestions: (operationId: string, policy: "blocked" | "default") => { userQuestions.push({ operationId, policy }); },
        sleep: async (id: string, options?: { endPendingWork?: boolean }) => {
          const state = activity.get(id);
          if (state !== "idle" && !(options?.endPendingWork && (state === "awaiting" || state === "background"))) return { ok: false, error: "not_idle" };
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
  const consoleTool = createObjectiveConsoleTools(ctx, store, launch)[0]!;
  const route = async (name: string, body: Record<string, unknown>): Promise<{ status: number; value: Record<string, unknown> }> => {
    routeBody = body;
    routeResult = { status: 0, value: null };
    const handler = createObjectiveRoutes(ctx, store, launch).find((entry) => entry.name === name)!.handler;
    await handler({ req: { method: "POST" } as never, res: {} as never, pathname: name });
    return routeResult as { status: number; value: Record<string, unknown> };
  };
  // 저장은 목표마다 디렉터리 하나 — `<objectives>/<목표>/objective.json`.
  const objectivesDir = path.join(workspace, "objectives");
  const objectiveFile = (objectiveId: string) => path.join(objectivesDir, objectiveId, "objective.json");
  const savedObjective = (objectiveId: string) => JSON.parse(fs.readFileSync(objectiveFile(objectiveId), "utf8")) as Saved;
  const savedIds = () => (fs.existsSync(objectivesDir) ? fs.readdirSync(objectivesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : []);
  return { store, events, launch, call, consoleTool, route, operations, add, sent, launches, deleted, objectivesDir, objectiveFile, savedObjective, savedIds, workspace, activity, slept, interrupted, resumed, subagentSpawns, userQuestions, surfaces, keyed, deletedKeys, reservedKeys, hostFault };
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000030806000000", "hex");

describe("Objectives contract", () => {
  it("lets a person opt one member into subagents without blocking the others or the live process", async () => {
    let routingOrigin: string | null = null;
    const { store, launch, call, launches, resumed, activity, interrupted, subagentSpawns, userQuestions, savedObjective, operations, surfaces } = harness(() => routingOrigin);
    const objective = await launch.create({ theaterId: "t1", title: "Opt in", groupId: null, note: "brief" });
    const allowed = store.memberAdd(objective.id, { role: "build", subagents: true }, "human").members[0]!;
    const blocked = store.memberAdd(objective.id, { role: "research" }, "human").members[1]!;
    expect(store.find(objective.id)!.members.map((member) => member.subagents)).toEqual([true, false]);
    await launch.requestPlan(objective.id);
    store.setPlanning(objective.id, false);
    await launch.muster(objective.id);
    expect(launches.slice(1).map((entry) => entry.disableSubagents)).toEqual([undefined, true]);
    // 구성원만 사람에게 묻지 않는다 — 지휘관은 질문을 그대로 가진다.
    expect(launches.map((entry) => entry.disableUserQuestions)).toEqual([undefined, true, true]);
    // 새 구성원의 뷰는 지휘관을 따른다 — 미기동 지휘관의 저장된 시작 뷰(터미널)에서.
    expect(launches.slice(1).map((entry) => entry.viewMode)).toEqual(["terminal", "terminal"]);
    const roster = store.find(objective.id)!;
    const blockedOperationId = roster.members.find((member) => member.id === blocked.id)!.operationId!;
    activity.set(blockedOperationId, "dormant");
    launch.memberPatched(objective.id, blocked.id, { subagents: true });
    expect(store.find(objective.id)!.members.find((member) => member.id === blocked.id)!.subagents).toBe(true);
    const allowedOperationId = roster.members.find((member) => member.id === allowed.id)!.operationId!;
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
    launch.memberPatched(objective.id, allowed.id, { subagents: false });
    expect(store.find(objective.id)!.members.find((member) => member.id === allowed.id)!.subagents).toBe(false);
    expect(subagentSpawns.at(-1)).toEqual({ operationId: roster.members.find((member) => member.id === allowed.id)!.operationId, policy: "blocked" });
    const stored = savedObjective(objective.id).members!;
    expect(stored.find((member) => member.role === "research")!.subagents).toBe(true);
    expect(stored.find((member) => member.role === "build")).not.toHaveProperty("subagents");
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
    // 휴면 지휘관이 채팅으로 저장돼 있으면 새 구성원도 채팅으로 태어난다.
    operations.get(objective.id)!.payload = { ...operations.get(objective.id)!.payload, chatMode: true };
    const pendingMuster = launch.muster(objective.id);
    await routingStarted;
    launch.memberPatched(objective.id, routed.id, { subagents: false });
    finishRouting(Response.json({ model: "sonnet" }));
    await pendingMuster;
    expect(launches.at(-1)?.disableSubagents).toBe(true);
    expect(launches.at(-1)?.viewMode).toBe("chat");

    // 명단에서 뺀 구성원은 복원되면 일반 Operation 이다 — 질문 정책을 되돌린 뒤 닫는다.
    launch.memberRemoved(objective.id, routed.id);
    const removedId = launches.length > 0 ? `launched-${launches.length}` : "";
    expect(userQuestions.at(-1)).toEqual({ operationId: removedId, policy: "default" });
    expect(operations.has(removedId)).toBe(false);

    // 살아 있는 지휘관은 저장값보다 지금 보이는 표면이 이긴다 — 채팅으로 저장됐어도 터미널로 떠 있으면 터미널로 태어난다.
    vi.unstubAllGlobals();
    routingOrigin = null;
    activity.set(objective.id, "idle");
    surfaces.set(objective.id, "terminal");
    const late = store.memberAdd(objective.id, { role: "late" }, "human").members.at(-1)!;
    await launch.muster(objective.id);
    expect(launches.at(-1)?.viewMode).toBe("terminal");
    launch.memberRemoved(objective.id, late.id);

    // 지휘관만 지워지고(삭제 사건을 놓침) 복원 불가로 확정되면 구성원은 제 목표의 지휘관으로 보인다 — 질문 차단이 남으면 안 된다.
    // 되돌리는 것은 이 목표가 기록한 구성원 중 남아 있는 Operation 뿐이다: 이미 없는 것·무관한 Operation 에는 쓰지 않는다.
    operations.delete(allowedOperationId);
    operations.delete(objective.id);
    userQuestions.length = 0;
    launch.operationPurged("unrelated-operation");
    expect(userQuestions).toEqual([]);
    launch.operationPurged(objective.id);
    expect(userQuestions).toEqual([{ operationId: blockedOperationId, policy: "default" }]);
    expect(operations.has(blockedOperationId)).toBe(true);
    expect(store.find(blockedOperationId)).toMatchObject({ id: blockedOperationId });
  });

  it("creates a pending objective and launches its Commander once on demand", async () => {
    const { store, events, launch, operations, sent, launches, objectiveFile, savedObjective, savedIds, objectivesDir, workspace, activity, slept, interrupted, resumed, hostFault } = harness();
    const objective = await launch.create({ theaterId: "t1", title: "Release", groupId: "g-ship", note: "brief", missions: [{ text: "a" }, { text: "b", prerequisites: [1] }, { text: "c", prerequisites: [2] }] });
    expect(launches).toEqual([]);
    expect(operations.has(objective.id)).toBe(false);
    expect(store.list("t1")).toContainEqual(expect.objectContaining({ id: objective.id, title: "Release", groupId: "g-ship" }));
    expect(savedObjective(objective.id).operationId).toBe(objective.id);
    expect(savedObjective(objective.id)).toHaveProperty("pending.title", "Release");
    const head = objective.commander.sessionName!.replace(/-cmdr$/, "");
    const [a, b, c] = objective.missions;
    expect(() => store.missionPatch(objective.id, a!.id, { prerequisites: [c!.id] })).toThrow(ObjectiveStoreError);
    expect(launch.setPreset(objective.id, { viewMode: "chat" }).commander.viewMode).toBe("chat");
    expect(launch.setPreset(objective.id, { viewMode: "terminal" }).commander.viewMode).toBe("terminal");
    launch.rename(objective.id, "Release renamed");
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
    expect(() => launch.setPreset(objective.id, { viewMode: "chat" })).toThrow("objective_busy");
    expect(store.find(objective.id)!.commander.viewMode).toBe("terminal");
    // 위임할 때마다 새 Operation 을 만들지 않는다 — 같은 구성원의 임무는 같은 Operation 이다.
    expect(store.find(objective.id)!.missions.map((mission) => mission.operationId)).toEqual(["launched-2", "launched-3", "launched-3"]);
    // 임무 진행(blocked/done)은 그대로 두되, 실제 구성원 입력 대기를 별도 신호로 cluster 서술자에 전달한다.
    const clusterMember = (id: string) => clustersOf([store.find(objective.id)!], new Map([...activity].map(([key, value]) => [key, value])))[0]!.members.find((member) => member.operationId === id)!;
    activity.set("launched-3", "awaiting");
    expect(clusterMember("launched-3")).toMatchObject({ progress: "blocked", awaitingInput: true });
    activity.set("launched-3", "idle");
    expect(clusterMember("launched-3")).toMatchObject({ progress: "blocked", awaitingInput: false });
    // 다시 세워도 살아 있는 구성원은 그대로, 휴면한 구성원은 새로 띄우지 않고 세션째 재개한다.
    activity.set("launched-2", "dormant");
    expect((await launch.muster(objective.id)).map((member) => member.state)).toEqual(["resumed", "live"]);
    expect([launches.length, resumed]).toEqual([3, ["launched-2"]]);
    // 다시 작업해 다시 완료하면 기록이 쌓인다(종류는 위치로).
    store.missionDone(objective.id, a!.id, ["a done"]);
    store.missionDone(objective.id, a!.id, ["a redone", "fixed the gap"]);
    activity.set("launched-2", "awaiting");
    expect(clusterMember("launched-2")).toMatchObject({ progress: "done", awaitingInput: true });
    activity.set("launched-2", "idle");
    // 완료는 지휘관과 구성원을 휴면시키되 연결을 풀지 않는다. 답을 기다리는 터미널 지휘관과 백그라운드 작업이 남은 구성원은 그대로 재우고, 실행 중인 구성원은 중단한 뒤 재운다.
    activity.set(objective.id, "awaiting");
    activity.set("launched-2", "running");
    activity.set("launched-3", "background");
    expect(launch.complete(objective.id).done).toBeTruthy();
    await expect.poll(() => slept.length).toBe(3);
    expect(interrupted).toEqual(["launched-2"]);
    expect(slept.sort()).toEqual([objective.id, "launched-2", "launched-3"].sort());
    expect(store.reopen(objective.id).missions.map((mission) => mission.member)).toEqual([research, build, build]);
    // 계획은 완료·기록·사람이 담당을 정한 임무를 보존하고 나머지를 바꾼다; 새 임무는 편성 순으로 선다.
    const planned = store.plan(objective.id, { missions: [{ text: "x", prerequisites: [{ n: 2, why: "shares files" }] }, { text: "y", prerequisites: [{ missionId: a!.id, why: "builds on a" }] }] });
    expect(planned.missions.map((mission) => mission.text)).toEqual(["a", "b", "y", "x"]);
    expect(planned.missions[3]!.why[planned.missions[2]!.id]).toBe("shares files");
    // 저장 — 목표마다 자기 디렉터리의 objective.json 하나, Operation 이 가진 값은 싣지 않는다.
    expect(savedIds()).toEqual([objective.id]);
    const saved = savedObjective(objective.id);
    expect(Object.keys(saved).sort()).toEqual(["members", "missions", "note", "operationId", "rank"]);
    expect(saved.operationId).toBe(objective.id);
    for (const key of ["title", "theaterId", "groupId", "slot", "createdAt", "updatedAt", "history", "author", "review"]) expect(JSON.stringify(saved)).not.toContain(`"${key}"`);
    // 재시작 뒤에도 파일에서 같은 상태를 읽는다 — 제목·그룹은 Operation 에서 온다.
    const reloaded = createObjectiveStore({ dirOf: () => path.join(workspace, "objectives"), operations: { get: (id) => operations.get(id) ?? null, list: () => [...operations.values()] }, emit: () => undefined });
    expect(reloaded.find(objective.id)).toMatchObject({ title: "Release renamed", groupId: "g-ship", criteriaOpen: false, criteriaProposals: [] });
    expect(reloaded.find(objective.id)!.missions[0]!.records.map((record) => [record.kind, record.lines])).toEqual([["done", ["a done"]], ["redone", ["a redone", "fixed the gap"]]]);
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
    expect(operations.has("launched-2") || operations.has("launched-3")).toBe(false);
    // 유예 동안은 디렉터리째 남아 있다(복원하면 목표도 돌아온다).
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(objectiveFile(objective.id))).toBe(true);
    // 확정 삭제는 그 목표의 디렉터리 전체를 거둔다.
    launch.operationPurged(objective.id);
    expect(fs.existsSync(path.join(objectivesDir, objective.id))).toBe(false);
    expect(savedIds()).toEqual([]);
  });

  it("writes one objective's file per change and turns no link, failed write, failed read or failed delete into success", () => {
    const { store, events, add, operations, objectivesDir, objectiveFile, savedIds, workspace } = harness();
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

    // 깨진 파일 하나는 그 목표만 빈 목표로 돌리고 격리 사본을 남긴다.
    fs.writeFileSync(objectiveFile("alpha"), "{ not json");
    const recovered = reload();
    expect(recovered.find("alpha")).toMatchObject({ note: "", missions: [] });
    expect(fs.readdirSync(path.join(objectivesDir, "alpha")).some((name) => name.startsWith("objective.json.broken-"))).toBe(true);
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
    const id = (created.structuredContent.objective as { id: string }).id;
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

  it("shows every agent Operation created elsewhere as an objective, but not member or plugin Operations", async () => {
    const { store, launch, add, savedIds, launches, call } = harness();
    add("sidebar", { title: "Made in the sidebar", groupId: "g-a" });
    add("wiki", { pluginId: "codex", type: "codex-wiki" });
    const made = await launch.create({ theaterId: "t1", title: "Made in Objectives", groupId: null, missions: [{ text: "one" }] });
    store.memberAdd(made.id, { role: "build" }, "human");
    await launch.requestPlan(made.id);
    store.setPlanning(made.id, false);
    await launch.muster(made.id);
    // 레코드 없는 Operation 은 빈 목표로 선다 — 구성원(launched-2)과 플러그인 Operation 은 목표가 아니다.
    expect(store.list("t1").map((objective) => objective.id).sort()).toEqual([made.id, "sidebar"].sort());
    expect(store.find("sidebar")).toMatchObject({ title: "Made in the sidebar", groupId: "g-a", note: "", missions: [], awaitingReview: false });
    expect(store.find("launched-2")).toBeNull();
    // 첫 편집이 레코드를 만든다.
    expect(savedIds()).not.toContain("sidebar");
    store.patch("sidebar", { note: "now it has a brief" });
    expect(savedIds()).toContain("sidebar");
    // 따로 만든 지휘관에게는 고정 이름이 없다 — 구성원은 그래도 사람에게 묻지 않고, 주소를 지어내지 않고 null 로 받는다.
    const helper = store.memberAdd("sidebar", { role: "helper" }, "human").members.at(-1)!;
    await launch.muster("sidebar");
    expect(launches.at(-1)?.disableUserQuestions).toBe(true);
    const helperOperation = store.find("sidebar")!.members.find((member) => member.id === helper.id)!.operationId!;
    expect((await call("mine", {}, helperOperation)).structuredContent).toMatchObject({ role: "member", commander: { session: null } });
  });

  it("keeps an objective in its Commander Operation's group and moves the members with it", async () => {
    const { store, launch, operations } = harness();
    const objective = await launch.create({ theaterId: "t1", title: "Ship", groupId: "g-review", missions: [{ text: "a" }] });
    store.memberAdd(objective.id, { role: "build" }, "human");
    await launch.requestPlan(objective.id);
    store.setPlanning(objective.id, false);
    const worker = (await launch.muster(objective.id))[0]!.operationId;
    expect(operations.get(worker)!.groupId).toBe("g-review");
    // 목표에서 옮기면 지휘관 Operation 이 옮겨지고, 구성원이 따라간다 — 목표의 그룹은 저장하지 않는다.
    launch.regroup(objective.id, "g-done");
    expect([operations.get(objective.id)!.groupId, operations.get(worker)!.groupId, store.find(objective.id)!.groupId]).toEqual(["g-done", "g-done", "g-done"]);
    // 사이드바에서 구성원만 옮긴 것은 목표를 움직이지 않는다; 없는 그룹으로는 옮기지 않는다.
    operations.get(worker)!.groupId = "g-other";
    expect(store.find(objective.id)!.groupId).toBe("g-done");
    expect(() => launch.regroup(objective.id, "nope")).toThrow(ObjectiveStoreError);
  });

  it("lets only the objective's own Commander write, gives members read-only access and outsiders none, and keeps planning and the person's missions and assignments intact", async () => {
    const { store, call, launch } = harness();
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
    const member = (mustered.structuredContent.members as { operationId: string; state: string }[])[0]!;
    expect(member.state).toBe("launched");
    // 구성원은 제 역할과 맡은 임무를 읽지만 쓰지 못한다.
    // 구성원은 보고·판단 요청을 보낼 지휘관의 세션 주소를 함께 받는다.
    expect((await call("mine", {}, member.operationId)).structuredContent).toMatchObject({ role: "member", access: "read-only", objectiveId: objective.id, commander: { session: store.find(objective.id)!.commander.sessionName }, member: { role: "build", brief: "implements" }, missions: [{ n: 1, text: "p1" }] });
    expect(store.find(objective.id)!.commander.sessionName).toMatch(/-cmdr$/);
    expect((await call("read", { objectiveId: objective.id }, member.operationId)).isError).toBe(false);
    expect((await call("mine", {}, commander)).structuredContent).toMatchObject({ role: "commander", objectiveId: objective.id });
    // 사람이 선행 없이 더한 임무는 미분류 — 지휘관이 자리를 정하기 전까지 준비되지 않는다.
    launch.missionAdded(objective.id, { text: "missed" }, { by: "human" });
    const board = async () => ((await call("read", { objectiveId: objective.id }, commander)).structuredContent.objective as { graph: { missions: { n: number; unplaced?: boolean; ready: boolean; prerequisites: number[]; member: { role: string } | null }[] } }).graph.missions;
    // 지휘관이 읽기 전에 사람이 바꾼 보드로는 계획을 쓸 수 없다.
    store.setEdited(objective.id, ["missions"]);
    expect((await call("plan", { objectiveId: objective.id, missions: [{ text: "stale" }] }, commander)).structuredContent.error).toBe("board_changed");
    const missed = (await board()).find((mission) => mission.unplaced)!;
    expect(missed).toMatchObject({ unplaced: true, ready: false });
    // 계획이 남기는 임무를 같은 문구로 다시 만들어 두 벌을 세우지 못한다.
    expect((await call("plan", { objectiveId: objective.id, missions: [{ text: " Missed " }] }, commander)).structuredContent).toMatchObject({ error: "mission_kept", kept: [{ text: "missed", unplaced: true }] });
    // 배치는 지휘관만 — 담당 구성원도 함께 정한다.
    expect((await call("place_mission", { objectiveId: objective.id, n: missed.n, prerequisites: [1] }, member.operationId)).structuredContent.error).toBe("not_commander");
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
    expect((await call("complete_mission", { objectiveId: objective.id, n: 1, summary: ["r"] }, member.operationId)).structuredContent.error).toBe("not_commander");
    expect((await call("complete_mission", { objectiveId: objective.id, n: 1, summary: ["x".repeat(400)] }, commander)).structuredContent.error).toBe("summary_format");
    expect((await call("complete_mission", { objectiveId: objective.id, n: 1, summary: ["shipped p1", "tests pass"] }, commander)).isError).toBe(false);
    // 같은 목표에 시작이 겹치면 하나만 간다.
    const results = await Promise.allSettled([launch.startCommander(other), launch.startCommander(other)]);
    expect(results.filter((result) => result.status === "fulfilled").length).toBe(2);
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
    expect((await pick()).status).toBe(200);
    expect((await pick()).status).toBe(200);
    await vi.waitFor(() => expect(store.find(source.id)!.followupBatches[0]!.items[0]!.state).toBe("created"));
    const targetId = store.find(source.id)!.followupBatches[0]!.items[0]!.operationId!;
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

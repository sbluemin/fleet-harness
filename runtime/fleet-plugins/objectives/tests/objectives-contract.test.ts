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
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

type Node = { -readonly [K in keyof OperationNode]: OperationNode[K] };

function harness(routingOrigin: () => string | null = () => null) {
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
  const launches: { title?: string; sessionName?: string; viewMode?: string; text?: string; dormant?: boolean; disableSubagents?: boolean; disableUserQuestions?: boolean; groupId?: string }[] = [];
  const resumed: string[] = [];
  const subagentSpawns: { operationId: string; policy: "blocked" | "default" }[] = [];
  const userQuestions: { operationId: string; policy: "blocked" | "default" }[] = [];
  // 호스트처럼 표면은 채팅 표식이 말하고, 살아 있는 세션은 지금 보이는 표면으로 덮을 수 있다.
  const surfaces = new Map<string, "chat" | "terminal">();
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
        request: async (input: { kind: string; operationId?: string; text?: string; title?: string; sessionName?: string; viewMode?: string; dormant?: boolean; disableSubagents?: boolean; disableUserQuestions?: boolean; model?: string; effort?: string; groupId?: string }) => {
          const receipt = { id: "r", requestId: "r", caller: { kind: "plugin", pluginId: "objectives" }, input, status: "running", createdAt: "", updatedAt: "", expiresAt: "" };
          if (input.kind === "send") { sent.push({ operationId: input.operationId!, text: input.text! }); if (activity.get(input.operationId!) === "dormant") activity.set(input.operationId!, "idle"); return { ...receipt, operationId: input.operationId }; }
          // 호스트처럼 터미널은 실행 중일 때만 interrupt 를 받는다.
          if (input.kind === "interrupt") { if (activity.get(input.operationId!) !== "running") throw new Error("capability_unavailable"); interrupted.push(input.operationId!); activity.set(input.operationId!, "idle"); return { ...receipt, operationId: input.operationId }; }
          // resume 은 휴면만 세션째 되살린다.
          if (input.kind === "resume") { if (activity.get(input.operationId!) !== "dormant") throw new Error("not_dormant"); resumed.push(input.operationId!); activity.set(input.operationId!, "idle"); return { ...receipt, operationId: input.operationId }; }
          await new Promise((resolve) => setTimeout(resolve, 5));
          const id = `launched-${launches.length + 1}`;
          launches.push({ title: input.title, sessionName: input.sessionName, viewMode: input.viewMode, text: input.text, dormant: input.dormant, disableSubagents: input.disableSubagents, disableUserQuestions: input.disableUserQuestions, groupId: input.groupId });
          // 호스트 관측 — 첫 메시지 없이 띄운 세션은 유휴(대기), dormant 로 만든 것은 휴면.
          activity.set(id, input.dormant ? "dormant" : "idle");
          add(id, { title: input.title ?? id, groupId: input.groupId ?? null, payload: { session: { harness: "claude-code", ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}), ...(input.sessionName ? { sessionName: input.sessionName } : {}) } } });
          return { ...receipt, operationId: id };
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
  const stateFile = path.join(workspace, "objectives", "state.json");
  return { store, events, launch, call, consoleTool, route, operations, add, sent, launches, deleted, stateFile, workspace, activity, slept, interrupted, resumed, subagentSpawns, userQuestions, surfaces };
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000030806000000", "hex");

describe("Objectives contract", () => {
  it("lets a person opt one member into subagents without blocking the others or the live process", async () => {
    let routingOrigin: string | null = null;
    const { store, launch, call, launches, resumed, activity, interrupted, subagentSpawns, userQuestions, stateFile, operations, surfaces } = harness(() => routingOrigin);
    const item = await launch.create({ theaterId: "t1", title: "Opt in", groupId: null, note: "brief" });
    const allowed = store.memberAdd(item.id, { role: "build", subagents: true }, "human").members[0]!;
    const blocked = store.memberAdd(item.id, { role: "research" }, "human").members[1]!;
    expect(store.find(item.id)!.members.map((member) => member.subagents)).toEqual([true, false]);
    await launch.muster(item.id);
    expect(launches.slice(1).map((entry) => entry.disableSubagents)).toEqual([undefined, true]);
    // 구성원만 사람에게 묻지 않는다 — 지휘관은 질문을 그대로 가진다.
    expect(launches.map((entry) => entry.disableUserQuestions)).toEqual([undefined, true, true]);
    // 새 구성원의 뷰는 지휘관을 따른다 — 미기동 지휘관의 저장된 시작 뷰(터미널)에서.
    expect(launches.slice(1).map((entry) => entry.viewMode)).toEqual(["terminal", "terminal"]);
    const roster = store.find(item.id)!;
    const blockedOperationId = roster.members.find((member) => member.id === blocked.id)!.operationId!;
    activity.set(blockedOperationId, "dormant");
    launch.memberPatched(item.id, blocked.id, { subagents: true });
    expect(store.find(item.id)!.members.find((member) => member.id === blocked.id)!.subagents).toBe(true);
    const allowedOperationId = roster.members.find((member) => member.id === allowed.id)!.operationId!;
    expect(subagentSpawns).toEqual([
      { operationId: allowedOperationId, policy: "default" },
      { operationId: blockedOperationId, policy: "blocked" },
      { operationId: blockedOperationId, policy: "default" },
    ]);
    expect(interrupted).toEqual([]);
    subagentSpawns.length = 0;
    expect((await launch.muster(item.id)).find((member) => member.id === blocked.id)!.state).toBe("resumed");
    expect(subagentSpawns).toEqual([{ operationId: blockedOperationId, policy: "default" }]);
    expect(resumed).toEqual([blockedOperationId]);
    // 재개 전에 질문 차단을 다시 채운다 — 이 정책 전에 뜬 구성원도 재개로 풀려나지 않는다.
    expect(userQuestions).toContainEqual({ operationId: blockedOperationId, policy: "blocked" });
    launch.memberPatched(item.id, allowed.id, { subagents: false });
    expect(store.find(item.id)!.members.find((member) => member.id === allowed.id)!.subagents).toBe(false);
    expect(subagentSpawns.at(-1)).toEqual({ operationId: roster.members.find((member) => member.id === allowed.id)!.operationId, policy: "blocked" });
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { objectives: { members: { role: string; subagents?: boolean }[] }[] };
    const stored = saved.objectives[0]!.members;
    expect(stored.find((member) => member.role === "research")!.subagents).toBe(true);
    expect(stored.find((member) => member.role === "build")).not.toHaveProperty("subagents");
    const refused = await call("plan", { itemId: item.id, steps: [{ text: "next" }], members: [{ role: "extra", subagents: true }] }, item.id);
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.error).toBe("invalid_arguments");

    // 라우팅 응답을 기다리는 동안 해제한 허용은 아직 뜨지 않은 구성원의 첫 기동부터 반영한다.
    const routed = store.memberAdd(item.id, { role: "review", subagents: true }, "human").members.at(-1)!;
    let finishRouting!: (response: Response) => void;
    const routingResponse = new Promise<Response>((resolve) => { finishRouting = resolve; });
    let enteredRouting!: () => void;
    const routingStarted = new Promise<void>((resolve) => { enteredRouting = resolve; });
    vi.stubGlobal("fetch", () => { enteredRouting(); return routingResponse; });
    routingOrigin = "http://routing.invalid";
    // 휴면 지휘관이 채팅으로 저장돼 있으면 새 구성원도 채팅으로 태어난다.
    operations.get(item.id)!.payload = { ...operations.get(item.id)!.payload, chatMode: true };
    const pendingMuster = launch.muster(item.id);
    await routingStarted;
    launch.memberPatched(item.id, routed.id, { subagents: false });
    finishRouting(Response.json({ model: "sonnet" }));
    await pendingMuster;
    expect(launches.at(-1)?.disableSubagents).toBe(true);
    expect(launches.at(-1)?.viewMode).toBe("chat");

    // 명단에서 뺀 구성원은 복원되면 일반 Operation 이다 — 질문 정책을 되돌린 뒤 닫는다.
    launch.memberRemoved(item.id, routed.id);
    const removedId = launches.length > 0 ? `launched-${launches.length}` : "";
    expect(userQuestions.at(-1)).toEqual({ operationId: removedId, policy: "default" });
    expect(operations.has(removedId)).toBe(false);

    // 살아 있는 지휘관은 저장값보다 지금 보이는 표면이 이긴다 — 채팅으로 저장됐어도 터미널로 떠 있으면 터미널로 태어난다.
    vi.unstubAllGlobals();
    routingOrigin = null;
    activity.set(item.id, "idle");
    surfaces.set(item.id, "terminal");
    const late = store.memberAdd(item.id, { role: "late" }, "human").members.at(-1)!;
    await launch.muster(item.id);
    expect(launches.at(-1)?.viewMode).toBe("terminal");
    launch.memberRemoved(item.id, late.id);

    // 지휘관만 지워지고(삭제 사건을 놓침) 복원 불가로 확정되면 구성원은 제 목표의 지휘관으로 보인다 — 질문 차단이 남으면 안 된다.
    // 되돌리는 것은 이 목표가 기록한 구성원 중 남아 있는 Operation 뿐이다: 이미 없는 것·무관한 Operation 에는 쓰지 않는다.
    operations.delete(allowedOperationId);
    operations.delete(item.id);
    userQuestions.length = 0;
    launch.operationPurged("unrelated-operation");
    expect(userQuestions).toEqual([]);
    launch.operationPurged(item.id);
    expect(userQuestions).toEqual([{ operationId: blockedOperationId, policy: "default" }]);
    expect(operations.has(blockedOperationId)).toBe(true);
    expect(store.find(blockedOperationId)).toMatchObject({ id: blockedOperationId });
  });

  it("creates an objective as a dormant Commander Operation and keeps only objective-owned values in the workspace state.json", async () => {
    const { store, events, launch, operations, sent, launches, stateFile, workspace, activity, slept, interrupted, resumed } = harness();
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
    // 첫 실행 전 뷰는 Operation 프리셋에만 저장하고, 모델·세션 이름은 유지한다.
    expect(launch.setPreset(item.id, { viewMode: "chat" }).commander).toMatchObject({ viewMode: "chat", model: "opus[1m]", sessionName: `${head}-cmdr` });
    // 수동 재개된 유휴 채팅은 아직 provider 좌표가 없어도 이미 프리셋을 읽었다.
    activity.set(item.id, "idle");
    expect(() => launch.setPreset(item.id, { viewMode: "terminal" })).toThrow("item_busy");
    expect(() => launch.setPreset(item.id, { model: "sonnet" })).toThrow("item_busy");
    activity.set(item.id, "dormant");
    expect(launch.setPreset(item.id, { viewMode: "terminal" }).commander.viewMode).toBe("terminal");
    // 구성원 명단 — 임무는 구성원만 가리킨다. 두 임무가 한 구성원을 나눠 쓴다.
    const research = store.memberAdd(item.id, { role: "research" }, "human").members[0]!.id;
    const build = store.memberAdd(item.id, { role: "build" }, "human").members[1]!.id;
    store.stepPatch(item.id, a!.id, { member: research });
    store.stepPatch(item.id, b!.id, { member: build }, { by: "human" });
    store.stepPatch(item.id, c!.id, { member: build });
    // 개시 — 구성원 전원을 한꺼번에, 첫 메시지 없이(대기) 서브에이전트 없이 띄운 뒤 지휘관에게만 한 줄을 보낸다.
    await launch.startCoordinator(item.id);
    expect(sent).toEqual([{ operationId: item.id, text: expect.stringContaining(item.id) }]);
    expect(launches.slice(1)).toEqual([
      expect.objectContaining({ sessionName: `${head}-member-1`, dormant: undefined, disableSubagents: true, text: undefined }),
      expect.objectContaining({ sessionName: `${head}-member-2`, dormant: undefined, disableSubagents: true, text: undefined }),
    ]);
    // 첫 세션이 잡힌 뒤에는 유휴 상태여도 모델·뷰를 바꾸지 못한다.
    const node = operations.get(item.id)!;
    node.payload.session = { ...(node.payload.session as object), id: "captured-session", capturedAt: "2026-09-25T00:00:00Z", source: "hook" };
    expect(() => launch.setPreset(item.id, { viewMode: "chat" })).toThrow("item_busy");
    expect(store.find(item.id)!.commander.viewMode).toBe("terminal");
    // 위임할 때마다 새 Operation 을 만들지 않는다 — 같은 구성원의 임무는 같은 Operation 이다.
    expect(store.find(item.id)!.steps.map((step) => step.operationId)).toEqual(["launched-2", "launched-3", "launched-3"]);
    // 임무 진행(blocked/done)은 그대로 두되, 실제 구성원 입력 대기를 별도 신호로 cluster 서술자에 전달한다.
    const clusterMember = (id: string) => clustersOf([store.find(item.id)!], new Map([...activity].map(([key, value]) => [key, value])))[0]!.members.find((member) => member.operationId === id)!;
    activity.set("launched-3", "awaiting");
    expect(clusterMember("launched-3")).toMatchObject({ progress: "blocked", awaitingInput: true });
    activity.set("launched-3", "idle");
    expect(clusterMember("launched-3")).toMatchObject({ progress: "blocked", awaitingInput: false });
    // 다시 세워도 살아 있는 구성원은 그대로, 휴면한 구성원은 새로 띄우지 않고 세션째 재개한다.
    activity.set("launched-2", "dormant");
    expect((await launch.muster(item.id)).map((member) => member.state)).toEqual(["resumed", "live"]);
    expect([launches.length, resumed]).toEqual([3, ["launched-2"]]);
    // 다시 작업해 다시 완료하면 기록이 쌓인다(종류는 위치로).
    store.stepDone(item.id, a!.id, ["a done"]);
    store.stepDone(item.id, a!.id, ["a redone", "fixed the gap"]);
    activity.set("launched-2", "awaiting");
    expect(clusterMember("launched-2")).toMatchObject({ progress: "done", awaitingInput: true });
    activity.set("launched-2", "idle");
    // 완료는 지휘관과 구성원을 휴면시키되 연결을 풀지 않는다. 답을 기다리는 터미널 지휘관과 백그라운드 작업이 남은 구성원은 그대로 재우고, 실행 중인 구성원은 중단한 뒤 재운다.
    activity.set(item.id, "awaiting");
    activity.set("launched-2", "running");
    activity.set("launched-3", "background");
    expect(launch.complete(item.id).done).toBeTruthy();
    await expect.poll(() => slept.length).toBe(3);
    expect(interrupted).toEqual(["launched-2"]);
    expect(slept.sort()).toEqual([item.id, "launched-2", "launched-3"].sort());
    expect(store.reopen(item.id).steps.map((step) => step.member)).toEqual([research, build, build]);
    // 계획은 완료·기록·사람이 담당을 정한 임무를 보존하고 나머지를 바꾼다; 새 임무는 편성 순으로 선다.
    const planned = store.plan(item.id, { steps: [{ text: "x", after: [{ index: 1, why: "shares files" }] }, { text: "y", after: [{ stepId: a!.id, why: "builds on a" }] }] });
    expect(planned.steps.map((step) => step.text)).toEqual(["a", "b", "y", "x"]);
    expect(planned.steps[3]!.why[planned.steps[2]!.id]).toBe("shares files");
    // 저장 — 프로젝트 워크스페이스 디렉터리의 state.json 하나, Operation 이 가진 값은 싣지 않는다.
    expect(fs.existsSync(stateFile)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { version: number; objectives: Record<string, unknown>[] };
    expect(saved.version).toBe(3);
    expect(Object.keys(saved.objectives[0]!).sort()).toEqual(["members", "note", "operationId", "steps"]);
    for (const key of ["title", "theaterId", "groupId", "slot", "createdAt", "updatedAt", "history", "author", "review"]) expect(JSON.stringify(saved)).not.toContain(`"${key}"`);
    // 재시작 뒤에도 파일에서 같은 상태를 읽는다 — 제목·그룹은 Operation 에서 온다.
    const reloaded = createObjectiveStore({ dirOf: () => path.join(workspace, "objectives"), operations: { get: (id) => operations.get(id) ?? null, list: () => [...operations.values()] }, emit: () => undefined });
    expect(reloaded.find(item.id)).toMatchObject({ title: "Release", groupId: "g-ship", criteriaOpen: false, criteriaProposals: [] });
    expect(reloaded.find(item.id)!.steps[0]!.records.map((record) => [record.kind, record.lines])).toEqual([["done", ["a done"]], ["redone", ["a redone", "fixed the gap"]]]);
    // 모든 쓰기가 사건으로 나갔다 — 화면은 이 프레임으로 갱신된다.
    expect(events.filter((event) => event.op === "upsert" && event.itemId === item.id).length).toBeGreaterThanOrEqual(8);
    // 메모 첨부 — 머리 바이트가 이미지가 아니면 받지 않는다; 목표를 지우면 지휘관 Operation 이 닫히고 구성원도 따라 닫히며,
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

  it("adds an objective from Console Use with brief and criteria only, through the same exposed-schema gate the host checks", async () => {
    const { store, operations, add, stateFile, workspace, launches, consoleTool } = harness();
    const caller = add("console-caller", { title: "Console caller", groupId: "g-console" });
    // 호스트와 같은 선검사 — 노출 스키마를 되살려 먼저 통과시킨 뒤, 호스트처럼 파싱된 값(parsed.data)으로 execute 가 돈다.
    // 노출 스키마가 알 수 없는 add 키를 strip 하는 회귀는 조용한 생성으로 드러나고, 중첩 strict 회귀는 선검사에서 걸린다.
    const gate = z.fromJSONSchema(consoleTool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
    const throughGate = async (args: Record<string, unknown>) => {
      const parsed = gate.safeParse(args);
      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error("exposed schema rejected representative input");
      return (await consoleTool.execute(parsed.data, { cwd: workspace, caller: { kind: "operation" as const, operationId: caller.id } })) as { isError: boolean; structuredContent: Record<string, unknown> };
    };
    const created = await throughGate({ add: { title: "From Console Use", note: "brief", criteria: ["ships", "tested"] } });
    expect(created.isError).toBe(false);
    const id = (created.structuredContent.item as { id: string }).id;
    // 브리핑·기준은 기본 요구사항으로, 임무·구성원 없이, 호출 Operation 의 그룹과 만든 표시를 들고 태어난다.
    expect(store.find(id)).toMatchObject({ note: "brief", groupId: "g-console", steps: [], members: [], addedBy: { operationId: caller.id } });
    expect(store.find(id)!.criteria).toMatchObject([{ text: "ships", by: "human" }, { text: "tested", by: "human" }]);
    // 저장 무결성 — 파일에서 다시 읽어도 기준이 기본 요구사항으로 남는다.
    const reloaded = createObjectiveStore({ dirOf: () => path.join(workspace, "objectives"), operations: { get: (oid) => operations.get(oid) ?? null, list: () => [...operations.values()] }, emit: () => undefined });
    expect(reloaded.find(id)!.criteria).toMatchObject([{ text: "ships", by: "human" }, { text: "tested", by: "human" }]);
    // 금지 입력은 선검사를 통과해도 이유 있게 거절되고, 기동도 Operation 도 레코드도 늘지 않는다.
    const fenced = { launches: launches.length, operations: operations.size, listed: store.list("t1").length };
    for (const args of [
      { add: { title: "Missions inline", steps: ["x"] } },
      { add: { title: "Top-level missions" }, steps: ["x"] },
      { add: { title: "Borrowed group", note: "b" }, groupId: "g-other" },
    ]) {
      const refused = await throughGate(args);
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent.error).toBe("add_brief_criteria_only");
      // 이유 안내는 제공되지만 전문을 고정하지는 않는다 — 문구는 다듬을 수 있고 경계가 담기면 된다.
      expect(typeof refused.structuredContent.hint).toBe("string");
      expect((refused.structuredContent.hint as string).length).toBeGreaterThan(0);
    }
    expect({ launches: launches.length, operations: operations.size, listed: store.list("t1").length }).toEqual(fenced);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).objectives).toHaveLength(1);
  });

  it("migrates v2 assignment into v3 members without losing records, order or read progress", () => {
    const { store, add, stateFile } = harness();
    add("commander");
    add("worker");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ version: 2, objectives: [{ operationId: "commander", note: "brief", steps: [
      { id: "one", text: "first", done: true, after: [], assign: { mode: "route" }, operationId: "worker", records: [{ id: "record", at: 12, lines: ["result"] }], seen: 1 },
      { id: "two", text: "next", after: [{ id: "one", why: "dependency" }], assign: { mode: "model", model: "opus", effort: "high" } },
      { id: "three", text: "another", after: [], assign: { mode: "model", model: "opus", effort: "high" } },
      { id: "four", text: "direct", after: [], assign: { mode: "self" } },
    ] }] }));
    const item = store.find("commander")!;
    expect(item.members).toHaveLength(2);
    expect(item.steps.map((step) => step.member)).toEqual([item.members[0]!.id, item.members[1]!.id, item.members[1]!.id, null]);
    expect(item.members[0]).toMatchObject({ role: "담당 1", by: "commander", operationId: "worker" });
    expect(item.members[1]).toMatchObject({ role: "opus", by: "human", launch: { mode: "model", model: "opus", effort: "high" } });
    expect(item.steps[0]).toMatchObject({ done: true, seen: 1, records: [{ id: "record", lines: ["result"] }] });
    expect(item.steps[1]).toMatchObject({ after: ["one"], why: { one: "dependency" } });
    store.patch("commander", { note: "changed" });
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(saved.version).toBe(3);
    expect(saved.objectives[0].steps[0]).toMatchObject({ id: "one", done: true, seen: 1, records: [{ id: "record", lines: ["result"] }] });
    expect(saved.objectives[0].steps.find((step: { id: string }) => step.id === "two").after).toEqual([{ id: "one", why: "dependency" }]);
    expect(JSON.stringify(saved.objectives[0].steps)).not.toMatch(/"assign"|"operationId"/);
  });

  it("shows every agent Operation created elsewhere as an objective, but not member or plugin Operations", async () => {
    const { store, launch, add, stateFile, launches, call } = harness();
    add("sidebar", { title: "Made in the sidebar", groupId: "g-a" });
    add("wiki", { pluginId: "codex", type: "codex-wiki" });
    const made = await launch.create({ theaterId: "t1", title: "Made in Objectives", groupId: null, steps: [{ text: "one" }] });
    store.memberAdd(made.id, { role: "build" }, "human");
    await launch.muster(made.id);
    // 레코드 없는 Operation 은 빈 목표로 선다 — 구성원(launched-2)과 플러그인 Operation 은 목표가 아니다.
    expect(store.list("t1").map((item) => item.id).sort()).toEqual(["launched-1", "sidebar"]);
    expect(store.find("sidebar")).toMatchObject({ title: "Made in the sidebar", groupId: "g-a", note: "", steps: [], awaitingReview: false });
    expect(store.find("launched-2")).toBeNull();
    // 첫 편집이 레코드를 만든다.
    expect(JSON.stringify(JSON.parse(fs.readFileSync(stateFile, "utf8")))).not.toContain("sidebar");
    store.patch("sidebar", { note: "now it has a brief" });
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).objectives.map((entry: { operationId: string }) => entry.operationId)).toContain("sidebar");
    // 따로 만든 지휘관에게는 고정 이름이 없다 — 구성원은 그래도 사람에게 묻지 않고, 주소를 지어내지 않고 null 로 받는다.
    const helper = store.memberAdd("sidebar", { role: "helper" }, "human").members.at(-1)!;
    await launch.muster("sidebar");
    expect(launches.at(-1)?.disableUserQuestions).toBe(true);
    const helperOperation = store.find("sidebar")!.members.find((member) => member.id === helper.id)!.operationId!;
    expect((await call("mine", {}, helperOperation)).structuredContent).toMatchObject({ role: "member", commander: { session: null } });
  });

  it("keeps an objective in its Commander Operation's group and moves the members with it", async () => {
    const { store, launch, operations } = harness();
    const item = await launch.create({ theaterId: "t1", title: "Ship", groupId: "g-review", steps: [{ text: "a" }] });
    store.memberAdd(item.id, { role: "build" }, "human");
    const worker = (await launch.muster(item.id))[0]!.operationId;
    expect(operations.get(worker)!.groupId).toBe("g-review");
    // 목표에서 옮기면 지휘관 Operation 이 옮겨지고, 구성원이 따라간다 — 목표의 그룹은 저장하지 않는다.
    launch.regroup(item.id, "g-done");
    expect([operations.get(item.id)!.groupId, operations.get(worker)!.groupId, store.find(item.id)!.groupId]).toEqual(["g-done", "g-done", "g-done"]);
    // 사이드바에서 구성원만 옮긴 것은 목표를 움직이지 않는다; 없는 그룹으로는 옮기지 않는다.
    operations.get(worker)!.groupId = "g-other";
    expect(store.find(item.id)!.groupId).toBe("g-done");
    expect(() => launch.regroup(item.id, "nope")).toThrow(ObjectiveStoreError);
  });

  it("lets only the objective's own Commander write, gives members read-only access and outsiders none, and keeps planning and the person's missions and assignments intact", async () => {
    const { store, call, launch } = harness();
    const item = await launch.create({ theaterId: "t1", title: "Guarded", groupId: null, steps: [{ text: "one" }, { text: "two", after: [0] }] });
    const commander = item.id;
    const other = (await launch.create({ theaterId: "t1", title: "Other", groupId: null })).id;
    // 다른 목표의 지휘관은 이 목표를 쓰지도 읽지도 못한다.
    expect((await call("plan", { itemId: item.id, steps: [{ text: "p" }] }, other)).structuredContent.error).toBe("not_participant");
    expect((await call("read", { itemId: item.id }, other)).structuredContent.error).toBe("not_participant");
    // 구상 중에는 편성만 — 명단이 비었을 때만 지휘관이 구성원을 제안하고(모델은 고르지 않아 라우팅), 임무에 구성원을 표시한다.
    // 임무 수행 쓰기와 구성원 기동은 거절된다.
    store.setCooking(item.id, true);
    expect((await call("plan", { itemId: item.id, steps: [{ text: "p1", member: "build" }, { text: "p2", after: [{ index: 0 }] }], members: [{ role: "build", brief: "implements" }] }, commander)).isError).toBe(false);
    expect(store.find(item.id)!.members).toMatchObject([{ role: "build", by: "commander", launch: { mode: "route" } }]);
    expect((await call("complete_mission", { itemId: item.id, index: 0, summary: ["early"] }, commander)).structuredContent.error).toBe("planning_only");
    expect((await call("muster", { itemId: item.id }, commander)).structuredContent.error).toBe("planning_only");
    // 명단이 있으면 지휘관은 명단을 다시 쓰지 못한다(빈 명단으로 지우는 것도).
    expect((await call("plan", { itemId: item.id, steps: [{ text: "p3" }], members: [] }, commander)).structuredContent.error).toBe("members_exist");
    store.setCooking(item.id, false);
    const mustered = await call("muster", { itemId: item.id }, commander);
    const member = (mustered.structuredContent.members as { operationId: string; state: string }[])[0]!;
    expect(member.state).toBe("launched");
    // 구성원은 제 역할과 맡은 임무를 읽지만 쓰지 못한다.
    // 구성원은 보고·판단 요청을 보낼 지휘관의 세션 주소를 함께 받는다.
    expect((await call("mine", {}, member.operationId)).structuredContent).toMatchObject({ role: "member", access: "read-only", itemId: item.id, commander: { session: store.find(item.id)!.commander.sessionName }, member: { role: "build", brief: "implements" }, missions: [{ index: 0, text: "p1" }] });
    expect(store.find(item.id)!.commander.sessionName).toMatch(/-cmdr$/);
    expect((await call("read", { itemId: item.id }, member.operationId)).isError).toBe(false);
    expect((await call("mine", {}, commander)).structuredContent).toMatchObject({ role: "commander", itemId: item.id });
    // 사람이 선행 없이 더한 단계는 미분류 — 지휘관이 자리를 정하기 전까지 준비되지 않는다.
    launch.stepAdded(item.id, { text: "missed" }, { by: "human" });
    const board = async () => ((await call("read", { itemId: item.id }, commander)).structuredContent.item as { graph: { steps: { unplaced?: boolean; ready: boolean; after: number[]; member: { role: string } | null }[] } }).graph.steps;
    // 지휘관이 읽기 전에 사람이 바꾼 보드로는 계획을 쓸 수 없다.
    store.setEdited(item.id, ["steps"]);
    expect((await call("plan", { itemId: item.id, steps: [{ text: "stale" }] }, commander)).structuredContent.error).toBe("board_changed");
    const missed = (await board()).findIndex((step) => step.unplaced);
    expect((await board())[missed]).toMatchObject({ unplaced: true, ready: false });
    // 계획이 남기는 임무를 같은 문구로 다시 만들어 두 벌을 세우지 못한다.
    expect((await call("plan", { itemId: item.id, steps: [{ text: " Missed " }] }, commander)).structuredContent).toMatchObject({ error: "mission_kept", kept: [{ text: "missed", unplaced: true }] });
    // 배치는 지휘관만 — 담당 구성원도 함께 정한다.
    expect((await call("place_mission", { itemId: item.id, index: missed, after: [0] }, member.operationId)).structuredContent.error).toBe("not_commander");
    expect((await call("place_mission", { itemId: item.id, index: missed, after: [0], member: "build" }, commander)).isError).toBe(false);
    expect((await board()).find((step) => step.after.includes(0) && step.unplaced === undefined && step.member?.role === "build")).toBeTruthy();
    // 사람이 정한 담당은 「지휘관 직접」이라도 지휘관이 덮지 못한다(계획 보존은 첫 계약에서).
    const p2 = store.find(item.id)!.steps.find((step) => step.text === "p2")!;
    store.stepPatch(item.id, p2.id, { member: null }, { by: "human" });
    await call("read", { itemId: item.id }, commander);
    const p2Index = store.find(item.id)!.steps.findIndex((step) => step.id === p2.id);
    await call("place_mission", { itemId: item.id, index: p2Index, after: [0], member: "build" }, commander);
    expect(store.find(item.id)!.steps.find((step) => step.id === p2.id)!.member).toBeNull();
    // 완료는 결론 먼저 1–3줄의 기록과 함께이고, 산문 문단은 거절된다. 구성원은 완료하지 못한다.
    expect((await call("complete_mission", { itemId: item.id, index: 0, summary: ["r"] }, member.operationId)).structuredContent.error).toBe("not_commander");
    expect((await call("complete_mission", { itemId: item.id, index: 0, summary: ["x".repeat(400)] }, commander)).structuredContent.error).toBe("summary_format");
    expect((await call("complete_mission", { itemId: item.id, index: 0, summary: ["shipped p1", "tests pass"] }, commander)).isError).toBe(false);
    // 같은 목표에 시작이 겹치면 하나만 간다.
    const results = await Promise.allSettled([launch.startCoordinator(other), launch.startCoordinator(other)]);
    expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
  });

  it("keeps criteria proposed until the person decides, then reaches review only with evidence", async () => {
    const { store, call, route, launch, events, stateFile } = harness();
    const item = await launch.create({ theaterId: "t1", title: "Criteria", groupId: null, steps: [{ text: "fix" }] });
    const as = item.id;
    const first = store.criterionAdd(as, "tests pass", "human").criteria[0]!;
    const second = store.criterionAdd(as, "copy unchanged", "human").criteria[1]!;
    const plan = (criteria: unknown) => call("plan", { itemId: as, steps: [{ text: "fix" }], criteria }, as);
    // 기준 제안은 사람이 구상을 명시적으로 요청한 국면에서만 열린다.
    expect((await plan([{ text: "new" }])).structuredContent.error).toBe("criteria_not_planning");
    expect((await route("plan/request", { itemId: as })).status).toBe(200);
    const before = events.length;
    expect((await plan([{ revise: 1, text: "tests and types pass" }, { text: "lint passes" }, { retire: second.id, reason: "redundant" }])).isError).toBe(false);
    expect(events.length).toBe(before + 1); // 임무와 제안을 한 번의 저장/방송으로 적용한다.
    expect(store.find(as)!.criteria).toMatchObject([{ text: "tests pass" }, { text: "copy unchanged" }]);
    expect(store.find(as)!.criteriaProposals).toHaveLength(3);
    expect(store.find(as)!.awaitingReview).toBe(false);
    expect((await route("coordinator/start", { itemId: as })).value.error).toBe("criteria_pending");
    expect((await route("coordinator/steer", { itemId: as })).value.error).toBe("criteria_pending");
    expect((await call("mark_criterion", { itemId: as, n: 1, met: true, evidence: "12/12" }, as)).structuredContent.error).toBe("criteria_pending");
    const [revise, added, retire] = store.find(as)!.criteriaProposals;
    expect((await route("criterion/reject", { itemId: as, proposalId: retire!.id })).status).toBe(200);
    expect((await route("criterion/annotate", { itemId: as, proposalId: revise!.id, annotation: "check both languages" })).status).toBe(200);
    expect((await route("plan/request", { itemId: as })).status).toBe(200);
    expect((await call("read", { itemId: as }, as)).structuredContent.item).toMatchObject({ criteriaProposals: [{ annotation: "check both languages", targetN: 1 }, { kind: "add" }] });
    const replanned = events.length;
    expect((await plan([{ revise: first.id, text: "one" }, { retire: first.id, reason: "duplicate" }])).structuredContent.error).toBe("duplicate_criterion_proposal");
    expect(events.length).toBe(replanned);
    expect(store.find(as)!.criteriaProposals[0]!.annotation).toBe("check both languages");
    expect((await plan([{ revise: first.id, text: "tests pass in both languages" }, { text: "lint passes" }])).isError).toBe(false);
    expect(events.length).toBe(replanned + 1);
    expect(store.find(as)!.criteriaProposals).toHaveLength(2);
    expect(store.find(as)!.criteriaProposals.every((proposal) => !proposal.annotation && proposal.id !== added!.id)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(saved.version).toBe(3);
    expect(saved.objectives[0].criteriaProposals).toHaveLength(2);
    const replacement = store.find(as)!.criteriaProposals[0]!;
    expect((await route("criterion/approve", { itemId: as, proposalId: replacement.id })).status).toBe(200);
    expect(store.find(as)!.criteria[0]).toMatchObject({ id: first.id, by: "human", text: "tests pass in both languages" });
    expect((await route("criterion/approve-all", { itemId: as })).status).toBe(200);
    expect(store.find(as)!.criteria[2]).toMatchObject({ by: "commander", text: "lint passes" });
    expect((await route("coordinator/start", { itemId: as })).status).toBe(200);
    expect(store.find(as)!.criteriaOpen).toBe(false);
    // 마지막 임무를 마친 뒤에도 지휘관이 근거를 적기 전에는 검토 대기가 아니다.
    const done = await call("complete_mission", { itemId: as, index: 0, summary: ["fixed"] }, as);
    expect(String(done.structuredContent.next)).toContain("copy unchanged");
    expect((await call("mark_criterion", { itemId: as, n: 1, met: true }, as)).structuredContent.error).toBe("evidence_required");
    for (const n of [1, 2, 3]) await call("mark_criterion", { itemId: as, n, met: true, evidence: `checked ${n}` }, as);
    expect(store.find(as)!.awaitingReview).toBe(true);
    // 사람의 문구 변경과 새 작업은 앞선 충족 판단을 해당 기준/전체에서 거둔다.
    store.criterionPatch(as, second.id, "copy unchanged in both languages");
    expect(store.find(as)!.criteria.map((criterion) => criterion.met ?? null)).toEqual(["checked 1", null, "checked 3"]);
    launch.stepAdded(as, { text: "one more" }, { by: "human" });
    expect(store.find(as)!.criteria.every((criterion) => !criterion.met)).toBe(true);
    // 구상 중 스티어링 뒤의 턴은 cooking=true여도 기준 제안 권한이 닫힌다.
    await route("plan/request", { itemId: as });
    expect((await route("coordinator/steer", { itemId: as })).status).toBe(200);
    expect(store.find(as)!.cooking).toBe(true);
    expect((await plan([{ text: "unauthorized" }])).structuredContent.error).toBe("criteria_not_planning");
    await route("plan/request", { itemId: as });
    await plan([{ revise: second.id, text: "new copy" }]);
    store.criterionRemove(as, second.id);
    expect(store.find(as)!.criteriaProposals).toEqual([]); // 대상 기준 삭제와 제안 삭제는 같은 보드 변경이다.
  });

  it("registers even when a registered Theater folder is gone, and still gives the present Theater's members their Commander", async () => {
    // 등록된 Theater 폴더는 사라질 수 있다(옮김·외장 디스크). 기동의 부모 채우기가 그 Theater 에서 던지면 Console 전체가 뜨지 않는다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-objectives-register-"));
    dirs.push(dir);
    const workspaceOf = (theaterId: string) => path.join(dir, "workspaces", theaterId);
    fs.mkdirSync(path.join(workspaceOf("present"), "objectives"), { recursive: true });
    fs.writeFileSync(path.join(workspaceOf("present"), "objectives", "state.json"), JSON.stringify({ version: 3, objectives: [{ operationId: "cmdr", note: "", steps: [], members: [{ id: "m1", role: "보조", by: "human", operationId: "member" }] }] }));
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
    await objectivesPlugin.register!(ctx);
    expect(operations.get("member")!.parentOperationId).toBe("cmdr");
    expect(operations.get("lost")!.parentOperationId).toBeUndefined();
  });
});

import { useSyncExternalStore } from "react";

import type { ClientApiCapability, ConsoleOperationSummary, PluginInstallContext } from "@fleet-console/sdk/plugin";

import type { Objective, ObjectiveEvent } from "../server/types.js";

/**
 * 표면·캡션·팔레트가 함께 구독하는 모듈 스토어.
 *
 * 화면은 응답이 아니라 사건으로 갱신된다 — 자기 변경도 `objectives:objective` 프레임으로 들어온다. 그룹은 코어의
 * `group:changed`/`group:removed` 를 같은 스트림에서 듣는다. Operation 의 활동은 호스트 consoleState 가 진실이다.
 * 목표는 곧 에이전트 Operation 이라, Console 어디서든 Operation 이 생기면 그 목표를 받아 오고 사라지면 목록에서 뺀다.
 */

export interface ObjectiveGroup {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly order: number;
  readonly theaterId: string;
}

interface TheaterState {
  readonly objectives: readonly Objective[];
  readonly groups: readonly ObjectiveGroup[];
  readonly loaded: boolean;
  readonly launchAvailable: boolean;
}

export interface RevealTarget {
  readonly objectiveId: string;
  readonly missionId?: string;
  readonly at: number;
}

const EMPTY: TheaterState = { objectives: [], groups: [], loaded: false, launchAvailable: false };
const theaters = new Map<string, TheaterState>();
const listeners = new Set<() => void>();
let installed: PluginInstallContext | null = null;
let reveal: RevealTarget | null = null;
// useSyncExternalStore 는 스냅샷의 참조가 같아야 멈춘다 — 호스트의 getOperations 가 매번 새 배열을 줄 수 있으므로 여기서 한 번만 받아 둔다.
let operationsSnapshot: readonly ConsoleOperationSummary[] = [];
const inflight = new Map<string, Promise<void>>();
/** 받으러 간 목표 — 같은 Operation 을 두 번 묻지 않는다. */
const fetching = new Set<string>();
let knownOperationIds: ReadonlySet<string> = new Set();

/** 구성원 Operation — 임무가 아직 없어도 목표가 아니며 명단에서 제외되어야 한다. */
function memberIds(objectives: readonly Objective[]): ReadonlySet<string> {
  return new Set(objectives.flatMap((objective) => objective.members.flatMap((member) => member.operationId ? [member.operationId] : [])));
}

/**
 * Operation 목록과 목표를 맞춘다 — 읽어 둔 Theater 에 처음 보는 에이전트 Operation 이 있으면 그 목표를 받아 오고,
 * 목록에서 빠진 Operation(닫힘·삭제 유예)의 목표는 뺀다. 복원되면 다시 처음 보는 Operation 이 되어 돌아온다.
 */
function reconcileOperations(api: ClientApiCapability): void {
  const current = new Set(operationsSnapshot.map((operation) => operation.id));
  const gone = [...knownOperationIds].filter((id) => !current.has(id));
  knownOperationIds = current;
  for (const [theaterId, state] of theaters) {
    if (!state.loaded) continue;
    if (gone.length) {
      const drop = new Set(gone);
      if (state.objectives.some((objective) => drop.has(objective.id))) setTheater(theaterId, { objectives: state.objectives.filter((objective) => !drop.has(objective.id)) });
    }
    // 제목은 Operation 의 것이다 — 자동 작명처럼 사건 없이 바뀐 제목도 Operation 목록에서 따라간다.
    const titles = new Map(operationsSnapshot.map((operation) => [operation.id, operation.title]));
    const stale = (theaters.get(theaterId) ?? state).objectives;
    if (stale.some((objective) => titles.has(objective.id) && titles.get(objective.id) !== objective.title)) {
      setTheater(theaterId, { objectives: stale.map((objective) => (titles.has(objective.id) && titles.get(objective.id) !== objective.title ? { ...objective, title: titles.get(objective.id)! } : objective)) });
    }
    const known = new Set((theaters.get(theaterId) ?? state).objectives.map((objective) => objective.id));
    const members = memberIds(state.objectives);
    for (const operation of operationsSnapshot) {
      // 부모 아래 선 Operation(구성원)은 목표가 아니다 — 코어가 구성원으로 기록한 것은 묻지도 않는다.
      if (operation.theaterId !== theaterId || operation.type !== "agent" || operation.parentOperationId || known.has(operation.id) || members.has(operation.id) || fetching.has(operation.id)) continue;
      fetching.add(operation.id);
      void post<{ objective: Objective }>(api, "/objective/get", { objectiveId: operation.id })
        .then(({ objective }) => {
          const latest = theaters.get(objective.theaterId) ?? EMPTY;
          // 응답을 기다리는 사이 담당으로 연결됐으면 목표가 아니다.
          if (!latest.objectives.some((candidate) => candidate.id === objective.id) && !memberIds(latest.objectives).has(objective.id)) setTheater(objective.theaterId, { objectives: [objective, ...latest.objectives] });
        })
        .catch(() => { /* 플러그인 소유이거나 담당이면 목표가 아니다 */ })
        .finally(() => { fetching.delete(operation.id); });
    }
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function setTheater(theaterId: string, next: Partial<TheaterState>): void {
  theaters.set(theaterId, { ...(theaters.get(theaterId) ?? EMPTY), ...next });
  notify();
}

export function installObjectiveState(ctx: PluginInstallContext): () => void {
  installed = ctx;
  const offItem = ctx.consoleEvents.subscribe("objectives:objective", (payload) => {
    const event = payload as ObjectiveEvent | null;
    if (!event || typeof event.objectiveId !== "string" || typeof event.theaterId !== "string") return;
    const current = theaters.get(event.theaterId) ?? EMPTY;
    if (event.op === "remove") { setTheater(event.theaterId, { objectives: current.objectives.filter((objective) => objective.id !== event.objectiveId) }); return; }
    if (!event.objective) return;
    const exists = current.objectives.some((objective) => objective.id === event.objectiveId);
    const merged = exists ? current.objectives.map((objective) => (objective.id === event.objectiveId ? event.objective! : objective)) : [event.objective, ...current.objectives];
    // 위임 직후 담당 Operation 을 목표로 먼저 받아 왔을 수 있다 — 어느 목표의 담당이 된 Operation 은 목록에서 뺀다.
    const members = memberIds(merged);
    const objectives = members.size ? merged.filter((objective) => !members.has(objective.id)) : merged;
    // 순서가 함께 오면 서버의 줄을 따른다 — 목록에 없는 id 는 건너뛰고, 순서에 없는 항목은 뒤에 그대로 둔다.
    if (event.order) {
      const rank = new Map(event.order.map((id, index) => [id, index]));
      setTheater(event.theaterId, { objectives: [...objectives].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)) });
      return;
    }
    setTheater(event.theaterId, { objectives });
  });
  const offGroup = ctx.consoleEvents.subscribe("group:changed", (payload) => {
    const group = (payload as { group?: ObjectiveGroup } | null)?.group;
    if (!group || typeof group.id !== "string" || typeof group.theaterId !== "string") return;
    const current = theaters.get(group.theaterId) ?? EMPTY;
    const exists = current.groups.some((candidate) => candidate.id === group.id);
    setTheater(group.theaterId, { groups: (exists ? current.groups.map((candidate) => (candidate.id === group.id ? group : candidate)) : [...current.groups, group]).slice().sort((a, b) => a.order - b.order) });
  });
  const offRemoved = ctx.consoleEvents.subscribe("group:removed", (payload) => {
    const data = payload as { groupId?: string; theaterId?: string } | null;
    if (!data || typeof data.groupId !== "string") return;
    for (const [theaterId, state] of theaters) if (state.groups.some((group) => group.id === data.groupId)) setTheater(theaterId, { groups: state.groups.filter((group) => group.id !== data.groupId) });
  });
  // 활성 Theater 가 바뀌면 그 Theater 의 항목을 미리 읽는다 — 캡션 칩은 표면이 닫혀 있어도 서야 한다.
  let lastTheater = ctx.consoleState.getActiveTheaterId();
  if (lastTheater) void loadTheater(ctx.api, lastTheater);
  operationsSnapshot = ctx.consoleState.getOperations({ nested: true });
  const offConsole = ctx.consoleState.subscribe(() => {
    const current = ctx.consoleState.getActiveTheaterId();
    if (current && current !== lastTheater) { lastTheater = current; void loadTheater(ctx.api, current); }
    operationsSnapshot = ctx.consoleState.getOperations({ nested: true });
    reconcileOperations(ctx.api);
    notify();
  });
  return () => { offItem(); offGroup(); offRemoved(); offConsole(); if (installed === ctx) installed = null; };
}

export function objectivesApi(): ClientApiCapability | null {
  return installed?.api ?? null;
}

export async function post<T>(api: ClientApiCapability, path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await api.fetch("objectives", path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    // 호스트가 !ok 응답을 먼저 ApiError 로 끊어 post 의 코드 추출에 닿지 않는다 —
    // body 의 구조화 코드만 살려 띠·토스트가 사람의 말을 고르게 한다. 코드가 아니면 원본을 그대로 던진다.
    const code = apiErrorCode(error);
    if (code === null) throw error;
    throw new Error(code);
  }
  const payload = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(payload?.error ?? `http_${response.status}`);
  return payload as T;
}

/**
 * ApiError 의 구조화 코드 판독 — 호스트와 플러그인 번들이 모듈을 따로 들고 있어도 되게
 * instanceof 가 아니라 모양으로 본다. 원시 본문·내부 메시지는 꺼내지 않고 안전 코드 패턴만 받는다.
 */
function apiErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  if (record.name !== "ApiError" || typeof record.status !== "number") return null;
  const body = record.body;
  if (typeof body !== "object" || body === null) return null;
  const code = (body as Record<string, unknown>).error;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : null;
}

export function loadTheater(api: ClientApiCapability, theaterId: string, force = false): Promise<void> {
  const current = theaters.get(theaterId);
  if (current?.loaded && !force) return Promise.resolve();
  const pending = inflight.get(theaterId);
  if (pending) return pending;
  const task = post<{ objectives: Objective[]; groups: ObjectiveGroup[]; launch: { available: boolean } }>(api, "/state", { theaterId })
    .then((state) => {
      setTheater(theaterId, { objectives: state.objectives, groups: [...state.groups].sort((a, b) => a.order - b.order), loaded: true, launchAvailable: state.launch.available });
      // 읽는 사이 생긴 Operation 도 목표로 — 스냅숏 기준으로 한 번 맞춘다.
      if (installed) { knownOperationIds = new Set(); operationsSnapshot = installed.consoleState.getOperations({ nested: true }); reconcileOperations(installed.api); }
    })
    .catch(() => { setTheater(theaterId, { loaded: true }); })
    .finally(() => { inflight.delete(theaterId); });
  inflight.set(theaterId, task);
  return task;
}

export function subscribeObjective(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function readAllTheaters(): readonly TheaterState[] {
  return [...theaters.values()];
}

export function readTheater(theaterId: string | null): TheaterState {
  return theaterId ? theaters.get(theaterId) ?? EMPTY : EMPTY;
}

export function useObjectiveTheater(theaterId: string | null): TheaterState {
  return useSyncExternalStore(subscribeObjective, () => readTheater(theaterId), () => readTheater(theaterId));
}

export function operationSummaries(): readonly ConsoleOperationSummary[] {
  return operationsSnapshot;
}

export function useOperationSummaries(): readonly ConsoleOperationSummary[] {
  return useSyncExternalStore(subscribeObjective, operationSummaries, operationSummaries);
}

export function activeTheaterId(): string | null {
  return installed?.consoleState.getActiveTheaterId() ?? null;
}

/** 팔레트·캡션에서 "이 항목으로" — 표면이 마운트되어 있으면 즉시, 아니면 열릴 때 집는다. */
export function revealObjective(target: { objectiveId: string; missionId?: string }): void {
  reveal = { ...target, at: Date.now() };
  notify();
}
export function takeReveal(): RevealTarget | null {
  const current = reveal;
  reveal = null;
  return current;
}
export function useReveal(): RevealTarget | null {
  return useSyncExternalStore(subscribeObjective, () => reveal, () => reveal);
}

/**
 * 표면의 보기 상태 — 고른 목록 · 펼친 항목 · 구획 접힘 · 기한 필터. 표면을 닫으면 컴포넌트는 내려가지만 보던 자리는
 * 여기 Theater 별로 남아, 다시 열면 그대로 선다. 보는 사람의 편의라 메모리에만 둔다(새로고침이면 처음부터).
 */
export interface ObjectiveViewState {
  readonly list: string;
  readonly selected: string | null;
  readonly collapsed: Readonly<Record<string, boolean>>;
  readonly dueFilter: string;
  readonly externalSelectionId?: string | null;
}
const VIEW_DEFAULT: ObjectiveViewState = { list: "all", selected: null, collapsed: { done: true }, dueFilter: "all", externalSelectionId: null };
const views = new Map<string, ObjectiveViewState>();
const viewListeners = new Set<() => void>();
export function readObjectiveView(theaterId: string | null): ObjectiveViewState {
  return (theaterId ? views.get(theaterId) : undefined) ?? VIEW_DEFAULT;
}
export function patchObjectiveView(theaterId: string | null, patch: (current: ObjectiveViewState) => Partial<ObjectiveViewState>): void {
  if (!theaterId) return;
  const current = readObjectiveView(theaterId);
  const next = { ...current, ...patch(current) };
  if (
    next.list === current.list &&
    next.selected === current.selected &&
    next.collapsed === current.collapsed &&
    next.dueFilter === current.dueFilter &&
    next.externalSelectionId === current.externalSelectionId
  ) return;
  views.set(theaterId, next);
  for (const listener of viewListeners) listener();
}
export function useObjectiveView(theaterId: string | null): ObjectiveViewState {
  return useSyncExternalStore(
    (listener) => { viewListeners.add(listener); return () => { viewListeners.delete(listener); }; },
    () => readObjectiveView(theaterId),
    () => readObjectiveView(theaterId),
  );
}

let latestSelectionToken = 0;

/**
 * 맵 모드의 frame 활성 또는 Fleet Map 점 선택 시 열려 있는 목표 레일 패널의 선택을 동기화한다.
 * 레일이 닫혀 있거나 확장 전용 표면일 때는 자동 열기/전환 없이 조용히 무시하고, 미연결 Operation 은 기존 선택을 보존한다.
 */
export function handleMapOperationSelected(operationId: string): void {
  if (!installed?.rail.isOpen("objectives")) return;
  const token = ++latestSelectionToken;

  const allOps = operationsSnapshot;
  const op = allOps.find((candidate) => candidate.id === operationId)
    ?? installed.consoleState.getOperations({ nested: true }).find((candidate) => candidate.id === operationId);

  let targetTheaterId: string | null = op?.theaterId ?? null;
  if (!targetTheaterId) {
    for (const [tId, tState] of theaters) {
      if (tState.objectives.some((objective) => objective.id === operationId || objective.members.some((m) => m.operationId === operationId))) {
        targetTheaterId = tId;
        break;
      }
    }
  }
  if (!targetTheaterId) {
    targetTheaterId = activeTheaterId();
  }
  if (!targetTheaterId) return;

  const currentTheaterState = theaters.get(targetTheaterId);
  if (currentTheaterState?.loaded) {
    const matchingObjective = currentTheaterState.objectives.find(
      (objective) => objective.id === operationId || objective.members.some((m) => m.operationId === operationId)
    );
    if (!matchingObjective) return;

    const nextList = matchingObjective.groupId ? `group:${matchingObjective.groupId}` : "ungrouped";
    patchObjectiveView(targetTheaterId, (current) => {
      if (current.selected === matchingObjective.id && current.list === nextList && current.externalSelectionId === matchingObjective.id) return current;
      return { selected: matchingObjective.id, list: nextList, externalSelectionId: matchingObjective.id };
    });
    return;
  }

  const api = installed.api;
  if (!api) return;
  void loadTheater(api, targetTheaterId).then(() => {
    if (token !== latestSelectionToken) return;
    if (!installed?.rail.isOpen("objectives")) return;
    if (activeTheaterId() !== targetTheaterId) return;

    const loadedState = theaters.get(targetTheaterId);
    if (!loadedState?.loaded) return;

    const matchingObjective = loadedState.objectives.find(
      (objective) => objective.id === operationId || objective.members.some((m) => m.operationId === operationId)
    );
    if (!matchingObjective) return;

    const nextList = matchingObjective.groupId ? `group:${matchingObjective.groupId}` : "ungrouped";
    patchObjectiveView(targetTheaterId, (current) => {
      if (current.selected === matchingObjective.id && current.list === nextList && current.externalSelectionId === matchingObjective.id) return current;
      return { selected: matchingObjective.id, list: nextList, externalSelectionId: matchingObjective.id };
    });
  });
}

export function focusOperation(operationId: string): void {
  // 목표 표면은 닫고 간다 — 확장 표면이 무대를 덮은 채로는 옮겨간 Operation 이 보이지 않는다.
  // 착지는 Snap 전체다 — 스냅할 수 없는 모드·화면에서는 호스트가 같은 일반 이동으로 폴백한다.
  if (installed?.surfaces.isOpen("objectives")) installed.surfaces.closeSurface("objectives");
  installed?.operations.focus(operationId, { snap: "full" });
}

const OBJECTIVE_PANEL_ID = "objectives";
const OBJECTIVE_PLACE_KEY = "objectives.lastPlace";
type ObjectivePlace = "rail" | "expanded";

function rememberObjectivePlace(place: ObjectivePlace): void {
  installed?.preferences.write(OBJECTIVE_PLACE_KEY, place);
}

/** 아이콘·단축키는 현재 자리를 닫고, 닫혀 있으면 마지막 자리에 연다. */
export function toggleObjectivePlace(rail = installed?.rail, surfaces = installed?.surfaces): void {
  if (!rail || !surfaces) return;
  if (rail.isOpen(OBJECTIVE_PANEL_ID)) { rememberObjectivePlace("rail"); rail.close(OBJECTIVE_PANEL_ID); return; }
  if (surfaces.isOpen(OBJECTIVE_PANEL_ID)) { rememberObjectivePlace("expanded"); surfaces.closeSurface(OBJECTIVE_PANEL_ID); return; }
  const remembered = installed?.preferences.read<unknown>(OBJECTIVE_PLACE_KEY, "rail");
  const place = remembered === "expanded" ? "expanded" : "rail";
  if (place === "expanded") surfaces.open({ surfaceId: OBJECTIVE_PANEL_ID });
  else rail.open(OBJECTIVE_PANEL_ID);
  rememberObjectivePlace(place);
}

export function expandObjective(): void {
  if (!installed?.rail.isOpen(OBJECTIVE_PANEL_ID)) return;
  installed.surfaces.open({ surfaceId: OBJECTIVE_PANEL_ID });
  installed.rail.close(OBJECTIVE_PANEL_ID);
  rememberObjectivePlace("expanded");
}

export function dockObjective(): void {
  if (!installed?.surfaces.isOpen(OBJECTIVE_PANEL_ID)) return;
  installed.rail.open(OBJECTIVE_PANEL_ID);
  installed.surfaces.closeSurface(OBJECTIVE_PANEL_ID);
  rememberObjectivePlace("rail");
}

export function onObjectiveSurfaceClose(): void {
  // Esc나 다른 표면에 밀려 닫힌 경우에도 마지막 자리는 확장 표면이다.
  // 도킹 전환의 close 통보는 dockObjective가 이어서 rail로 다시 쓴다.
  rememberObjectivePlace("expanded");
}

export function openObjectiveSurface(): void {
  installed?.surfaces.open({ surfaceId: OBJECTIVE_PANEL_ID });
  rememberObjectivePlace("expanded");
}

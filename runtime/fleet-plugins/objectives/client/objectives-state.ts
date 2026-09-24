import { useSyncExternalStore } from "react";

import type { ClientApiCapability, ConsoleOperationSummary, PluginInstallContext } from "@fleet-console/sdk/plugin";

import type { ObjectiveItem, ObjectiveItemEvent } from "../server/types.js";

/**
 * 표면·캡션·팔레트가 함께 구독하는 모듈 스토어.
 *
 * 화면은 응답이 아니라 사건으로 갱신된다 — 자기 변경도 `objectives:item` 프레임으로 들어온다. 그룹은 코어의
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
  readonly items: readonly ObjectiveItem[];
  readonly groups: readonly ObjectiveGroup[];
  readonly loaded: boolean;
  readonly launchAvailable: boolean;
}

export interface RevealTarget {
  readonly itemId: string;
  readonly stepId?: string;
  readonly at: number;
}

const EMPTY: TheaterState = { items: [], groups: [], loaded: false, launchAvailable: false };
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

/** 담당 Operation — 목표가 아니라 어느 목표의 임무를 맡은 세션이다. */
function assigneeIds(items: readonly ObjectiveItem[]): ReadonlySet<string> {
  return new Set(items.flatMap((item) => item.steps.flatMap((step) => (step.operationId ? [step.operationId] : []))));
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
      if (state.items.some((item) => drop.has(item.id))) setTheater(theaterId, { items: state.items.filter((item) => !drop.has(item.id)) });
    }
    const known = new Set((theaters.get(theaterId) ?? state).items.map((item) => item.id));
    const assignees = assigneeIds(state.items);
    for (const operation of operationsSnapshot) {
      if (operation.theaterId !== theaterId || operation.type !== "agent" || known.has(operation.id) || assignees.has(operation.id) || fetching.has(operation.id)) continue;
      fetching.add(operation.id);
      void post<{ item: ObjectiveItem }>(api, "/item/get", { itemId: operation.id })
        .then(({ item }) => {
          const latest = theaters.get(item.theaterId) ?? EMPTY;
          // 응답을 기다리는 사이 담당으로 연결됐으면 목표가 아니다.
          if (!latest.items.some((candidate) => candidate.id === item.id) && !assigneeIds(latest.items).has(item.id)) setTheater(item.theaterId, { items: [item, ...latest.items] });
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
  const offItem = ctx.consoleEvents.subscribe("objectives:item", (payload) => {
    const event = payload as ObjectiveItemEvent | null;
    if (!event || typeof event.itemId !== "string" || typeof event.theaterId !== "string") return;
    const current = theaters.get(event.theaterId) ?? EMPTY;
    if (event.op === "remove") { setTheater(event.theaterId, { items: current.items.filter((item) => item.id !== event.itemId) }); return; }
    if (!event.item) return;
    const exists = current.items.some((item) => item.id === event.itemId);
    const merged = exists ? current.items.map((item) => (item.id === event.itemId ? event.item! : item)) : [event.item, ...current.items];
    // 위임 직후 담당 Operation 을 목표로 먼저 받아 왔을 수 있다 — 어느 목표의 담당이 된 Operation 은 목록에서 뺀다.
    const assignees = assigneeIds(merged);
    const items = assignees.size ? merged.filter((item) => !assignees.has(item.id)) : merged;
    // 순서가 함께 오면 서버의 줄을 따른다 — 목록에 없는 id 는 건너뛰고, 순서에 없는 항목은 뒤에 그대로 둔다.
    if (event.order) {
      const rank = new Map(event.order.map((id, index) => [id, index]));
      setTheater(event.theaterId, { items: [...items].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)) });
      return;
    }
    setTheater(event.theaterId, { items });
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
  operationsSnapshot = ctx.consoleState.getOperations();
  const offConsole = ctx.consoleState.subscribe(() => {
    const current = ctx.consoleState.getActiveTheaterId();
    if (current && current !== lastTheater) { lastTheater = current; void loadTheater(ctx.api, current); }
    operationsSnapshot = ctx.consoleState.getOperations();
    reconcileOperations(ctx.api);
    notify();
  });
  return () => { offItem(); offGroup(); offRemoved(); offConsole(); if (installed === ctx) installed = null; };
}

export function objectivesApi(): ClientApiCapability | null {
  return installed?.api ?? null;
}

export async function post<T>(api: ClientApiCapability, path: string, body: unknown): Promise<T> {
  const response = await api.fetch("objectives", path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(payload?.error ?? `http_${response.status}`);
  return payload as T;
}

export function loadTheater(api: ClientApiCapability, theaterId: string, force = false): Promise<void> {
  const current = theaters.get(theaterId);
  if (current?.loaded && !force) return Promise.resolve();
  const pending = inflight.get(theaterId);
  if (pending) return pending;
  const task = post<{ items: ObjectiveItem[]; groups: ObjectiveGroup[]; launch: { available: boolean } }>(api, "/state", { theaterId })
    .then((state) => {
      setTheater(theaterId, { items: state.items, groups: [...state.groups].sort((a, b) => a.order - b.order), loaded: true, launchAvailable: state.launch.available });
      // 읽는 사이 생긴 Operation 도 목표로 — 스냅숏 기준으로 한 번 맞춘다.
      if (installed) { knownOperationIds = new Set(); operationsSnapshot = installed.consoleState.getOperations(); reconcileOperations(installed.api); }
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
export function revealItem(target: { itemId: string; stepId?: string }): void {
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
}
const VIEW_DEFAULT: ObjectiveViewState = { list: "all", selected: null, collapsed: { done: true }, dueFilter: "all" };
const views = new Map<string, ObjectiveViewState>();
const viewListeners = new Set<() => void>();
export function readObjectiveView(theaterId: string | null): ObjectiveViewState {
  return (theaterId ? views.get(theaterId) : undefined) ?? VIEW_DEFAULT;
}
export function patchObjectiveView(theaterId: string | null, patch: (current: ObjectiveViewState) => Partial<ObjectiveViewState>): void {
  if (!theaterId) return;
  const current = readObjectiveView(theaterId);
  const next = { ...current, ...patch(current) };
  if (next.list === current.list && next.selected === current.selected && next.collapsed === current.collapsed && next.dueFilter === current.dueFilter) return;
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

export function focusOperation(operationId: string): void {
  // 목표 표면은 닫고 간다 — 확장 표면이 무대를 덮은 채로는 옮겨간 Operation 이 보이지 않는다.
  if (installed?.surfaces.isOpen("objectives")) installed.surfaces.closeSurface("objectives");
  installed?.operations.focus(operationId);
}

const OBJECTIVE_PANEL_ID = "objectives";
const OBJECTIVE_PLACE_KEY = "objectives.lastPlace";
const LEGACY_PLACE_KEY = "todo.lastPlace";
type ObjectivePlace = "rail" | "expanded";

function rememberObjectivePlace(place: ObjectivePlace): void {
  installed?.preferences.write(OBJECTIVE_PLACE_KEY, place);
}

/** 아이콘·단축키는 현재 자리를 닫고, 닫혀 있으면 마지막 자리에 연다. */
export function toggleObjectivePlace(rail = installed?.rail, surfaces = installed?.surfaces): void {
  if (!rail || !surfaces) return;
  if (rail.isOpen(OBJECTIVE_PANEL_ID)) { rememberObjectivePlace("rail"); rail.close(OBJECTIVE_PANEL_ID); return; }
  if (surfaces.isOpen(OBJECTIVE_PANEL_ID)) { rememberObjectivePlace("expanded"); surfaces.closeSurface(OBJECTIVE_PANEL_ID); return; }
  // 이름을 바꾸기 전(todo)에 기억한 자리도 처음 한 번은 따른다 — 여는 순간 새 키에 적힌다.
  const remembered = installed?.preferences.read<unknown>(OBJECTIVE_PLACE_KEY, null) ?? installed?.preferences.read<unknown>(LEGACY_PLACE_KEY, "rail");
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

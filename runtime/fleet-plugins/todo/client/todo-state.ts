import { useSyncExternalStore } from "react";

import type { ClientApiCapability, ConsoleOperationSummary, PluginInstallContext } from "@fleet-console/sdk/plugin";

import type { TodoItem, TodoItemEvent } from "../server/types.js";

/**
 * 표면·캡션·팔레트가 함께 구독하는 모듈 스토어.
 *
 * 화면은 응답이 아니라 사건으로 갱신된다 — 자기 변경도 `todo:item` 프레임으로 들어온다. 그룹은 코어의
 * `group:changed`/`group:removed` 를 같은 스트림에서 듣는다. Operation 의 활동은 호스트 consoleState 가 진실이다.
 */

export interface TodoGroup {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly order: number;
  readonly theaterId: string;
}

interface TheaterState {
  readonly items: readonly TodoItem[];
  readonly groups: readonly TodoGroup[];
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

function notify(): void {
  for (const listener of listeners) listener();
}

function setTheater(theaterId: string, next: Partial<TheaterState>): void {
  theaters.set(theaterId, { ...(theaters.get(theaterId) ?? EMPTY), ...next });
  notify();
}

export function installTodoState(ctx: PluginInstallContext): () => void {
  installed = ctx;
  const offItem = ctx.consoleEvents.subscribe("todo:item", (payload) => {
    const event = payload as TodoItemEvent | null;
    if (!event || typeof event.itemId !== "string" || typeof event.theaterId !== "string") return;
    const current = theaters.get(event.theaterId) ?? EMPTY;
    if (event.op === "remove") { setTheater(event.theaterId, { items: current.items.filter((item) => item.id !== event.itemId) }); return; }
    if (!event.item) return;
    const exists = current.items.some((item) => item.id === event.itemId);
    setTheater(event.theaterId, { items: exists ? current.items.map((item) => (item.id === event.itemId ? event.item! : item)) : [event.item, ...current.items] });
  });
  const offGroup = ctx.consoleEvents.subscribe("group:changed", (payload) => {
    const group = (payload as { group?: TodoGroup } | null)?.group;
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
    notify();
  });
  return () => { offItem(); offGroup(); offRemoved(); offConsole(); if (installed === ctx) installed = null; };
}

export function todoApi(): ClientApiCapability | null {
  return installed?.api ?? null;
}

export async function post<T>(api: ClientApiCapability, path: string, body: unknown): Promise<T> {
  const response = await api.fetch("todo", path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(payload?.error ?? `http_${response.status}`);
  return payload as T;
}

export function loadTheater(api: ClientApiCapability, theaterId: string, force = false): Promise<void> {
  const current = theaters.get(theaterId);
  if (current?.loaded && !force) return Promise.resolve();
  const pending = inflight.get(theaterId);
  if (pending) return pending;
  const task = post<{ items: TodoItem[]; groups: TodoGroup[]; launch: { available: boolean } }>(api, "/state", { theaterId })
    .then((state) => { setTheater(theaterId, { items: state.items, groups: [...state.groups].sort((a, b) => a.order - b.order), loaded: true, launchAvailable: state.launch.available }); })
    .catch(() => { setTheater(theaterId, { loaded: true }); })
    .finally(() => { inflight.delete(theaterId); });
  inflight.set(theaterId, task);
  return task;
}

export function subscribeTodo(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function readAllTheaters(): readonly TheaterState[] {
  return [...theaters.values()];
}

export function readTheater(theaterId: string | null): TheaterState {
  return theaterId ? theaters.get(theaterId) ?? EMPTY : EMPTY;
}

export function useTodoTheater(theaterId: string | null): TheaterState {
  return useSyncExternalStore(subscribeTodo, () => readTheater(theaterId), () => readTheater(theaterId));
}

export function operationSummaries(): readonly ConsoleOperationSummary[] {
  return operationsSnapshot;
}

export function useOperationSummaries(): readonly ConsoleOperationSummary[] {
  return useSyncExternalStore(subscribeTodo, operationSummaries, operationSummaries);
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
  return useSyncExternalStore(subscribeTodo, () => reveal, () => reveal);
}

export function focusOperation(operationId: string): void {
  // 할 일 표면은 닫고 간다 — 확장 표면이 무대를 덮은 채로는 옮겨간 Operation 이 보이지 않는다.
  if (installed?.surfaces.isOpen("todo")) installed.surfaces.closeSurface("todo");
  installed?.operations.focus(operationId);
}

export function openTodoSurface(): void {
  installed?.surfaces.open({ surfaceId: "todo" });
}

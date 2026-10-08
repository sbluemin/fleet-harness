
/**
 * Console Use 제스처 — 에이전트가 이 Console 을 쓴 호출 하나하나가 화면 어디에 닿았는지.
 *
 * 서버의 `console-use:call` 채널(caller·tool·summary·gesture·target·at)을 받아 두 곳이 읽는다:
 * 대상(사이드바 행·Theater 행·그룹 헤더·묶음 줄·묶음 머리·패널·레일 버튼)을 **감싸는 펄스**, 그룹 헤더의 **저자**(툴팁).
 * 내용은 오지 않는다 — 읽은 전사·diff·파일은 이 채널에 실리지 않는다. 호출자 쪽에는 아무것도
 * 적지 않는다: 캡션 배지와 레일이 이미 「쓰는 중」을 말하고, 무엇을 했는지는 대상이 말한다.
 * 표식은 잠깐이고(GAZE_MS / MARK_MS), 걷히기 직전 잠깐 `leaving` 이 되어 페이드할 틈을 준다.
 */

import type { OperationArchiveReceipt } from "@fleet-console/sdk/operations/browser";

export const CONSOLE_USE_CALL_CHANNEL = "console-use:call";
export const OPERATION_CLOSING_CHANNEL = "operation:closing";
/** 시선 표식이 남는 시간. 같은 대상에 잇단 읽기는 이 창 안에서 하나로 합쳐진다. */
export const GAZE_MS = 8_000;
/** 쓰기(input·press·create) 표식이 남는 시간 — 읽기보다 짧다. 사건은 순간이고 시선은 머문다. */
export const MARK_MS = 3_000;
/** 걷히기 전 페이드 시간. CSS 의 떠남 전이와 같은 값이어야 한다. */
export const LEAVE_MS = 220;

export type GestureKind = "gaze" | "input" | "press" | "create" | "wait";
export type GestureCaller = { readonly kind: "operation"; readonly operationId: string } | { readonly kind: "plugin"; readonly pluginId: string };
export type GestureTarget =
  | { readonly kind: "theater"; readonly theaterId: string }
  | { readonly kind: "operation"; readonly operationId: string }
  | { readonly kind: "group"; readonly groupId: string; readonly theaterId: string }
  | { readonly kind: "panel"; readonly panelId: string; readonly theaterId: string; readonly view?: string; readonly path?: string }
  | { readonly kind: "cluster"; readonly clusterId: string; readonly theaterId: string }
  | { readonly kind: "clusters"; readonly theaterId: string; readonly groupId?: string };

export interface ConsoleUseGesture {
  readonly caller: GestureCaller;
  readonly tool: string;
  readonly summary: string;
  readonly gesture: GestureKind;
  readonly target?: GestureTarget;
  /** 기여 도구의 레일 패널 — 대상이 패널이 아니어도 그 레일 아이콘이 함께 감싸인다. */
  readonly panelId?: string;
  readonly at: number;
}

/**
 * 에이전트가 Operation을 치웠다는 알림. Console Use의 닫기는 이제 보관이라 `archive`로 오고,
 * 보관 도입 전 서버가 보내던 삭제 receipt는 `deletion`으로 계속 받는다.
 */
export type ClosingByAgent =
  | {
    readonly kind: "archive";
    readonly receipt: OperationArchiveReceipt;
    readonly targetTitle: string;
    readonly by: GestureCaller & { readonly title?: string };
  }
  | {
    readonly kind: "deletion";
    readonly receipt: { readonly deletionId: string; readonly kind: "operation" | "theater"; readonly targetId: string; readonly expiresAt: number };
    readonly targetTitle: string;
    readonly by: GestureCaller & { readonly title?: string };
  };

/** 대상 하나를 감싸는 표식 — 제스처와, 걷히는 중인지. 같은 대상 재호출은 객체를 갈아 끼우되 도착을 다시 재생하지 않는다(클래스가 그대로라). */
export interface ConsoleUseWrap {
  readonly gesture: ConsoleUseGesture;
  readonly leaving: boolean;
}

const listeners = new Set<() => void>();
const operationWrap = new Map<string, ConsoleUseWrap>();
const theaterWrap = new Map<string, ConsoleUseWrap>();
const groupWrap = new Map<string, ConsoleUseWrap>();
const panelWrap = new Map<string, ConsoleUseWrap>();
/** 묶음 줄(cluster id) 하나, 그리고 Theater 별 묶음 목록(목록 읽기 — 줄들이 모인 머리가 감싸인다). */
const clusterWrap = new Map<string, ConsoleUseWrap>();
const clusterListWrap = new Map<string, ConsoleUseWrap>();
const WRAP_MAPS = [operationWrap, theaterWrap, groupWrap, panelWrap, clusterWrap, clusterListWrap] as const;
const groupCreator = new Map<string, ConsoleUseGesture>();
const closingListeners = new Set<(closing: ClosingByAgent) => void>();
let version = 0;
let sweeper: ReturnType<typeof setTimeout> | null = null;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function wrapTtl(gesture: ConsoleUseGesture): number {
  return gesture.gesture === "gaze" || gesture.gesture === "wait" ? GAZE_MS : MARK_MS;
}

/**
 * 만료 경계마다 깨어난다 — 걷히기 LEAVE_MS 전에 `leaving` 으로 갈아 끼우고, 만료에 지운다.
 * 1초 고정 주기로는 220ms 페이드 창을 맞출 수 없어 다음 경계까지의 시간을 계산해 잔다.
 * 부를 때마다 다시 잰다: 긴 시선(8초) 뒤에 짧은 누름(3초)이 오면 먼저 잡힌 타이머는 누름의 경계를 모른다.
 */
function scheduleSweep(): void {
  if (sweeper !== null) { clearTimeout(sweeper); sweeper = null; }
  const now = Date.now();
  let next = Number.POSITIVE_INFINITY;
  for (const map of WRAP_MAPS) {
    for (const wrap of map.values()) {
      const expiresAt = wrap.gesture.at + wrapTtl(wrap.gesture);
      const boundary = wrap.leaving ? expiresAt : expiresAt - LEAVE_MS;
      if (boundary < next) next = boundary;
    }
  }
  if (!Number.isFinite(next)) return;
  sweeper = setTimeout(() => {
    sweeper = null;
    const at = Date.now();
    let changed = false;
    for (const map of WRAP_MAPS) {
      for (const [key, wrap] of map) {
        const expiresAt = wrap.gesture.at + wrapTtl(wrap.gesture);
        if (at >= expiresAt) { map.delete(key); changed = true; }
        else if (!wrap.leaving && at >= expiresAt - LEAVE_MS) { map.set(key, { gesture: wrap.gesture, leaving: true }); changed = true; }
      }
    }
    if (changed) notify();
    scheduleSweep();
  }, Math.max(16, next - now));
}

export function isConsoleUseGesture(value: unknown): value is ConsoleUseGesture {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const caller = record.caller as Record<string, unknown> | undefined;
  return !!caller && typeof caller === "object" && (caller.kind === "operation" ? typeof caller.operationId === "string" : caller.kind === "plugin" && typeof caller.pluginId === "string")
    && typeof record.tool === "string" && typeof record.summary === "string" && typeof record.at === "number"
    && ["gaze", "input", "press", "create", "wait"].includes(String(record.gesture));
}

export function recordConsoleUseGesture(gesture: ConsoleUseGesture): void {
  const target = gesture.target;
  const wrap: ConsoleUseWrap = { gesture, leaving: false };
  if (target?.kind === "operation") {
    operationWrap.set(target.operationId, wrap);
    // 행이 감싸이면 그 Theater 의 링은 먼저 걷는다 — 두 겹이 겹치면 어느 쪽도 읽히지 않는다.
    const theaterId = operations().find((operation) => operation.id === target.operationId)?.theaterId;
    if (theaterId !== undefined) theaterWrap.delete(theaterId);
  } else if (target?.kind === "theater") theaterWrap.set(target.theaterId, wrap);
  else if (target?.kind === "panel") panelWrap.set(target.panelId, wrap);
  else if (target?.kind === "group") { if (gesture.gesture === "create") groupCreator.set(target.groupId, gesture); groupWrap.set(target.groupId, wrap); }
  else if (target?.kind === "cluster") clusterWrap.set(target.clusterId, wrap);
  else if (target?.kind === "clusters") clusterListWrap.set(target.theaterId, wrap);
  // 자리를 대신 말한 기여 도구도 레일 아이콘 표식은 그대로 둔다.
  if (typeof gesture.panelId === "string" && target?.kind !== "panel") panelWrap.set(gesture.panelId, wrap);
  notify();
  scheduleSweep();
}

/** 호출자를 사람이 읽는 이름으로 — Operation 은 제목, 플러그인은 id. 지워진 Operation 이면 id. */
export function gestureCallerLabel(caller: GestureCaller): string {
  if (caller.kind === "plugin") return caller.pluginId;
  return operations().find((operation) => operation.id === caller.operationId)?.title ?? caller.operationId;
}

export function subscribeConsoleUseGestures(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getGestureVersion(): number { return version; }

export function getOperationWrap(operationId: string): ConsoleUseWrap | null { return operationWrap.get(operationId) ?? null; }
export function getTheaterWrap(theaterId: string): ConsoleUseWrap | null { return theaterWrap.get(theaterId) ?? null; }
export function getGroupWrap(groupId: string): ConsoleUseWrap | null { return groupWrap.get(groupId) ?? null; }
export function getPanelWrap(panelId: string): ConsoleUseWrap | null { return panelWrap.get(panelId) ?? null; }
export function getClusterWrap(clusterId: string): ConsoleUseWrap | null { return clusterWrap.get(clusterId) ?? null; }
/** 여러 줄 중 먼저 감싸인 하나 — 접힌 머리가 그 안의 줄 대신 감싸일 때 쓴다. 저장된 객체를 그대로 돌려 스냅샷이 흔들리지 않는다. */
export function getFirstClusterWrap(clusterIds: readonly string[]): ConsoleUseWrap | null {
  for (const id of clusterIds) {
    const wrap = clusterWrap.get(id);
    if (wrap) return wrap;
  }
  return null;
}
/**
 * Theater 의 묶음 목록 표식. 그룹 하나로 좁힌 목록이면 그 그룹(`groupId`)에서만 답한다 — 그룹을 모르는 머리(구역)는 `undefined` 로 묻고,
 * Theater 전체 목록에만 감싸인다.
 */
export function getClusterListWrap(theaterId: string, groupId?: string | null): ConsoleUseWrap | null {
  const wrap = clusterListWrap.get(theaterId);
  if (!wrap) return null;
  const scoped = wrap.gesture.target?.kind === "clusters" ? wrap.gesture.target.groupId : undefined;
  return scoped === undefined || scoped === groupId ? wrap : null;
}
/** 그룹으로 좁혔든 아니든 그 Theater 의 묶음 목록 표식 — 줄과 머리가 모두 접혀 Theater 머리만 보일 때. */
export function getAnyClusterListWrap(theaterId: string): ConsoleUseWrap | null { return clusterListWrap.get(theaterId) ?? null; }
export function getGroupCreator(groupId: string): ConsoleUseGesture | null {
  return groupCreator.get(groupId) ?? null;
}

/** 감싸인 요소에 얹는 클래스 — 없으면 빈 문자열. 종류(gesture)와 떠남만 가른다; 색·리듬은 CSS 한 벌이다. */
export function consoleUseWrapClassName(wrap: ConsoleUseWrap | null): string {
  if (!wrap) return "";
  return `is-console-use-wrapped is-${wrap.gesture.gesture}${wrap.leaving ? " is-leaving" : ""}`;
}

/** 감싸인 요소의 이름표 — "누가: 무엇". */
export function consoleUseWrapLabel(wrap: ConsoleUseWrap): string {
  return `${gestureCallerLabel(wrap.gesture.caller)}: ${wrap.gesture.summary}`;
}

export function subscribeClosingByAgent(listener: (closing: ClosingByAgent) => void): () => void {
  closingListeners.add(listener);
  return () => { closingListeners.delete(listener); };
}

function readClosingByAgent(value: unknown): ClosingByAgent | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const receipt = record.receipt as Record<string, unknown> | undefined;
  if (!receipt || typeof receipt !== "object" || !record.by || typeof record.by !== "object" || typeof receipt.targetId !== "string") return null;
  const by = record.by as ClosingByAgent["by"];
  const targetTitle = typeof record.targetTitle === "string" ? record.targetTitle : receipt.targetId;
  if (typeof receipt.archiveId === "string" && Array.isArray(receipt.operationIds) && typeof receipt.rootOperationId === "string") {
    return { kind: "archive", receipt: receipt as unknown as OperationArchiveReceipt, targetTitle, by };
  }
  if (typeof receipt.deletionId === "string" && typeof receipt.expiresAt === "number" && (receipt.kind === "operation" || receipt.kind === "theater")) {
    return { kind: "deletion", receipt: { deletionId: receipt.deletionId, kind: receipt.kind, targetId: receipt.targetId, expiresAt: receipt.expiresAt }, targetTitle, by };
  }
  return null;
}

interface GestureServices {
  readonly operations: () => readonly { readonly id: string; readonly theaterId: string; readonly title: string }[];
  readonly subscribeConsoleChannel: (channel: string, listener: (payload: unknown) => void) => () => void;
}
let operations: GestureServices["operations"] = () => [];
let installed = false;
/** 앱이 한 번 부른다 — SSE 채널을 스토어에 잇는다. 재연결마다 채널은 다시 붙고 구독자는 남는다. */
export function installConsoleUseGestures(services: GestureServices): () => void {
  if (installed) return () => undefined;
  installed = true;
  operations = services.operations;
  const { subscribeConsoleChannel } = services;
  const disposeCalls = subscribeConsoleChannel(CONSOLE_USE_CALL_CHANNEL, (payload) => { if (isConsoleUseGesture(payload)) recordConsoleUseGesture(payload); });
  const disposeClosing = subscribeConsoleChannel(OPERATION_CLOSING_CHANNEL, (payload) => {
    const closing = readClosingByAgent(payload);
    if (!closing) return;
    for (const listener of closingListeners) listener(closing);
  });
  return () => { installed = false; operations = () => []; disposeCalls(); disposeClosing(); };
}

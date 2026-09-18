import { subscribeConsoleChannel } from "./operations-sse.js";
import { getState } from "./store.js";

/**
 * Console Use 제스처 — 에이전트가 이 Console 을 쓴 호출 하나하나가 화면 어디에 닿았는지.
 *
 * 서버의 `console-use:call` 채널(caller·tool·summary·gesture·target·at)을 받아 세 곳이 읽는다:
 * 대상(사이드바 행·캡션·패널 테두리·레일 아이콘)의 **시선 표식**, 호출자 패널 캡션 아래의 **자막**,
 * 그룹 헤더의 **저자**. 내용은 오지 않는다 — 읽은 전사·diff·파일은 이 채널에 실리지 않는다.
 * 표식은 잠깐이고(GAZE_MS) 자막은 세션 동안 최근 것만 남는다. 별도 이력 패널은 없다.
 */

export const CONSOLE_USE_CALL_CHANNEL = "console-use:call";
export const OPERATION_CLOSING_CHANNEL = "operation:closing";
/** 시선 표식이 남는 시간. 같은 대상에 잇단 읽기는 이 창 안에서 하나로 합쳐진다. */
export const GAZE_MS = 8_000;
/** 쓰기 귀속 표식(이름 밑줄·버튼 눌림)이 남는 시간. */
export const MARK_MS = 3_000;
const STRIP_KEEP = 6;
/** 캡션의 "○○ 이 시작" 은 첫 몇 분 동안만 — 계보는 payload 에 영원히 남지만 표식은 잠깐이다. */
export const LAUNCH_ATTRIBUTION_MS = 10 * 60_000;

export type GestureKind = "gaze" | "input" | "press" | "create" | "wait";
export type GestureCaller = { readonly kind: "operation"; readonly operationId: string } | { readonly kind: "plugin"; readonly pluginId: string };
export type GestureTarget =
  | { readonly kind: "theater"; readonly theaterId: string }
  | { readonly kind: "operation"; readonly operationId: string }
  | { readonly kind: "group"; readonly groupId: string; readonly theaterId: string }
  | { readonly kind: "panel"; readonly panelId: string; readonly theaterId: string; readonly view?: string; readonly path?: string };

export interface ConsoleUseGesture {
  readonly caller: GestureCaller;
  readonly tool: string;
  readonly summary: string;
  readonly gesture: GestureKind;
  readonly target?: GestureTarget;
  readonly at: number;
}

export interface ClosingByAgent {
  readonly deletionId: string;
  readonly kind: "operation" | "theater";
  readonly targetId: string;
  readonly expiresAt: number;
  readonly targetTitle: string;
  readonly by: GestureCaller & { readonly title?: string };
}

const listeners = new Set<() => void>();
const operationGaze = new Map<string, ConsoleUseGesture>();
const theaterScan = new Map<string, ConsoleUseGesture>();
const panelGaze = new Map<string, ConsoleUseGesture>();
const groupCreator = new Map<string, ConsoleUseGesture>();
const callerStrip = new Map<string, readonly ConsoleUseGesture[]>();
const closingListeners = new Set<(closing: ClosingByAgent) => void>();
let version = 0;
let sweeper: ReturnType<typeof setTimeout> | null = null;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** 만료된 표식을 걷는다 — 구독자가 같은 스냅숏을 다시 읽지 않도록 버전만 올린다. */
function scheduleSweep(): void {
  if (sweeper !== null) return;
  sweeper = setTimeout(() => {
    sweeper = null;
    const now = Date.now();
    let changed = false;
    for (const [key, gesture] of operationGaze) if (now - gesture.at > GAZE_MS) { operationGaze.delete(key); changed = true; }
    for (const [key, gesture] of theaterScan) if (now - gesture.at > GAZE_MS) { theaterScan.delete(key); changed = true; }
    for (const [key, gesture] of panelGaze) if (now - gesture.at > GAZE_MS) { panelGaze.delete(key); changed = true; }
    if (changed) notify();
    if (operationGaze.size || theaterScan.size || panelGaze.size) scheduleSweep();
  }, 1_000);
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
  if (target?.kind === "operation") operationGaze.set(target.operationId, gesture);
  else if (target?.kind === "theater") theaterScan.set(target.theaterId, gesture);
  else if (target?.kind === "panel") panelGaze.set(target.panelId, gesture);
  else if (target?.kind === "group") { if (gesture.gesture === "create") groupCreator.set(target.groupId, gesture); theaterScan.set(target.theaterId, gesture); }
  const key = callerKey(gesture.caller);
  callerStrip.set(key, [...(callerStrip.get(key) ?? []), gesture].slice(-STRIP_KEEP));
  notify();
  scheduleSweep();
}

function callerKey(caller: GestureCaller): string {
  return caller.kind === "operation" ? `operation:${caller.operationId}` : `plugin:${caller.pluginId}`;
}

/** 호출자를 사람이 읽는 이름으로 — Operation 은 제목, 플러그인은 id. 지워진 Operation 이면 id. */
export function gestureCallerLabel(caller: GestureCaller): string {
  if (caller.kind === "plugin") return caller.pluginId;
  return getState().operations.find((operation) => operation.id === caller.operationId)?.title ?? caller.operationId;
}

export function subscribeConsoleUseGestures(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getGestureVersion(): number { return version; }

export function getOperationGaze(operationId: string): ConsoleUseGesture | null {
  const gesture = operationGaze.get(operationId);
  return gesture && Date.now() - gesture.at <= GAZE_MS ? gesture : null;
}
export function getTheaterScan(theaterId: string): ConsoleUseGesture | null {
  const gesture = theaterScan.get(theaterId);
  return gesture && Date.now() - gesture.at <= GAZE_MS ? gesture : null;
}
export function getPanelGaze(panelId: string): ConsoleUseGesture | null {
  const gesture = panelGaze.get(panelId);
  return gesture && Date.now() - gesture.at <= GAZE_MS ? gesture : null;
}
export function getGroupCreator(groupId: string): ConsoleUseGesture | null {
  return groupCreator.get(groupId) ?? null;
}
const EMPTY_STRIP: readonly ConsoleUseGesture[] = [];
/** useSyncExternalStore 가 같은 스냅숏을 다시 받아야 하므로 빈 값은 상수다. */
export function getCallerStrip(operationId: string): readonly ConsoleUseGesture[] {
  return callerStrip.get(`operation:${operationId}`) ?? EMPTY_STRIP;
}

/** 캡션의 "○○ 이 시작" — payload.launchedBy 가 있고 만든 지 얼마 안 된 Operation 만. */
export function readLaunchAttribution(payload: Record<string, unknown> | undefined, createdAt: number): GestureCaller | null {
  const raw = payload?.launchedBy;
  if (!raw || typeof raw !== "object" || Date.now() - createdAt > LAUNCH_ATTRIBUTION_MS) return null;
  const record = raw as Record<string, unknown>;
  if (record.kind === "operation" && typeof record.operationId === "string") return { kind: "operation", operationId: record.operationId };
  if (record.kind === "plugin" && typeof record.pluginId === "string") return { kind: "plugin", pluginId: record.pluginId };
  return null;
}

export function subscribeClosingByAgent(listener: (closing: ClosingByAgent) => void): () => void {
  closingListeners.add(listener);
  return () => { closingListeners.delete(listener); };
}

function isClosingByAgent(value: unknown): value is { readonly receipt: { readonly deletionId: string; readonly kind: "operation" | "theater"; readonly targetId: string; readonly expiresAt: number }; readonly targetTitle?: unknown; readonly by: ClosingByAgent["by"] } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const receipt = record.receipt as Record<string, unknown> | undefined;
  return !!receipt && typeof receipt === "object" && typeof receipt.deletionId === "string" && typeof receipt.targetId === "string" && typeof receipt.expiresAt === "number" && (receipt.kind === "operation" || receipt.kind === "theater") && !!record.by && typeof record.by === "object";
}

let installed = false;
/** 앱이 한 번 부른다 — SSE 채널을 스토어에 잇는다. 재연결마다 채널은 다시 붙고 구독자는 남는다. */
export function installConsoleUseGestures(): () => void {
  if (installed) return () => undefined;
  installed = true;
  const disposeCalls = subscribeConsoleChannel(CONSOLE_USE_CALL_CHANNEL, (payload) => { if (isConsoleUseGesture(payload)) recordConsoleUseGesture(payload); });
  const disposeClosing = subscribeConsoleChannel(OPERATION_CLOSING_CHANNEL, (payload) => {
    if (!isClosingByAgent(payload)) return;
    const closing: ClosingByAgent = { ...payload.receipt, targetTitle: typeof payload.targetTitle === "string" ? payload.targetTitle : payload.receipt.targetId, by: payload.by };
    for (const listener of closingListeners) listener(closing);
  });
  return () => { installed = false; disposeCalls(); disposeClosing(); };
}

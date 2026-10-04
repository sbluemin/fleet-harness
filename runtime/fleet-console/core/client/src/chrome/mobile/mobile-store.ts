import { useSyncExternalStore } from "react";

import type { StatusGlyphState } from "@fleet-console/sdk/components/status-glyph";
import type { MobileBarAction, MobileBarMenuItem } from "@fleet-console/sdk/pane";

/**
 * 모바일 셸의 클라이언트 상태. 라우트(/operations·/theaters·/settings)가 큰 자리를 정하고, 이 스토어는
 * 그 안쪽 — 드로어, 하단 시트, 상단 막대, /operations 안의 목적지 — 을 든다. 본문·PTY의 수명은
 * 기존 페인/표면 소유자가 지킨다.
 */

type Listener = () => void;
const listeners = new Set<Listener>();
function emit(): void { for (const listener of listeners) listener(); }
function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── /operations 안의 목적지 ──────────────────────────────────────────────

/**
 * `home`은 Operation 화면(또는 Operation이 없을 때의 빈 홈)이다. 나머지는 드로어가 여는 전체 화면이다.
 * Theater·설정은 라우트라 여기 없다.
 */
export type MobileDestination =
  | { readonly kind: "home" }
  | { readonly kind: "attention" }
  | { readonly kind: "plugins" }
  | { readonly kind: "plugin"; readonly entryId: string };

let destination: MobileDestination = { kind: "home" };

export function useMobileDestination(): MobileDestination {
  return useSyncExternalStore(subscribe, () => destination);
}

export function getMobileDestination(): MobileDestination { return destination; }

export function setMobileDestination(next: MobileDestination): void {
  if (destination.kind === next.kind && (destination as { entryId?: string }).entryId === (next as { entryId?: string }).entryId) return;
  destination = next;
  emit();
}

// ── 도구 시트(목적지가 아닌 레일 엔트리·확대 표면) ────────────────────────

export type MobileTool = { readonly kind: "rail"; readonly id: string } | { readonly kind: "surface"; readonly instanceId: string };
let activeTool: MobileTool | null = null;
// 모바일 목적지로 선언된 레일 엔트리 — 호스트가 레지스트리에서 읽어 갱신한다. 이 id를 연 요청은 시트가 아니라 화면으로 선다.
let destinationEntryIds: ReadonlySet<string> = new Set();

export function useMobileTool(): MobileTool | null {
  return useSyncExternalStore(subscribe, () => activeTool);
}

/** 도구 시트의 선택만 보관한다. 목적지로 선언된 엔트리는 시트 대신 목적지 화면이 된다. */
export function setMobileTool(next: MobileTool | null): void {
  if (next?.kind === "rail" && destinationEntryIds.has(next.id)) {
    activeTool = null;
    setMobileDestination({ kind: "plugin", entryId: next.id });
    emit();
    return;
  }
  activeTool = next;
  if (next !== null) setMobileDestination({ kind: "plugins" });
  emit();
}

export function registerMobileDestinationEntries(ids: ReadonlySet<string>): void {
  if (ids.size === destinationEntryIds.size && [...ids].every((id) => destinationEntryIds.has(id))) return;
  destinationEntryIds = ids;
}

// ── 드로어 ───────────────────────────────────────────────────────────────

let drawerOpen = false;

export function useMobileDrawerOpen(): boolean {
  return useSyncExternalStore(subscribe, () => drawerOpen);
}
export function getMobileDrawerOpen(): boolean { return drawerOpen; }
export function setMobileDrawerOpen(next: boolean): void {
  if (drawerOpen === next) return;
  drawerOpen = next;
  emit();
}

// ── 하단 시트 ────────────────────────────────────────────────────────────

/** 시트 종류. 시트에서 시트를 열면 쌓이고, 닫기·스크림은 앞 시트로 돌아간다. */
export type MobileSheetKind =
  | { readonly kind: "theater" }
  | { readonly kind: "folder" }
  | { readonly kind: "console" }
  | { readonly kind: "forget"; readonly theaterId: string }
  | { readonly kind: "rename"; readonly operationId: string };

let sheetStack: readonly MobileSheetKind[] = [];

export function useMobileSheetStack(): readonly MobileSheetKind[] {
  return useSyncExternalStore(subscribe, () => sheetStack);
}
export function getMobileSheetStack(): readonly MobileSheetKind[] { return sheetStack; }
export function pushMobileSheet(sheet: MobileSheetKind): void {
  sheetStack = [...sheetStack, sheet];
  emit();
}
/** 맨 위 시트만 닫는다 — 앞 시트가 있으면 그리로 돌아간다. */
export function popMobileSheet(): void {
  if (sheetStack.length === 0) return;
  sheetStack = sheetStack.slice(0, -1);
  emit();
}
/** 동작을 끝내는 버튼(시작·저장·추가)은 쌓인 시트를 모두 닫는다. */
export function closeMobileSheets(): void {
  if (sheetStack.length === 0) return;
  sheetStack = [];
  emit();
}

// ── 상단 막대 ────────────────────────────────────────────────────────────

export interface MobileBarState {
  /** `operation`은 왼쪽 정렬 제목(글리프 + 두 줄), `centered`는 가운데 제목이다. */
  readonly variant: "centered" | "operation";
  readonly title: string;
  readonly subtitle?: string;
  /** operation 변형의 상태 글리프. */
  readonly glyph?: StatusGlyphState;
  readonly leading: "menu" | "back";
  readonly onBack?: () => void;
  /** 화면이 자기 머리를 그릴 때(도구 시트) 막대를 숨긴다. */
  readonly hidden?: boolean;
  readonly actions?: readonly MobileBarAction[];
  readonly menu?: { readonly label: string; readonly caption?: string; readonly items: readonly MobileBarMenuItem[] };
}

interface BarSlot { readonly owner: symbol; readonly state: MobileBarState }
let bar: BarSlot | null = null;
// 렌더가 보는 `bar.state`는 내용이 바뀔 때만 새로 서고, 클릭이 부르는 동작은 항상 가장 최근 렌더의 클로저다.
let liveBar: MobileBarState | null = null;

export function getLiveMobileBar(): MobileBarState | null { return liveBar; }

export function useMobileBar(): MobileBarState | null {
  return useSyncExternalStore(subscribe, () => bar?.state ?? null);
}

function barSignature(state: MobileBarState): string {
  return JSON.stringify({
    v: state.variant, t: state.title, s: state.subtitle, g: state.glyph, l: state.leading, b: state.onBack !== undefined, h: state.hidden === true,
    a: state.actions?.map((action) => [action.id, action.label]),
    m: state.menu ? [state.menu.label, state.menu.caption, state.menu.items.map((item) => [item.id, item.label, item.destructive, item.disabled])] : null,
  });
}

/**
 * 화면이 자기 막대를 올린다. 같은 소유자가 같은 내용을 다시 올리면 구독자를 깨우지 않는다 —
 * 단 동작 클로저는 항상 최신으로 바꿔 둔다(그래서 렌더마다 불러도 된다).
 */
export function claimMobileBar(owner: symbol, state: MobileBarState): void {
  liveBar = state;
  if (bar?.owner === owner && barSignature(bar.state) === barSignature(state)) return;
  bar = { owner, state };
  emit();
}

export function releaseMobileBar(owner: symbol): void {
  if (bar?.owner !== owner) return;
  bar = null;
  liveBar = null;
  emit();
}

// 막대가 비워 두는 자리 — 화면이 자기 노드를 포털로 끼운다(Operation 캡션 동작: 채팅↔터미널 전환).
// 노드를 상태에 담지 않는 이유는 플러그인이 다시 그릴 때마다 막대가 따라 깨어나야 하기 때문이다.
let extraSlot: HTMLElement | null = null;
export function useMobileBarExtraSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => extraSlot);
}
export function setMobileBarExtraSlot(element: HTMLElement | null): void {
  if (extraSlot === element) return;
  extraSlot = element;
  emit();
}

// 플러그인 목적지 화면이 쌓아 둔 상세 깊이 — 루트 이동 전에 걷어야 하는 history 항목 수(S-51).
let pluginDepth = 0;
export function getMobilePluginDepth(): number { return pluginDepth; }
export function setMobilePluginDepth(next: number): void { pluginDepth = next; }

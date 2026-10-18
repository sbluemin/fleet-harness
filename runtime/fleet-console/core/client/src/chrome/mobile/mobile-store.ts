import { useSyncExternalStore, type ReactNode } from "react";

import type { MobileConfirmSpec } from "@fleet-console/sdk/plugin";
import type { MobileBarAction, MobileBarMenuItem } from "@fleet-console/sdk/pane";

import type { ConversationPillTakeover } from "../../../../../features/workspace/client/conversation/conversation-slots.js";


/**
 * 모바일 셸의 클라이언트 상태. 라우트(/operations·/settings)가 큰 자리를 정하고, 이 스토어는
 * 그 안쪽 — 하단 시트, 상단 막대, /operations 안의 목적지 — 을 든다. 본문·PTY의 수명은
 * 기존 페인/표면 소유자가 지킨다.
 */

type Listener = () => void;
const listeners = new Set<Listener>();
function emit(): void { for (const listener of listeners) listener(); }
function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 모바일 대화 목록의 Theater 필터만 기억한다. 데스크톱 동작·Operation 수명과 무관하며 영속화하지 않는다. */
let mobileListTheaterId: string | null = null;
export function getMobileListTheaterId(): string | null { return mobileListTheaterId; }
export function setMobileListTheaterId(theaterId: string | null): void {
  if (mobileListTheaterId === theaterId) return;
  mobileListTheaterId = theaterId;
  emit();
}
export function subscribeMobileState(listener: () => void): () => void { return subscribe(listener); }

// ── /operations 안의 목적지 ──────────────────────────────────────────────

/**
 * `home`은 대화 목록(열린 Operation이 있으면 그 Operation 화면)이다. 나머지는 홈의 바로가기 칩·검색·확인 필요가 여는 전체 화면이다.
 * Theater·설정은 라우트라 여기 없다.
 */
export type MobileDestination =
  | { readonly kind: "home" }
  /**
   * 열린 Operation(대화)의 정보 화면 — Operation 화면 머리 pill이 연다. 열린 Operation이 없으면 홈(대화 목록)으로 읽힌다.
   * `tab`은 처음 세울 탭(엔트리의 `mobile.conversationPane`으로 오는 착지) — 생략하면 「정보」 탭이다.
   */
  | { readonly kind: "info"; readonly tab?: string }
  | { readonly kind: "attention" }
  | { readonly kind: "archive" }
  | { readonly kind: "search"; readonly scope?: "archive" }
  | { readonly kind: "plugins" }
  /**
   * 플러그인 목적지 화면. `params`는 그 화면 primary 페인의 주소(`PaneContext.params`) — 페인이 `panes.replaceParams`로 대상을 바꾸면
   * 화면이 여기에 옮겨 적고, 새로고침·딥링크는 그 params로 페인을 다시 연다(`?dest=plugin:<엔트리>?<params>`).
   */
  | { readonly kind: "plugin"; readonly entryId: string; readonly params?: Readonly<Record<string, string>> };

// 새로고침해도 보던 목적지를 잃지 않게 주소(`?dest=`)에 남긴다 — 첫 화면(IA-G2)은 앱을 새로 열 때의 기본이고, 새로고침은 그 자리 유지다.
const DEST_PARAM = "dest";

function readDestinationFromUrl(): MobileDestination {
  if (typeof window === "undefined") return { kind: "home" };
  const raw = new URLSearchParams(window.location.search).get(DEST_PARAM);
  if (raw === "search:archive") return { kind: "search", scope: "archive" };
  if (raw === "attention" || raw === "archive" || raw === "search" || raw === "plugins" || raw === "info") return { kind: raw };
  if (raw !== null && raw.startsWith("info:") && raw.length > 5) return { kind: "info", tab: raw.slice(5) };
  if (raw !== null && raw.startsWith("plugin:") && raw.length > 7) {
    const [entryId = "", query] = splitOnce(raw.slice(7), "?");
    const params = query === undefined ? {} : Object.fromEntries(new URLSearchParams(query));
    if (entryId) return Object.keys(params).length > 0 ? { kind: "plugin", entryId, params } : { kind: "plugin", entryId };
  }
  return { kind: "home" };
}

export function syncMobileDestinationUrl(): void { writeDestinationToUrl(destination); }

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator);
  return index < 0 ? [value, undefined] : [value.slice(0, index), value.slice(index + 1)];
}

/** 목적지 params의 주소 꼬리 — 키 순서를 고정해 같은 params가 같은 주소가 되게 한다. */
function paramsSuffix(params: Readonly<Record<string, string>> | undefined): string {
  if (!params) return "";
  const query = new URLSearchParams(Object.entries(params).sort(([left], [right]) => left.localeCompare(right))).toString();
  return query ? `?${query}` : "";
}

function writeDestinationToUrl(next: MobileDestination): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const value = next.kind === "home" ? null : next.kind === "plugin" ? `plugin:${next.entryId}${paramsSuffix(next.params)}` : next.kind === "search" && next.scope === "archive" ? "search:archive"
    : next.kind === "info" && next.tab !== undefined ? `info:${next.tab}` : next.kind;
  if ((url.searchParams.get(DEST_PARAM)) === value) return;
  if (value === null) url.searchParams.delete(DEST_PARAM);
  else url.searchParams.set(DEST_PARAM, value);
  window.history.replaceState(window.history.state, "", url);
}

let destination: MobileDestination = readDestinationFromUrl();
// 목적지의 Theater는 홈으로 돌아가도 이어진다. 영속 저장소 대신 복원한 주소에서 목록 필터를 시작한다.
if (destination.kind === "plugin" && destination.params?.theaterId) mobileListTheaterId = destination.params.theaterId;

export function useMobileDestination(): MobileDestination {
  return useSyncExternalStore(subscribe, () => destination);
}

export function getMobileDestination(): MobileDestination { return destination; }

export function setMobileDestination(next: MobileDestination): void {
  if (destination.kind === next.kind && (destination as { entryId?: string }).entryId === (next as { entryId?: string }).entryId && (destination as { scope?: string }).scope === (next as { scope?: string }).scope
    && (destination as { tab?: string }).tab === (next as { tab?: string }).tab
    && paramsSuffix((destination as { params?: Readonly<Record<string, string>> }).params) === paramsSuffix((next as { params?: Readonly<Record<string, string>> }).params)) return;
  destination = next;
  if (next.kind === "plugin" && next.params?.theaterId) mobileListTheaterId = next.params.theaterId;
  writeDestinationToUrl(next);
  emit();
}

/** 진입점이 보던 Theater를 목적지 주소에 함께 싣는다. null이면 Theater 없는 목적지다. */
export function openMobilePluginDestination(entryId: string, theaterId: string | null): void {
  setMobileDestination({ kind: "plugin", entryId, ...(theaterId === null ? {} : { params: { theaterId } }) });
}

/** 대화 정보 화면에서 엔트리(`mobile.conversationPane`)가 세우는 탭의 id — 착지 요청과 탭 목록이 같은 id를 쓴다. */
export function conversationTabId(entryId: string): string {
  return `entry:${entryId}`;
}

/**
 * 대화를 열면서 그 정보 화면의 탭으로 착지하라는 한 번짜리 요청. 대화 열기는 포커스 요청(`focusOperation`)을 거쳐 Operations 화면이
 * 소비하며 목적지를 홈으로 되돌리므로, 그 소비가 같은 대화에 대해 이 요청을 집어 정보 화면으로 세운다. 다른 대화의 소비는 요청을 버린다.
 */
let pendingConversationTab: { readonly operationId: string; readonly tab: string } | null = null;

export function requestMobileConversationTab(operationId: string, tab: string): void {
  pendingConversationTab = { operationId, tab };
}

/** 대화 열기 요청을 소비할 때의 목적지 — 그 대화에 걸린 탭 요청이 있으면 정보 화면, 아니면 홈. */
export function takeMobileConversationDestination(operationId: string): MobileDestination {
  const pending = pendingConversationTab;
  pendingConversationTab = null;
  return pending?.operationId === operationId ? { kind: "info", tab: pending.tab } : { kind: "home" };
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
export function setMobileTool(next: MobileTool | null, theaterId: string | null = null): void {
  if (next?.kind === "rail" && destinationEntryIds.has(next.id)) {
    activeTool = null;
    // 이미 그 목적지 화면이면 주소(params)를 지킨다 — 화면이 마운트하며 다시 여는 길이 복원한 params를 지우지 않게.
    if (!(destination.kind === "plugin" && destination.entryId === next.id)) openMobilePluginDestination(next.id, theaterId);
    emit();
    return;
  }
  // 목적지 화면(Shell 등 확대 표면 엔트리)이 서 있는 동안 연 표면은 그 화면이 본문으로 쓴다 — 도구 시트로 바꾸지 않는다.
  if (next?.kind === "surface" && destination.kind === "plugin") {
    activeTool = null;
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

// ── 하단 시트 ────────────────────────────────────────────────────────────

/** 시트 종류. 시트에서 시트를 열면 쌓이고, 닫기·스크림은 앞 시트로 돌아간다. */
export type MobileSheetKind =
  | { readonly kind: "theater" }
  /** 홈 머리 프로필 아바타가 여는 프로필·설정 시트 — Console 정체 카드와 설정 목록. 섹션 상세는 `/settings` 라우트다. */
  | { readonly kind: "profile" }
  | { readonly kind: "folder" }
  /** 홈 머리의 +: 새 대화 · 새 터미널 · Theater 추가. */
  | { readonly kind: "create" }
  | { readonly kind: "console" }
  /** 호스트 밖 기능(설정 섹션 등)이 자기 시트를 호스트의 쌓기·뒤로·스크림에 태운다. `render`는 `MobileSheet`를 그리고 닫기 함수를 받는다. */
  | { readonly kind: "custom"; readonly render: (close: () => void) => ReactNode }
  | { readonly kind: "confirm"; readonly spec: MobileConfirmSpec; readonly resolve: (confirmed: boolean) => void }
  | { readonly kind: "forget"; readonly theaterId: string }
  /** S-07 행을 길게 누르면 서는 그 Theater 의 동작 — 데스크톱 머리 메뉴와 같은 항목이다. 별칭·새 그룹은 그 위에 입력 시트를 쌓는다. */
  | { readonly kind: "theater-actions"; readonly theaterId: string }
  | { readonly kind: "theater-alias"; readonly theaterId: string }
  | { readonly kind: "theater-group"; readonly theaterId: string }
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
  /** `centered`는 가운데 제목, `conversation`은 ‹ · 아바타와 제목이 든 pill · ⋮ 이다. */
  readonly variant: "centered" | "conversation";
  /**
   * conversation 변형의 pill — 누르면 대화 정보 화면이 열린다. `key`가 바뀌면(아바타 얼굴·제목·상태 줄) 막대를 다시 그린다.
   * `takeover`는 본문이 덮는 화면(그룹 대화의 전언 대화 화면)이 잠깐 바꾼 내용이다 — 그동안 pill은 단추가 아니라 그 내용을 담는 틀이다.
   */
  readonly pill?: { readonly key: string; readonly label: string; readonly node: ReactNode; readonly onPress: () => void; readonly takeover?: ConversationPillTakeover | null };
  readonly title: string;
  readonly subtitle?: string;
  /** 왼쪽 단추는 늘 ‹이다 — 홈(대화 목록)이 루트라 ≡가 열 메뉴는 없다. `onBack`이 없으면 history 뒤로이고, 마지막 가드에서 홈으로 간다. */
  readonly leading: "back";
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
    v: state.variant, p: state.pill?.key, t: state.title, s: state.subtitle, l: state.leading, b: state.onBack !== undefined, h: state.hidden === true,
    a: state.actions?.map((action) => [action.id, action.label]),
    // 스위치 행의 켬/끔도 내용이다 — 빠지면 열린 ⋮가 누른 뒤에도 이전 상태를 그린다.
    m: state.menu ? [state.menu.label, state.menu.caption, state.menu.items.map((item) => [item.id, item.label, item.destructive, item.disabled, item.checked])] : null,
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

// Operation 본문이 ⋮에 끼운 항목 — 세션 화면이 다시 마운트돼도 본문은 살아 있으므로 Operation별로 스토어에 둔다.
const operationMenus = new Map<string, readonly MobileBarMenuItem[]>();
const EMPTY_ITEMS: readonly MobileBarMenuItem[] = [];
export function useMobileOperationMenu(operationId: string): readonly MobileBarMenuItem[] {
  return useSyncExternalStore(subscribe, () => operationMenus.get(operationId) ?? EMPTY_ITEMS);
}
export function setMobileOperationMenu(operationId: string, items: readonly MobileBarMenuItem[]): void {
  if (items.length === 0) operationMenus.delete(operationId);
  else operationMenus.set(operationId, items);
  emit();
}

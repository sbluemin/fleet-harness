import { useSyncExternalStore } from "react";

/* 레일은 단일 활성 패널 슬롯에서 다중 고정(pin) 스택으로 개편됐다(전면 해도 개편 P3).
   - pinnedPanelIds: 카드에 상주하는 패널들. 순서가 곧 스택 순서다. localStorage에 영속.
   - collapsedPanelIds: 접힌 섹션. 세션 메모리 전용 — 새 페이지 로드는 전부 펼침으로 시작한다
     (사이드바 STATUS 축과 같은 비영속 계약).
   - push/overlay 이원은 퇴역했다: 부유 카드 레일에는 밀어낼 그리드 트랙이 없다. 구 push의
     "콘텐츠를 가리지 않는다"는 기대는 아레나 인셋이 승계한다 — 열린 패널 폭이 캔버스 아레나에서
     항상 제외되므로 fit-all·Tactical 슬롯·War Room 무대가 패널을 피해 계산된다. */
interface RailStore {
  readonly pinnedPanelIds: readonly string[];
  readonly collapsedPanelIds: readonly string[];
  readonly railChromeExpanded: boolean;
  readonly panelExtraWidths: Readonly<Record<string, number>>;
  readonly overlayAlpha: RailOverlayAlpha;
  /** 레일 카드가 캔버스 위에서 점유하는 실측 폭(px) — RightRail이 보고하고 아레나 계산이 소비한다. */
  readonly railOccupiedPx: number;
}

export type RailOverlayAlpha = number;

export const RAIL_OVERLAY_ALPHA_MIN = 40;
export const RAIL_OVERLAY_ALPHA_MAX = 100;
export const RAIL_OVERLAY_ALPHA_DEFAULT = 100;

type Listener = () => void;
const PREFS_PINNED_PANELS = "fleet-console.rail.pinnedPanels";
const LEGACY_PREFS_ACTIVE_PANEL = "fleet-console.rail.activePanelId";
const PREFS_CHROME_EXPANDED = "fleet-console.rail.chromeExpanded";
const PREFS_OVERLAY_ALPHA = "fleet-console.rail.overlayAlpha";
const PREFS_REPOSITORY_SOURCE = "fleet-console.repository.source";
const listeners = new Set<Listener>();
let store: RailStore = {
  pinnedPanelIds: readStoredPinnedPanels(),
  collapsedPanelIds: [],
  railChromeExpanded: readStoredChromeExpanded(),
  panelExtraWidths: {},
  overlayAlpha: readStoredOverlayAlpha(),
  railOccupiedPx: 0,
};

export function subscribeRailStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getRailStoreSnapshot(): RailStore {
  return store;
}

/** 아이콘 클릭의 토글 — 고정돼 있으면 내리고, 아니면 고정하고 펼친다. */
export function toggleRailPanel(id: string): void {
  if (store.pinnedPanelIds.includes(id)) {
    unpinRailPanel(id);
    return;
  }
  pinRailPanel(id);
}

/** Ensure-open(팔레트·플러그인 capability): 고정을 보장하고 접혀 있으면 펼친다. 절대 닫지 않는다. */
export function openRailPanel(id: string): void {
  pinRailPanel(id);
}

export function closeRailPanel(id: string): void {
  unpinRailPanel(id);
}

export function toggleRailSectionCollapsed(id: string): void {
  if (!store.pinnedPanelIds.includes(id)) return;
  const collapsed = store.collapsedPanelIds.includes(id)
    ? store.collapsedPanelIds.filter((panelId) => panelId !== id)
    : [...store.collapsedPanelIds, id];
  setStore({ ...store, collapsedPanelIds: collapsed });
}

export function setRailChromeExpanded(expanded: boolean): void {
  if (store.railChromeExpanded === expanded) return;
  setStore({ ...store, railChromeExpanded: expanded });
  saveStoredChromeExpanded(expanded);
}

export function toggleRailChrome(): void {
  setRailChromeExpanded(!store.railChromeExpanded);
}

export function setRailOverlayAlpha(alpha: number): void {
  const clamped = clampRailOverlayAlpha(alpha);
  if (store.overlayAlpha === clamped) return;
  setStore({ ...store, overlayAlpha: clamped });
  saveStoredOverlayAlpha(clamped);
}

// 폭 요구는 고정된 패널 전원이 말할 수 있다 — 단일 활성 가드는 스택에서 뒷섹션의 확장 요구를
// 버리는 결함이었다(감사 blocker). 소비 측은 펼쳐진 고정 패널의 최댓값을 취한다.
export function requestRailPanelExtraWidth(panelId: string, px: number | null): void {
  if (!store.pinnedPanelIds.includes(panelId)) return;
  const raw = (px === null || !Number.isFinite(px)) ? 0 : px;
  const normalized = Math.max(0, Math.round(raw));
  const clamped = typeof window !== "undefined" ? Math.min(normalized, Math.max(0, window.innerWidth - 548)) : normalized;
  // 미등록 상태에서 0 요청도 항목을 심는다 — undefined와 0을 같다고 치면 첫 정규화 요청이
  // 스냅샷에 흔적을 남기지 않아 상태 검사가 어긋난다.
  if (store.panelExtraWidths[panelId] !== undefined && clamped === store.panelExtraWidths[panelId]) return;
  setStore({ ...store, panelExtraWidths: { ...store.panelExtraWidths, [panelId]: clamped } });
}

/** RightRail이 레이아웃 후 자기 점유 폭을 보고한다 — Operations 페이지의 아레나 계산 원료. */
export function reportRailOccupiedPx(px: number): void {
  const normalized = Math.max(0, Math.round(px));
  if (normalized === store.railOccupiedPx) return;
  setStore({ ...store, railOccupiedPx: normalized });
}

export function useRailPinnedPanelIds(): readonly string[] {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).pinnedPanelIds;
}

export function useRailCollapsedPanelIds(): readonly string[] {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).collapsedPanelIds;
}

export function useRailChromeExpanded(): boolean {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).railChromeExpanded;
}

export function useRailPanelExtraWidths(): Readonly<Record<string, number>> {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).panelExtraWidths;
}

export function useRailOverlayAlpha(): RailOverlayAlpha {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).overlayAlpha;
}

export function useRailOccupiedPx(): number {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).railOccupiedPx;
}

function pinRailPanel(id: string): void {
  const pinned = store.pinnedPanelIds.includes(id) ? store.pinnedPanelIds : [...store.pinnedPanelIds, id];
  const collapsed = store.collapsedPanelIds.filter((panelId) => panelId !== id);
  if (pinned === store.pinnedPanelIds && collapsed.length === store.collapsedPanelIds.length) return;
  setStore({ ...store, pinnedPanelIds: pinned, collapsedPanelIds: collapsed });
  saveStoredPinnedPanels(pinned);
}

function unpinRailPanel(id: string): void {
  if (!store.pinnedPanelIds.includes(id)) return;
  const pinned = store.pinnedPanelIds.filter((panelId) => panelId !== id);
  const { [id]: _dropped, ...extraWidths } = store.panelExtraWidths;
  setStore({
    ...store,
    pinnedPanelIds: pinned,
    collapsedPanelIds: store.collapsedPanelIds.filter((panelId) => panelId !== id),
    panelExtraWidths: extraWidths,
  });
  saveStoredPinnedPanels(pinned);
}

function readStoredPinnedPanels(): readonly string[] {
  try {
    const raw = localStorage.getItem(PREFS_PINNED_PANELS);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((id): id is string => typeof id === "string" && id !== "");
      return [];
    }
    // 단일 활성 슬롯 시절의 기억을 스택의 첫 고정으로 승격한다(1회성 마이그레이션).
    const legacy = readLegacyStoredPanelId();
    const pinned = legacy === null ? [] : [legacy];
    try {
      localStorage.setItem(PREFS_PINNED_PANELS, JSON.stringify(pinned));
      localStorage.removeItem(LEGACY_PREFS_ACTIVE_PANEL);
    } catch { /* best-effort migration */ }
    return pinned;
  } catch { return []; }
}

function readLegacyStoredPanelId(): string | null {
  try {
    const stored = localStorage.getItem(LEGACY_PREFS_ACTIVE_PANEL);
    if (stored === "diff" || stored === "history") {
      try {
        if (stored === "history") localStorage.setItem(PREFS_REPOSITORY_SOURCE, "history");
      } catch { /* best-effort migration */ }
      return "repository";
    }
    if (stored === "alerts") return null;
    return stored;
  } catch { return null; }
}

function readStoredChromeExpanded(): boolean {
  try { return localStorage.getItem(PREFS_CHROME_EXPANDED) !== "0"; } catch { return true; }
}

function readStoredOverlayAlpha(): RailOverlayAlpha {
  try {
    const stored = localStorage.getItem(PREFS_OVERLAY_ALPHA);
    if (stored === null || stored.trim() === "") return RAIL_OVERLAY_ALPHA_DEFAULT;
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? clampRailOverlayAlpha(parsed) : RAIL_OVERLAY_ALPHA_DEFAULT;
  } catch { return RAIL_OVERLAY_ALPHA_DEFAULT; }
}

function clampRailOverlayAlpha(alpha: number): RailOverlayAlpha {
  return Math.min(RAIL_OVERLAY_ALPHA_MAX, Math.max(RAIL_OVERLAY_ALPHA_MIN, Math.round(alpha)));
}

function saveStoredPinnedPanels(pinned: readonly string[]): void {
  try { localStorage.setItem(PREFS_PINNED_PANELS, JSON.stringify(pinned)); } catch { /* ignore */ }
}

function saveStoredChromeExpanded(expanded: boolean): void {
  try { localStorage.setItem(PREFS_CHROME_EXPANDED, expanded ? "1" : "0"); } catch { /* ignore */ }
}

function saveStoredOverlayAlpha(alpha: RailOverlayAlpha): void {
  try { localStorage.setItem(PREFS_OVERLAY_ALPHA, String(alpha)); } catch { /* ignore */ }
}

function setStore(next: RailStore): void {
  store = next;
  for (const listener of listeners) listener();
}

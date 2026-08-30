import { useSyncExternalStore } from "react";

/* 레일은 다중 고정(pin) 스택에서 단일 독점 슬롯으로 회귀했다 — 카드에는 패널이 하나만 상주한다.
   - activePanelId: 카드에 상주하는 유일한 패널. localStorage에 영속.
   - 아이콘 클릭은 배타 전환이다: 켜진 패널을 다시 누르면 닫히고, 다른 패널을 누르면 교체된다.
   - push/overlay 이원의 퇴역과 아레나 인셋 승계는 스택 시절 그대로다 — 열린 패널 폭이 캔버스
     아레나에서 항상 제외되므로 fit-all·Tactical 슬롯·War Room 무대가 패널을 피해 계산된다. */
interface RailStore {
  readonly activePanelId: string | null;
  readonly railChromeExpanded: boolean;
  /** 활성 패널의 확장 폭 요구(px) — 독점 슬롯이라 요구도 하나다. 패널 교체·닫힘에 0으로 리셋. */
  readonly panelExtraWidth: number;
  readonly overlayAlpha: RailOverlayAlpha;
  /** 레일 카드가 캔버스 위에서 점유하는 실측 폭(px) — RightRail이 보고하고 아레나 계산이 소비한다. */
  readonly railOccupiedPx: number;
}

export type RailOverlayAlpha = number;

export const RAIL_OVERLAY_ALPHA_MIN = 40;
export const RAIL_OVERLAY_ALPHA_MAX = 100;
export const RAIL_OVERLAY_ALPHA_DEFAULT = 100;

type Listener = () => void;
const PREFS_ACTIVE_PANEL = "fleet-console.rail.activePanelId";
const LEGACY_PREFS_PINNED_PANELS = "fleet-console.rail.pinnedPanels";
const PREFS_CHROME_EXPANDED = "fleet-console.rail.chromeExpanded";
const PREFS_OVERLAY_ALPHA = "fleet-console.rail.overlayAlpha";
const PREFS_REPOSITORY_SOURCE = "fleet-console.repository.source";
const listeners = new Set<Listener>();
let store: RailStore = {
  activePanelId: readStoredActivePanelId(),
  railChromeExpanded: readStoredChromeExpanded(),
  panelExtraWidth: 0,
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

/** 아이콘 클릭의 배타 토글 — 켜진 패널이면 닫고, 아니면 그 패널로 교체한다. */
export function toggleRailPanel(id: string): void {
  if (store.activePanelId === id) {
    deactivateRailPanel();
    return;
  }
  activateRailPanel(id);
}

/** Ensure-open(팔레트·플러그인 capability): 그 패널이 활성임을 보장한다. 절대 닫지 않는다. */
export function openRailPanel(id: string): void {
  activateRailPanel(id);
}

export function closeRailPanel(id: string): void {
  if (store.activePanelId !== id) return;
  deactivateRailPanel();
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

// 폭 요구는 활성 패널만 말할 수 있다 — 독점 슬롯에서 화면 밖 패널의 요구는 실체가 없다.
export function requestRailPanelExtraWidth(panelId: string, px: number | null): void {
  if (store.activePanelId !== panelId) return;
  const raw = (px === null || !Number.isFinite(px)) ? 0 : px;
  const normalized = Math.max(0, Math.round(raw));
  const clamped = typeof window !== "undefined" ? Math.min(normalized, Math.max(0, window.innerWidth - 548)) : normalized;
  if (clamped === store.panelExtraWidth) return;
  setStore({ ...store, panelExtraWidth: clamped });
}

/** RightRail이 레이아웃 후 자기 점유 폭을 보고한다 — Operations 페이지의 아레나 계산 원료. */
export function reportRailOccupiedPx(px: number): void {
  const normalized = Math.max(0, Math.round(px));
  if (normalized === store.railOccupiedPx) return;
  setStore({ ...store, railOccupiedPx: normalized });
}

export function useRailActivePanelId(): string | null {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).activePanelId;
}

export function useRailChromeExpanded(): boolean {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).railChromeExpanded;
}

export function useRailPanelExtraWidth(): number {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).panelExtraWidth;
}

export function useRailOverlayAlpha(): RailOverlayAlpha {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).overlayAlpha;
}

export function useRailOccupiedPx(): number {
  return useSyncExternalStore(subscribeRailStore, getRailStoreSnapshot).railOccupiedPx;
}

function activateRailPanel(id: string): void {
  if (store.activePanelId === id) return;
  // 교체는 이전 패널의 확장 폭 요구도 함께 내린다 — 화면에 없는 요구가 아레나를 점유하면 안 된다.
  setStore({ ...store, activePanelId: id, panelExtraWidth: 0 });
  saveStoredActivePanelId(id);
}

function deactivateRailPanel(): void {
  if (store.activePanelId === null) return;
  setStore({ ...store, activePanelId: null, panelExtraWidth: 0 });
  saveStoredActivePanelId(null);
}

function readStoredActivePanelId(): string | null {
  try {
    const stored = localStorage.getItem(PREFS_ACTIVE_PANEL);
    if (stored !== null) {
      // 스택 키가 남아 있으면 함께 걷는다 — 활성 키가 지워진 뒤 옛 스택이 되살아나면 안 된다.
      try { localStorage.removeItem(LEGACY_PREFS_PINNED_PANELS); } catch { /* ignore */ }
      const active = normalizeStoredPanelId(stored);
      // 1기 슬롯 값(diff/history/alerts)은 같은 키에 살아 있다. 정규화만 하고 다시 쓰지 않으면
      // 매 로드가 history 소스를 되심고, alerts는 닫힌 레일을 유령 키로 남긴다(출시본 1회성 승격).
      if (active !== stored) {
        try {
          if (active === null) localStorage.removeItem(PREFS_ACTIVE_PANEL);
          else localStorage.setItem(PREFS_ACTIVE_PANEL, active);
        } catch { /* best-effort migration */ }
      }
      return active;
    }
    // 스택 시절의 기억을 독점 슬롯으로 승격한다 — 첫 고정(최상단 섹션)이 살아남는다(1회성 마이그레이션).
    const raw = localStorage.getItem(LEGACY_PREFS_PINNED_PANELS);
    if (raw === null) return null;
    let active: string | null = null;
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const first = parsed.find((id): id is string => typeof id === "string" && id !== "");
      active = first === undefined ? null : normalizeStoredPanelId(first);
    }
    try {
      if (active === null) localStorage.removeItem(PREFS_ACTIVE_PANEL);
      else localStorage.setItem(PREFS_ACTIVE_PANEL, active);
      localStorage.removeItem(LEGACY_PREFS_PINNED_PANELS);
    } catch { /* best-effort migration */ }
    return active;
  } catch { return null; }
}

/* 단일 활성 슬롯 1기 시절 값 정규화 — diff/history는 repository 패널로 흡수됐고(history는
   Repository 소스 시드 유지), alerts 패널은 퇴역했다. 스택 시절 값은 현대 id라 그대로 통과한다. */
function normalizeStoredPanelId(stored: string): string | null {
  if (stored === "") return null;
  if (stored === "diff" || stored === "history") {
    try {
      if (stored === "history") localStorage.setItem(PREFS_REPOSITORY_SOURCE, "history");
    } catch { /* best-effort migration */ }
    return "repository";
  }
  if (stored === "alerts") return null;
  return stored;
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

function saveStoredActivePanelId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(PREFS_ACTIVE_PANEL);
    else localStorage.setItem(PREFS_ACTIVE_PANEL, id);
  } catch { /* ignore */ }
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

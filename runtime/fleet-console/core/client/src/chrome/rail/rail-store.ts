import { useSyncExternalStore } from "react";

/* 레일은 다중 고정(pin) 스택에서 단일 독점 슬롯으로 회귀했다 — 카드에는 패널이 하나만 상주한다.
   - activePanelId: 카드에 상주하는 유일한 패널. localStorage에 영속.
   - 아이콘 클릭은 배타 전환이다: 켜진 패널을 다시 누르면 닫히고, 다른 패널을 누르면 교체된다.
   - push/overlay 이원의 퇴역과 아레나 인셋 승계는 스택 시절 그대로다 — 열린 패널 폭이 캔버스
     아레나에서 항상 제외되므로 fit-all·스냅 칸·War Room 무대가 패널을 피해 계산된다. */
interface RailStore {
  readonly activePanelId: string | null;
  /** 활성 패널의 확장 폭 요구(px) — 독점 슬롯이라 요구도 하나다. 패널 교체·닫힘에 0으로 리셋. */
  readonly panelExtraWidth: number;
  /** detail이 떠난 동안 유지할 primary 열 폭. 카드의 분할 폭 기억과는 별개다. */
  readonly panelSoloWidth: number | null;
  readonly panelSoloMaxWidth: number | null;
  readonly panelWidthReset: number;
  /** 도구 패널 카드가 캔버스 위에서 점유하는 실측 폭(px) — RightRail이 보고하고 아레나 계산이 소비한다. 끄는 동안에도 매 프레임 따라간다. */
  readonly railOccupiedPx: number;
  /** 끌기가 끝나 확정된 점유 폭(px). 끄는 동안에는 끌기 직전 값에 머문다. */
  readonly railSettledPx: number;
  readonly expandedMinWidthPx: number;
}

type Listener = () => void;
const PREFS_ACTIVE_PANEL = "fleet-console.rail.activePanelId";
const LEGACY_PREFS_PINNED_PANELS = "fleet-console.rail.pinnedPanels";
// 옛 아이콘 열의 접힘 선호 — 열이 도구모음으로 옮겨 가며 퇴역했다. 남은 값은 첫 로드에 걷는다.
const LEGACY_PREFS_CHROME_EXPANDED = "fleet-console.rail.chromeExpanded";
const PREFS_REPOSITORY_SOURCE = "fleet-console.repository.source";
const listeners = new Set<Listener>();
let store: RailStore = {
  activePanelId: readStoredActivePanelId(),
  panelExtraWidth: 0,
  panelSoloWidth: null,
  panelSoloMaxWidth: null,
  panelWidthReset: 0,
  railOccupiedPx: 0,
  railSettledPx: 0,
  expandedMinWidthPx: 0,
};
try { localStorage.removeItem(LEGACY_PREFS_CHROME_EXPANDED); } catch { /* ignore */ }

export function subscribeRailStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getRailStoreSnapshot(): RailStore {
  return store;
}

// 구독은 필드 단위다 — 스냅숏 전체를 구독하면 레일 끌기가 매 픽셀 보고하는 점유 폭 하나에도 모든 구독자가 다시 그린다.
function useRailStoreField<K extends keyof RailStore>(key: K): RailStore[K] {
  return useSyncExternalStore(subscribeRailStore, () => store[key]);
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

// 폭 요구는 활성 패널만 말할 수 있다 — 독점 슬롯에서 화면 밖 패널의 요구는 실체가 없다.
export function requestRailPanelExtraWidth(panelId: string, px: number | null): void {
  if (store.activePanelId !== panelId) return;
  const raw = (px === null || !Number.isFinite(px)) ? 0 : px;
  const normalized = Math.max(0, Math.round(raw));
  const clamped = typeof window !== "undefined" ? Math.min(normalized, Math.max(0, window.innerWidth - 548)) : normalized;
  if (clamped === store.panelExtraWidth) return;
  setStore({ ...store, panelExtraWidth: clamped });
}

export function requestRailPanelSoloWidth(panelId: string, px: number | null, maxWidth: number | null): void {
  if (store.activePanelId !== panelId) return;
  const next = px !== null && Number.isFinite(px) ? Math.max(0, Math.round(px)) : null;
  if (next === store.panelSoloWidth && maxWidth === store.panelSoloMaxWidth) return;
  setStore({ ...store, panelSoloWidth: next, panelSoloMaxWidth: maxWidth });
}

export function resetRailPanelWidth(panelId: string): void {
  if (store.activePanelId !== panelId) return;
  setStore({ ...store, panelWidthReset: store.panelWidthReset + 1 });
}

export function useRailPanelWidthReset(): number {
  return useRailStoreField("panelWidthReset");
}

export function useRailPanelSoloMaxWidth(): number | null {
  return useRailStoreField("panelSoloMaxWidth");
}

export function useRailPanelSoloWidth(): number | null {
  return useRailStoreField("panelSoloWidth");
}

/** RightRail이 레이아웃 후 자기 점유 폭을 보고한다 — Operations 페이지의 아레나 계산 원료. 끄는 동안의 보고는 확정 폭을 옮기지 않는다. */
export function reportRailOccupiedPx(px: number, settled: boolean): void {
  const normalized = Math.max(0, Math.round(px));
  const settledPx = settled ? normalized : store.railSettledPx;
  if (normalized === store.railOccupiedPx && settledPx === store.railSettledPx) return;
  setStore({ ...store, railOccupiedPx: normalized, railSettledPx: settledPx });
}

export function useRailActivePanelId(): string | null {
  return useRailStoreField("activePanelId");
}

export function useRailPanelExtraWidth(): number {
  return useRailStoreField("panelExtraWidth");
}

/** 확정된 점유 폭 — 끄는 동안 다시 그리지 않아도 되는 구독자(페이지 배치·fit-all 원료)의 값이다. */
export function useRailSettledPx(): number {
  return useRailStoreField("railSettledPx");
}

/** 끄는 중인 폭이 확정 폭에서 벗어난 양. `follow`가 꺼져 있으면 0에 머물러 끌기가 구독자를 다시 그리지 않는다. */
export function useRailDragDeltaPx(follow: boolean): number {
  return useSyncExternalStore(subscribeRailStore, () => (follow ? store.railOccupiedPx - store.railSettledPx : 0));
}

function activateRailPanel(id: string): void {
  if (store.activePanelId === id) return;
  // 교체는 이전 패널의 확장 폭 요구도 함께 내린다 — 화면에 없는 요구가 아레나를 점유하면 안 된다.
  setStore({ ...store, activePanelId: id, panelExtraWidth: 0, panelSoloWidth: null, panelSoloMaxWidth: null });
  saveStoredActivePanelId(id);
}

function deactivateRailPanel(): void {
  if (store.activePanelId === null) return;
  setStore({ ...store, activePanelId: null, panelExtraWidth: 0, panelSoloWidth: null, panelSoloMaxWidth: null });
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

function saveStoredActivePanelId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(PREFS_ACTIVE_PANEL);
    else localStorage.setItem(PREFS_ACTIVE_PANEL, id);
  } catch { /* ignore */ }
}

function setStore(next: RailStore): void {
  store = next;
  for (const listener of listeners) listener();
}

export function reportExpandedMinWidth(px: number): void {
  const width = Number.isFinite(px) ? Math.max(0, Math.ceil(px)) : 0;
  if (store.expandedMinWidthPx !== width) setStore({ ...store, expandedMinWidthPx: width });
}

export function useExpandedMinWidth(): number {
  return useRailStoreField("expandedMinWidthPx");
}

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";
import type { RailEntryDescriptor, RailPanelContext } from "@fleet-console/sdk/rail";

import { useExpandedSurfaces } from "../expanded-surface/store.js";
import { createHostCapabilities } from "../plugin-capabilities.js";
import "../styles/rail.css";
import { focusCommandBandToggleWhenPanelContainsActiveElement } from "../shortcuts.js";
import { useGlobalSettingsStore } from "../global-settings-store.js";
import { useT } from "../i18n/index.js";
import { ReconnectButton } from "../components/reconnect-button.js";
import { getState, subscribe } from "../store.js";
import { useSideBarState } from "../sidebar/operations-side-bar-store.js";
import type { ConnectionState } from "../types.js";
import { resolveConsoleLanguage } from "../whatsnew-i18n.js";
import { closeRailPanel, reportRailOccupiedPx, requestRailPanelExtraWidth, toggleRailPanel, toggleRailSectionCollapsed, useRailChromeExpanded, useRailCollapsedPanelIds, useRailOverlayAlpha, useRailPanelExtraWidths, useRailPinnedPanelIds } from "./rail-store.js";
import { GearGlyph, SETTINGS_RAIL_ENTRY_ID } from "../settings/settings-entry.js";
import { useRailEntries, type RailEntryBinding } from "../pane/pane-registry.js";
import { RailSurface } from "../pane/rail-surface.js";

interface RightRailProps {
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
  readonly onLaunchOperation?: (pluginId: string, kind: OperationLaunchKind) => void;
}

/** rail 컨텍스트마다 새 능력 객체를 만들면 패널 본문이 매 렌더 재마운트된다. */
const STABLE_RAIL_SURFACES = createHostCapabilities().surfaces;
const MIN_PANEL_WIDTH = 240;
const DEFAULT_PANEL_WIDTH = 312;
/** 아이콘 열 폭 — rail.css .right-rail-icons와 한 값. */
const RAIL_ICON_STRIP_WIDTH = 44;
/* 스택 개편 후 카드 폭은 패널별이 아니라 카드 단일 값이다 — 두 패널이 동시에 상주하는
   스택에서 패널별 폭 기억은 어느 값을 카드에 입힐지 결정 불능이었다(감사 high). 구 패널별
   기억(panelWidths)은 첫 로드에 최댓값으로 승격해 카드 폭으로 흡수한다. */
const PREFS_CARD_WIDTH = "fleet-console.rail.cardWidth";
const LEGACY_PREFS_PANEL_WIDTHS = "fleet-console.rail.panelWidths";
const LEGACY_PREFS_PANEL_WIDTH = "fleet-console.rail.panelWidth";

function readStoredCardWidth(): number | null {
  try {
    const raw = localStorage.getItem(PREFS_CARD_WIDTH);
    if (raw !== null) {
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed >= MIN_PANEL_WIDTH ? Math.round(parsed) : null;
    }
    // 1회성 마이그레이션: 패널별 기억·단일 레거시 키의 최댓값을 카드 폭으로 승격한다.
    const candidates: number[] = [];
    const legacyWidths = localStorage.getItem(LEGACY_PREFS_PANEL_WIDTHS);
    if (legacyWidths !== null) {
      const parsed: unknown = JSON.parse(legacyWidths);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const value of Object.values(parsed)) {
          if (typeof value === "number" && Number.isFinite(value) && value >= MIN_PANEL_WIDTH) candidates.push(Math.round(value));
        }
      }
    }
    const legacySingle = Number(localStorage.getItem(LEGACY_PREFS_PANEL_WIDTH));
    if (Number.isFinite(legacySingle) && legacySingle >= MIN_PANEL_WIDTH) candidates.push(Math.round(legacySingle));
    if (candidates.length === 0) return null;
    const migrated = Math.max(...candidates);
    try {
      localStorage.setItem(PREFS_CARD_WIDTH, String(migrated));
      localStorage.removeItem(LEGACY_PREFS_PANEL_WIDTHS);
      localStorage.removeItem(LEGACY_PREFS_PANEL_WIDTH);
    } catch { /* best-effort migration */ }
    return migrated;
  } catch { return null; }
}

function saveStoredCardWidth(width: number): void {
  try { localStorage.setItem(PREFS_CARD_WIDTH, String(Math.round(width))); } catch { /* ignore */ }
}

function clearStoredCardWidth(): void {
  try { localStorage.removeItem(PREFS_CARD_WIDTH); } catch { /* ignore */ }
}

/** 엔트리의 대표 페인 — 폭 기본값 등 표면 차원의 힌트를 primary가 말한다(pane 계약). */
function primaryPaneOf(binding: RailEntryBinding) {
  return binding.panes.find((pane) => pane.role === "primary") ?? binding.panes[0] ?? null;
}

function defaultCardWidthFor(bindings: readonly RailEntryBinding[]): number {
  return bindings.reduce(
    (max, binding) => Math.max(max, Math.round(primaryPaneOf(binding)?.defaultWidth ?? DEFAULT_PANEL_WIDTH)),
    MIN_PANEL_WIDTH,
  );
}

export function RightRail({ theaterId, api, onLaunchOperation }: RightRailProps) {
  const t = useT();
  const theaterFallback = t("rail.theater.fallback");
  const theaterLabel = useSyncExternalStore(
    subscribe,
    () => getState().theaters.find((theater) => theater.id === theaterId)?.label ?? theaterFallback,
    () => theaterFallback,
  );
  const connection = useSyncExternalStore(subscribe, () => getState().connection, () => "connecting" as const);
  const connectionLostAt = useSyncExternalStore(subscribe, () => getState().connectionLostAt, () => null);
  const theme = useSyncExternalStore(subscribe, () => getState().activeTheme, () => "instrument" as const);
  const globalSettings = useGlobalSettingsStore();
  const language = resolveConsoleLanguage(globalSettings.state?.language ?? "auto");
  const rootRef = useRef<HTMLDivElement>(null);
  const pinnedIds = useRailPinnedPanelIds();
  const collapsedIds = useRailCollapsedPanelIds();
  const extraWidths = useRailPanelExtraWidths();
  const railChromeExpanded = useRailChromeExpanded();
  const overlayAlpha = useRailOverlayAlpha();
  const previousRailChromeExpandedRef = useRef(railChromeExpanded);
  const bindings = useRailEntries();
  // 페인을 세우는 엔트리와 그냥 실행하는 엔트리. 옛 판별 유니온이 하던 구분을, 이제는
  // "이 엔트리가 세우는 페인이 있는가"라는 사실 하나가 대신한다(pane 계약, #957).
  const paneEntries = bindings.filter((binding) => binding.panes.length > 0);
  const actionEntries = bindings.filter((binding) => binding.panes.length === 0);
  // 표면 스토어를 구독한다 — 슬롯이 열리고 닫힐 때 rail 아이콘이 함께 켜지고 꺼져야 한다.
  const { instances: openSurfaces } = useExpandedSurfaces();
  const openSurfaceIds = useMemo(
    () => new Set(openSurfaces.map((instance) => instance.surfaceId)),
    [openSurfaces],
  );
  // 고정 순서(핀 순)가 곧 스택 순서다 — 등록 목록에 없는 id(내려간 플러그인)는 조용히 거른다.
  const pinnedBindings = pinnedIds
    .map((id) => paneEntries.find((binding) => binding.entry.id === id))
    .filter((binding): binding is RailEntryBinding => binding !== undefined);
  const expandedBindings = pinnedBindings.filter((binding) => !collapsedIds.includes(binding.entry.id));
  const hasPanel = pinnedBindings.length > 0;
  // 폭 요구는 펼쳐진 고정 패널들의 최댓값이다 — 합산하면 카드가 요구의 합만큼 부풀어
  // 아레나를 과점유한다. 접힌 섹션의 요구는 화면에 없으므로 세지 않는다.
  const extraWidth = expandedBindings.reduce(
    (max, binding) => Math.max(max, extraWidths[binding.entry.id] ?? 0),
    0,
  );
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  // 부유 사이드바 카드의 점유 폭 — 두 카드는 같은 층(z --z-rail)의 절대 배치라 그리드가
  // 겹침을 막아 주지 않는다. 레일 폭 상한이 이 점유를 빼지 않으면 드래그·End 키 한 번에
  // 레일 카드가 사이드바 카드를 덮는다(Codex 리뷰 확정). 아레나 좌측 인셋과 같은 산식이다.
  const sideBar = useSideBarState();
  const sideBarOccupiedPx = sideBar.collapsed ? 0 : sideBar.width + 24;
  // 카드+extra가 함께 쓰는 가용 예산. 카드 상한은 예산에서 extra를 뺀 값이되, 예산이
  // 바닥나면 MIN 바닥이 이긴다 — 그때 넘치는 쪽은 아래 슬롯 총폭 캡이 extra를 깎아 회수한다.
  const widthBudget = Math.floor(viewportWidth - 148 - sideBarOccupiedPx);
  const maxPanelWidth = Math.max(MIN_PANEL_WIDTH, widthBudget - extraWidth);

  // 저장 폭은 클램프 없이 desired로 보존한다 — init에서 클램프한 값을 desired로 심으면
  // 큰 화면에서 저장한 폭이 좁은 창 로드 한 번에 소실되어, 창을 다시 넓혀도 복원되지
  // 않는다(Codex 리뷰 확정 — 구 폭 기억 effect의 restore-on-expansion 계약 승계).
  const [initialWidths] = useState(() => {
    const stored = readStoredCardWidth();
    const fallback = defaultCardWidthFor(pinnedBindings.length > 0 ? pinnedBindings : paneEntries);
    const desired = Math.max(MIN_PANEL_WIDTH, stored ?? fallback);
    return { desired, rendered: Math.min(maxPanelWidth, desired) };
  });
  const [cardWidth, setCardWidthState] = useState(initialWidths.rendered);
  const desiredWidthRef = useRef(initialWidths.desired);
  const cardWidthRef = useRef(initialWidths.rendered);
  const [isDragging, setIsDragging] = useState(false);
  const extraWidthRef = useRef(extraWidth);
  extraWidthRef.current = extraWidth;
  const sideBarOccupiedRef = useRef(sideBarOccupiedPx);
  sideBarOccupiedRef.current = sideBarOccupiedPx;

  useLayoutEffect(() => {
    const onResize = () => {
      const next = window.innerWidth;
      setViewportWidth((current) => current === next ? current : next);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 뷰포트 클램프 — 좁아지면 즉시 줄이고, 다시 넓어지면 기억한 폭으로 복귀한다(기존 계약 유지).
  useLayoutEffect(() => {
    const desiredWidth = isDragging ? cardWidthRef.current : desiredWidthRef.current;
    const next = Math.max(MIN_PANEL_WIDTH, Math.min(maxPanelWidth, desiredWidth));
    if (next === cardWidthRef.current) return;
    cardWidthRef.current = next;
    setCardWidthState(next);
  }, [isDragging, maxPanelWidth]);

  useLayoutEffect(() => {
    if (previousRailChromeExpandedRef.current && !railChromeExpanded) focusCommandBandToggleWhenPanelContainsActiveElement(rootRef.current, ".command-band-rail-toggle");
    previousRailChromeExpandedRef.current = railChromeExpanded;
  }, [railChromeExpanded]);

  // 아레나 계산의 원료 — 레일이 캔버스 위에서 점유하는 실측 폭을 스토어로 보고한다.
  // fit-all·Tactical 슬롯·War Room 무대가 이 값으로 열린 스택을 피해 계산된다.
  // 슬롯 총폭(카드+extra)도 예산으로 캡한다 — 카드 상한만 사이드바를 빼면 MIN 바닥(240)과
  // 가산 extra(예: Codex 리더 360)가 상한을 도로 뚫어 좁은 창에서 두 카드가 겹친다
  // (Codex 리뷰 확정). extra는 best-effort다: 페인 본문은 컨테이너 쿼리로 스스로 열화한다.
  const slotWidth = hasPanel
    ? Math.max(MIN_PANEL_WIDTH, Math.min(cardWidth + extraWidth, Math.max(MIN_PANEL_WIDTH, widthBudget)))
    : 0;
  useLayoutEffect(() => {
    reportRailOccupiedPx(railChromeExpanded ? RAIL_ICON_STRIP_WIDTH + slotWidth : 0);
  }, [railChromeExpanded, slotWidth]);

  const handleResizeDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = cardWidthRef.current;
    setIsDragging(true);

    const onMove = (ev: PointerEvent) => {
      const dx = startX - ev.clientX;
      const maxWidth = Math.max(MIN_PANEL_WIDTH, Math.floor(window.innerWidth - 148 - extraWidthRef.current - sideBarOccupiedRef.current));
      const next = Math.max(MIN_PANEL_WIDTH, Math.min(maxWidth, Math.round(startWidth + dx)));
      cardWidthRef.current = next;
      setCardWidthState(next);
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      desiredWidthRef.current = cardWidthRef.current;
      setIsDragging(false);
      saveStoredCardWidth(desiredWidthRef.current);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);

  const handleResizeKeyDown = useCallback((event: React.KeyboardEvent) => {
    let next: number;
    const step = event.shiftKey ? 64 : 16;
    const currentMaxWidth = Math.max(MIN_PANEL_WIDTH, Math.floor(window.innerWidth - 148 - extraWidthRef.current - sideBarOccupiedRef.current));

    switch (event.key) {
      case "ArrowLeft":
        next = cardWidthRef.current + step;
        break;
      case "ArrowRight":
        next = cardWidthRef.current - step;
        break;
      case "Home":
        next = MIN_PANEL_WIDTH;
        break;
      case "End":
        next = currentMaxWidth;
        break;
      default:
        return;
    }

    event.preventDefault();
    next = Math.max(MIN_PANEL_WIDTH, Math.min(currentMaxWidth, Math.round(next)));
    desiredWidthRef.current = next;
    cardWidthRef.current = next;
    setCardWidthState(next);
    saveStoredCardWidth(desiredWidthRef.current);
  }, []);

  // 메뉴의 "패널 폭 초기화" — 기억을 지우고 고정된 패널들의 선언 기본값(최대)으로 되돌린다.
  const handleResetCardWidth = useCallback(() => {
    clearStoredCardWidth();
    const currentMaxWidth = Math.max(MIN_PANEL_WIDTH, Math.floor(window.innerWidth - 148 - extraWidthRef.current - sideBarOccupiedRef.current));
    const next = Math.max(MIN_PANEL_WIDTH, Math.min(currentMaxWidth, defaultCardWidthFor(pinnedBindings.length > 0 ? pinnedBindings : paneEntries)));
    desiredWidthRef.current = next;
    cardWidthRef.current = next;
    setCardWidthState(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedIds.join("\0"), paneEntries.length]);

  const baseCtx: RailPanelContext = useMemo(() => ({
    theaterId,
    pathContext: { kind: "root", relPath: null, label: theaterLabel },
    api,
    language,
    theme,
    surfaces: STABLE_RAIL_SURFACES,
    launchOperation: onLaunchOperation,
  }), [theaterId, theaterLabel, api, language, theme, onLaunchOperation]);

  return (
    <div
      ref={rootRef}
      className={`right-rail${hasPanel ? " is-open" : ""}${railChromeExpanded ? " is-expanded" : " is-closed"}${isDragging ? " is-dragging" : ""}`}
      data-rail-chrome={railChromeExpanded ? "expanded" : "closed"}
      role="complementary"
      aria-label={t("rail.chrome.aria")}
      inert={!railChromeExpanded}
      style={{ "--right-rail-panel-width": `${slotWidth}px` } as CSSProperties}
    >
      <div
        className="right-rail-panel-slot"
        style={{ "--right-rail-overlay-alpha": overlayAlpha / 100 } as CSSProperties}
      >
        {hasPanel && (
          <div
            className="right-rail-resize-handle"
            onPointerDown={handleResizeDragStart}
            // 옛 톱니 메뉴의 "패널 폭 초기화"는 조작 대상 위의 직접 조작으로 온다 —
            // 더블클릭이 기억된 폭을 지우고 패널이 선언한 기본값으로 되돌린다.
            onDoubleClick={handleResetCardWidth}
            title={t("rail.chrome.resetWidth")}
            onKeyDown={handleResizeKeyDown}
            role="separator"
            aria-orientation="vertical"
            tabIndex={0}
            aria-label={t("rail.chrome.resizeCard")}
            aria-valuenow={Math.round(cardWidth)}
            aria-valuemin={MIN_PANEL_WIDTH}
            aria-valuemax={maxPanelWidth}
          />
        )}
        {hasPanel && (
          <div className="right-rail-stack">
            {pinnedBindings.map((binding) => (
              <RailSection
                key={binding.entry.id}
                binding={binding}
                collapsed={collapsedIds.includes(binding.entry.id)}
                baseCtx={baseCtx}
                connection={connection}
                connectionLostAt={connectionLostAt}
                language={language}
              />
            ))}
          </div>
        )}
      </div>
      <nav className="right-rail-icons" aria-label={t("rail.chrome.toolsAria")}>
        {/* 설정은 열 최상단에 서고 디바이더가 패널 탭과 갈라 놓는다 — 콘솔을 다스리는 일과
            작업 패널을 고르는 일은 다른 종류의 동작이다. 톱니는 이제 메뉴가 아니라 설정
            표면의 문이고, 켜짐은 열의 다른 아이콘과 똑같은 활성 표식으로 "지금 여기"를 말한다. */}
        <button
          id="rail-settings-toggle"
          type="button"
          className={`right-rail-ico right-rail-settings-btn${pinnedIds.includes(SETTINGS_RAIL_ENTRY_ID) ? " is-active" : ""}`}
          aria-pressed={pinnedIds.includes(SETTINGS_RAIL_ENTRY_ID)}
          aria-controls={pinnedIds.includes(SETTINGS_RAIL_ENTRY_ID) ? `rail-panel-${SETTINGS_RAIL_ENTRY_ID}` : undefined}
          aria-label={t("settings.title")}
          title={t("settings.title")}
          onClick={() => toggleRailPanel(SETTINGS_RAIL_ENTRY_ID)}
        >
          <GearGlyph />
        </button>
        <div className="right-rail-divider" role="separator" aria-orientation="horizontal" />
        {/* 스택 개편 후 아이콘은 배타 탭이 아니라 고정(pin) 토글이다 — 여러 개가 동시에 켜진다.
            설정은 문(톱니)으로만 열리므로 탭 목록에는 다시 서지 않는다. */}
        <div className="right-rail-tabs" role="group" aria-label={t("rail.chrome.panelsAria")}>
          {paneEntries.filter((binding) => binding.core && binding.entry.id !== SETTINGS_RAIL_ENTRY_ID).map(({ entry }) => (
            <RailIcon key={entry.id} entry={entry} context={baseCtx} language={language} isActive={pinnedIds.includes(entry.id)} />
          ))}
        </div>
        {actionEntries.map(({ entry }) => (
          <RailIcon
            key={entry.id}
            entry={entry}
            context={baseCtx}
            language={language}
            // 표면을 여는 동작은 그 표면이 서 있는 동안 켜져 있다 — 펼친 패널과 같은 문법으로
            // "지금 여기"를 말한다. 표면을 열지 않는 동작은 켜질 자리가 없다.
            isActive={entry.surfaceId !== undefined && openSurfaceIds.has(entry.surfaceId)}
          />
        ))}
        <div className="right-rail-tabs" role="group" aria-label={t("rail.chrome.panelsAria")}>
          {paneEntries.filter((binding) => !binding.core).map(({ entry }) => (
            <RailIcon key={entry.id} entry={entry} context={baseCtx} language={language} isActive={pinnedIds.includes(entry.id)} />
          ))}
        </div>
      </nav>
    </div>
  );
}

interface RailSectionProps {
  readonly binding: RailEntryBinding;
  readonly collapsed: boolean;
  readonly baseCtx: RailPanelContext;
  readonly connection: ConnectionState;
  readonly connectionLostAt: number | null;
  readonly language: ConsoleLocale;
}

/** 스택의 한 칸 — 헤더(접기·닫기) + 상주 본문. 접힘은 본문을 숨길 뿐 마운트를 유지한다:
 *  파일 트리·diff·Codex의 내부 상태가 섹션 접기마다 리셋되면 스택은 배타 탭보다 나쁘다. */
function RailSection({ binding, collapsed, baseCtx, connection, connectionLostAt, language }: RailSectionProps) {
  const t = useT();
  const title = resolveLocalizedText(binding.entry.title, language);
  return (
    <section className={`right-rail-section${collapsed ? " is-collapsed" : ""}`}>
      <header className="right-rail-section-head">
        <button
          type="button"
          className="right-rail-section-toggle"
          aria-expanded={!collapsed}
          aria-controls={`rail-panel-${binding.entry.id}`}
          onClick={() => toggleRailSectionCollapsed(binding.entry.id)}
        >
          <span className="right-rail-section-caret" aria-hidden="true" />
          <span className="right-rail-section-title">{title}</span>
        </button>
        <button
          type="button"
          className="right-rail-section-close"
          aria-label={t("rail.chrome.closePanel", { title })}
          title={t("rail.chrome.closePanel", { title })}
          onClick={(event) => {
            // 닫힘으로 사라질 버튼이 포커스를 쥔 채 언핀되면 포커스가 body로 떨어져 키보드
            // 위치를 잃는다(Codex 리뷰). 같은 패널의 레일 아이콘은 언핀 후에도 남는 안정
            // 좌표이므로 먼저 그리로 옮긴다.
            if (event.currentTarget === document.activeElement) {
              document.getElementById(`rail-tab-${binding.entry.id}`)?.focus();
            }
            closeRailPanel(binding.entry.id);
          }}
        >
          <CloseGlyph />
        </button>
      </header>
      <div className="right-rail-section-body" hidden={collapsed} inert={collapsed || undefined}>
        <RailPanelBody binding={binding} ctx={baseCtx} connection={connection} connectionLostAt={connectionLostAt} language={language} />
      </div>
    </section>
  );
}

interface RailPanelBodyProps {
  readonly binding: RailEntryBinding;
  readonly ctx: RailPanelContext;
  readonly connection: ConnectionState;
  readonly connectionLostAt: number | null;
  readonly language: ConsoleLocale;
}

// 패널 본문은 무거운 플러그인 콘텐츠(파일 트리·diff·Codex)를 렌더한다. 폭·알파와 무관한
// props만 받는 memo 경계로 리사이즈/알파 드래그 중 본문 재렌더를 건너뛴다. 본문 렌더는
// pane 계약의 RailSurface가 소유한다(#957) — 이 껍데기는 stale 덮개와 포커스 복원만 진다.
const RailPanelBody = memo(function RailPanelBody({ binding, ctx, connection, connectionLostAt, language }: RailPanelBodyProps) {
  const t = useT();
  const connectionLostTime = connectionLostAt === null ? "" : new Date(connectionLostAt).toLocaleTimeString(language);
  const staleVisible = connection !== "live" && connectionLostAt !== null;
  const panelBodyRef = useRef<HTMLDivElement>(null);
  const panelContentRef = useRef<HTMLDivElement>(null);
  const staleVeilRef = useRef<HTMLDivElement>(null);
  const reconnectButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const previousStaleVisibleRef = useRef(false);
  const entryId = binding.entry.id;
  const handleRequestExtraWidth = useCallback((px: number | null) => {
    requestRailPanelExtraWidth(entryId, px);
  }, [entryId]);

  useLayoutEffect(() => {
    const wasVisible = previousStaleVisibleRef.current;
    previousStaleVisibleRef.current = staleVisible;
    if (!wasVisible && staleVisible) {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && panelContentRef.current?.contains(activeElement)) {
        returnFocusRef.current = activeElement;
        reconnectButtonRef.current?.focus();
      }
      return;
    }
    if (!wasVisible || staleVisible) return;

    // 이 layout effect가 실행될 때는 React가 wrapper의 inert를 이미 해제했다. 그 전에는
    // 실브라우저가 focus()를 조용히 무시하므로, 렌더 중 직접 복원하지 않는다.
    const returnFocus = returnFocusRef.current;
    returnFocusRef.current = null;
    if (returnFocus === null) return;
    const activeElement = document.activeElement;
    const focusStillOwned = activeElement === document.body
      || (activeElement instanceof HTMLElement && staleVeilRef.current?.contains(activeElement));
    if (!focusStillOwned) return;
    if (returnFocus?.isConnected && panelContentRef.current?.contains(returnFocus)) {
      returnFocus.focus();
    } else {
      panelBodyRef.current?.focus();
    }
  }, [staleVisible]);

  // 스택의 모든 섹션은 region이다. 설정은 탭이 아니라 문(톱니 토글)이 열므로 문을 라벨로
  // 삼고, 나머지 섹션은 자기 레일 탭(rail-tab-*)을 라벨로 삼는다.
  const doorSurface = binding.entry.id === SETTINGS_RAIL_ENTRY_ID;
  return (
    <div
      ref={panelBodyRef}
      id={`rail-panel-${binding.entry.id}`}
      className="right-rail-panel-body"
      role="region"
      aria-labelledby={doorSurface ? "rail-settings-toggle" : `rail-tab-${binding.entry.id}`}
      tabIndex={-1}
    >
      <div ref={panelContentRef} className="right-rail-panel-content" inert={staleVisible || undefined}>
        <RailSurface
          binding={binding}
          theaterId={ctx.theaterId}
          api={ctx.api}
          language={language}
          theme={ctx.theme}
          surfaces={ctx.surfaces}
          onRequestExtraWidth={handleRequestExtraWidth}
          onLaunchOperation={ctx.launchOperation}
        />
      </div>
      {/* 덮개도 배너와 같은 축으로 건다 — 재연결 시도 중에도 패널 값은 여전히 멈춰 있다. */}
      {staleVisible ? (
        <div ref={staleVeilRef} className="right-rail-stale-veil">
          <strong>{t("chrome.link.staleHeadline")}</strong>
          <span>{t("chrome.link.staleDetail", { time: connectionLostTime })}</span>
          <ReconnectButton buttonRef={reconnectButtonRef} />
        </div>
      ) : null}
    </div>
  );
});

interface RailIconProps {
  readonly entry: RailEntryDescriptor;
  readonly context: RailPanelContext;
  readonly language: ConsoleLocale;
  readonly isActive: boolean;
}

function RailIcon({ entry, context, language, isActive }: RailIconProps) {
  const handleClick = useCallback(() => {
    if (entry.activate) {
      if (context.theaterId === null) return;
      entry.activate(context);
      return;
    }
    toggleRailPanel(entry.id);
  }, [context, entry]);
  const icon = typeof entry.icon === "function" ? entry.icon() : entry.icon;
  const title = resolveLocalizedText(entry.title, language);

  return (
    <button
      id={`rail-tab-${entry.id}`}
      className={`right-rail-ico${isActive ? " is-active" : ""}`}
      type="button"
      // 스택 개편 후 패널 아이콘은 배타 탭이 아니라 고정 토글이다 — 켜짐은 pressed로 말한다.
      aria-pressed={isActive}
      aria-label={title}
      disabled={entry.activate !== undefined && context.theaterId === null}
      title={title}
      onClick={handleClick}
    >
      {icon}
    </button>
  );
}

function CloseGlyph() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>;
}

/* 패널 접기 아이콘 — 우측 영역을 선으로 구분한 패널 모양(#44 시안, 우측 미러). */

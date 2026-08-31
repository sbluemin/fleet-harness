import { Fragment, memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";

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
import { closeRailPanel, reportRailOccupiedPx, requestRailPanelExtraWidth, toggleRailPanel, useRailActivePanelId, useRailChromeExpanded, useRailOverlayAlpha, useRailPanelExtraWidth } from "./rail-store.js";
import {
  MIN_PANEL_WIDTH,
  clearStoredPanelWidth,
  readStoredPanelWidths,
  resolvePaneDefaultWidth,
  saveStoredPanelWidth,
  type StoredPanelWidths,
} from "./pane-width.js";
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
/** 아이콘 열 폭 — rail.css .right-rail-icons와 한 값. */
const RAIL_ICON_STRIP_WIDTH = 44;
/** 엔트리의 대표 페인 — 폭 기본값 등 표면 차원의 힌트를 primary가 말한다(pane 계약). */
function primaryPaneOf(binding: RailEntryBinding | null) {
  if (binding === null) return null;
  return binding.panes.find((pane) => pane.role === "primary") ?? binding.panes[0] ?? null;
}

/** 이 도구가 손대지 않은 상태에서 서는 폭 — 대표 페인이 선언한 픽셀 또는 등급. */
function declaredWidthOf(binding: RailEntryBinding | null): number {
  return Math.max(MIN_PANEL_WIDTH, resolvePaneDefaultWidth(primaryPaneOf(binding)));
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
  const activePanelId = useRailActivePanelId();
  const extraWidth = useRailPanelExtraWidth();
  const railChromeExpanded = useRailChromeExpanded();
  const overlayAlpha = useRailOverlayAlpha();
  const previousRailChromeExpandedRef = useRef(railChromeExpanded);
  const bindings = useRailEntries();
  // 페인을 세우는 엔트리와 그냥 실행하는 엔트리의 구분은 "이 엔트리가 세우는 페인이 있는가"라는
  // 사실 하나가 진다(pane 계약, #957). 활성 패널·폭 계산은 페인 엔트리만 본다.
  const paneEntries = bindings.filter((binding) => binding.panes.length > 0);
  // 합성 순서가 곧 레일 순서다(virtual:fleet-plugins). 동작 엔트리를 종류별로 앞세우면 등록
  // 순서가 렌더에서 뒤집히므로(Shell이 Codex 앞에 섰다), 순서는 바인딩 그대로 두고 연속한
  // 페인 토글 구간만 role=group으로 묶는다 — 동작은 패널 그룹의 구성원이 아니다.
  const pluginRuns: { readonly kind: "panes" | "action"; readonly key: string; readonly bindings: RailEntryBinding[] }[] = [];
  for (const binding of bindings) {
    if (binding.core) continue;
    const kind = binding.panes.length > 0 ? "panes" : "action";
    const tail = pluginRuns[pluginRuns.length - 1];
    if (tail !== undefined && tail.kind === kind) tail.bindings.push(binding);
    else pluginRuns.push({ kind, key: binding.entry.id, bindings: [binding] });
  }
  // 표면 스토어를 구독한다 — 슬롯이 열리고 닫힐 때 rail 아이콘이 함께 켜지고 꺼져야 한다.
  const { instances: openSurfaces } = useExpandedSurfaces();
  const openSurfaceIds = useMemo(
    () => new Set(openSurfaces.map((instance) => instance.surfaceId)),
    [openSurfaces],
  );
  // 등록 목록에 없는 id(내려간 플러그인)는 조용히 무시한다 — 저장된 id는 유지되어
  // 플러그인이 돌아오면 그 패널이 다시 선다.
  const activeBinding = activePanelId === null
    ? null
    : (paneEntries.find((binding) => binding.entry.id === activePanelId) ?? null);
  const hasPanel = activeBinding !== null;
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

  // 폭은 카드가 아니라 도구가 기억한다. 조절한 도구만 자기 값을 갖고, 손대지 않은 도구는
  // 계속 자기 선언값으로 열린다 — 그래야 페인이 기본값을 고쳤을 때 그 개선이 사용자에게 닿는다.
  const [storedWidths, setStoredWidths] = useState<StoredPanelWidths>(() => readStoredPanelWidths(activePanelId));
  const storedWidthsRef = useRef(storedWidths);
  storedWidthsRef.current = storedWidths;

  // 저장 폭은 클램프 없이 desired로 보존한다 — init에서 클램프한 값을 desired로 심으면
  // 큰 화면에서 저장한 폭이 좁은 창 로드 한 번에 소실되어, 창을 다시 넓혀도 복원되지
  // 않는다(Codex 리뷰 확정 — 구 폭 기억 effect의 restore-on-expansion 계약 승계).
  const desiredWidth = activeBinding === null
    ? declaredWidthOf(null)
    : Math.max(MIN_PANEL_WIDTH, storedWidths[activeBinding.entry.id] ?? declaredWidthOf(activeBinding));
  const [cardWidth, setCardWidthState] = useState(() => Math.min(maxPanelWidth, desiredWidth));
  const cardWidthRef = useRef(cardWidth);
  const [isDragging, setIsDragging] = useState(false);
  const extraWidthRef = useRef(extraWidth);
  extraWidthRef.current = extraWidth;
  const sideBarOccupiedRef = useRef(sideBarOccupiedPx);
  sideBarOccupiedRef.current = sideBarOccupiedPx;
  // 조절은 언제나 **화면에 선 도구**의 몫이다 — 핸들러는 안정 참조로 두고 대상만 ref로 읽는다.
  const activePaneIdRef = useRef<string | null>(null);
  activePaneIdRef.current = activeBinding?.entry.id ?? null;

  useLayoutEffect(() => {
    const onResize = () => {
      const next = window.innerWidth;
      setViewportWidth((current) => current === next ? current : next);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 뷰포트 클램프 — 좁아지면 즉시 줄이고, 다시 넓어지면 기억한 폭으로 복귀한다(기존 계약 유지).
  // 같은 effect가 도구 전환도 받는다: desired는 활성 도구가 정하므로 도구가 바뀌면 그 도구의
  // 폭으로 카드가 다시 선다. 드래그 중에는 포인터가 폭의 주인이라 desired를 보지 않는다.
  useLayoutEffect(() => {
    const target = isDragging ? cardWidthRef.current : desiredWidth;
    const next = Math.max(MIN_PANEL_WIDTH, Math.min(maxPanelWidth, target));
    if (next === cardWidthRef.current) return;
    cardWidthRef.current = next;
    setCardWidthState(next);
  }, [isDragging, maxPanelWidth, desiredWidth]);

  useLayoutEffect(() => {
    if (previousRailChromeExpandedRef.current && !railChromeExpanded) focusCommandBandToggleWhenPanelContainsActiveElement(rootRef.current, ".command-band-rail-toggle");
    previousRailChromeExpandedRef.current = railChromeExpanded;
  }, [railChromeExpanded]);

  // 아레나 계산의 원료 — 레일이 캔버스 위에서 점유하는 실측 폭을 스토어로 보고한다.
  // fit-all·Tactical 슬롯·War Room 무대가 이 값으로 열린 카드를 피해 계산된다.
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
      setIsDragging(false);
      const panelId = activePaneIdRef.current;
      if (panelId !== null) setStoredWidths(saveStoredPanelWidth(storedWidthsRef.current, panelId, cardWidthRef.current));
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
    cardWidthRef.current = next;
    setCardWidthState(next);
    const panelId = activePaneIdRef.current;
    if (panelId !== null) setStoredWidths(saveStoredPanelWidth(storedWidthsRef.current, panelId, next));
  }, []);

  // 가장자리 더블클릭의 "패널 폭 초기화" — 그 도구의 기억만 지운다. 폭은 그 뒤 클램프
  // effect가 선언 기본값에서 다시 세운다(기억을 지우는 것이 곧 되돌리는 것이다).
  const handleResetCardWidth = useCallback(() => {
    const panelId = activePaneIdRef.current;
    if (panelId === null) return;
    setStoredWidths(clearStoredPanelWidth(storedWidthsRef.current, panelId));
  }, []);

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
        {activeBinding !== null && (
          // key 재마운트가 패널 교체의 수명 계약이다: 떠나는 표면은 자기 언마운트 cleanup에서
          // 비-keepAlive detail을 닫는다(RailSurface의 departing sweep). React가 물러나는
          // 트리의 passive cleanup을 도착 트리의 mount effect보다 먼저 돌리므로, 도착 본문이
          // 마운트에서 여는 detail(파일 문서 열·Codex 리더)은 정리에 걸리지 않는다. 인스턴스를
          // 재사용하면 그 정리가 수동 effect로 밀려 도착 마운트 **뒤에** 돌아, 방금 연 열을
          // 쓸어 내거나(Codex 3차 P1) 확장 폭 소유권이 새 패널로 샌다(Codex 2차 P2).
          <RailSection
            key={activeBinding.entry.id}
            binding={activeBinding}
            baseCtx={baseCtx}
            connection={connection}
            connectionLostAt={connectionLostAt}
            language={language}
          />
        )}
      </div>
      <nav className="right-rail-icons" aria-label={t("rail.chrome.toolsAria")}>
        {/* 설정은 열 최상단에 서고 디바이더가 패널 탭과 갈라 놓는다 — 콘솔을 다스리는 일과
            작업 패널을 고르는 일은 다른 종류의 동작이다. 톱니는 이제 메뉴가 아니라 설정
            표면의 문이고, 켜짐은 열의 다른 아이콘과 똑같은 활성 표식으로 "지금 여기"를 말한다. */}
        <button
          id="rail-settings-toggle"
          type="button"
          className={`right-rail-ico right-rail-settings-btn${activePanelId === SETTINGS_RAIL_ENTRY_ID ? " is-active" : ""}`}
          aria-pressed={activePanelId === SETTINGS_RAIL_ENTRY_ID}
          aria-controls={activePanelId === SETTINGS_RAIL_ENTRY_ID ? `rail-panel-${SETTINGS_RAIL_ENTRY_ID}` : undefined}
          aria-label={t("settings.title")}
          title={t("settings.title")}
          onClick={() => toggleRailPanel(SETTINGS_RAIL_ENTRY_ID)}
        >
          <GearGlyph />
        </button>
        <div className="right-rail-divider" role="separator" aria-orientation="horizontal" />
        {/* 아이콘은 배타 전환이다 — 한 번에 하나만 켜지고, 켜진 아이콘을 다시 누르면 닫힌다.
            설정은 문(톱니)으로만 열리므로 탭 목록에는 다시 서지 않는다. */}
        <div className="right-rail-tabs" role="group" aria-label={t("rail.chrome.panelsAria")}>
          {paneEntries.filter((binding) => binding.core && binding.entry.id !== SETTINGS_RAIL_ENTRY_ID).map(({ entry }) => (
            <RailIcon key={entry.id} entry={entry} context={baseCtx} language={language} isActive={activePanelId === entry.id} />
          ))}
        </div>
        {pluginRuns.map((run) => run.kind === "action"
          ? (
            <Fragment key={run.key}>
              {run.bindings.map(({ entry }) => (
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
            </Fragment>
          )
          : (
            <div key={run.key} className="right-rail-tabs" role="group" aria-label={t("rail.chrome.panelsAria")}>
              {run.bindings.map(({ entry }) => (
                <RailIcon key={entry.id} entry={entry} context={baseCtx} language={language} isActive={activePanelId === entry.id} />
              ))}
            </div>
          ))}
      </nav>
    </div>
  );
}

interface RailSectionProps {
  readonly binding: RailEntryBinding;
  readonly baseCtx: RailPanelContext;
  readonly connection: ConnectionState;
  readonly connectionLostAt: number | null;
  readonly language: ConsoleLocale;
}

/** 카드의 독점 상주자 — 헤더(제목·닫기) + 본문. 패널은 하나만 상주하므로 접기는 없다:
 *  안 볼 패널은 접는 게 아니라 닫거나 다른 패널로 교체한다. */
function RailSection({ binding, baseCtx, connection, connectionLostAt, language }: RailSectionProps) {
  const t = useT();
  const title = resolveLocalizedText(binding.entry.title, language);
  return (
    <section className="right-rail-section">
      <header className="right-rail-section-head">
        <span className="right-rail-section-title">{title}</span>
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
              // 설정은 탭 목록에 서지 않는다 — 문(톱니)이 닫힌 뒤에도 남는 안정 좌표다.
              const focusId = binding.entry.id === SETTINGS_RAIL_ENTRY_ID
                ? "rail-settings-toggle"
                : `rail-tab-${binding.entry.id}`;
              document.getElementById(focusId)?.focus();
            }
            closeRailPanel(binding.entry.id);
          }}
        >
          <CloseGlyph />
        </button>
      </header>
      <div className="right-rail-section-body">
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

  // 독점 섹션도 region이다. 설정은 탭이 아니라 문(톱니 토글)이 열므로 문을 라벨로
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
      // 패널 아이콘은 배타 전환 토글이다 — 켜짐은 pressed로 말하고, 최대 하나만 true다.
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

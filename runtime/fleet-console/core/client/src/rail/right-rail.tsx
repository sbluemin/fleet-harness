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
import type { ConnectionState } from "../types.js";
import { resolveConsoleLanguage } from "../whatsnew-i18n.js";
import { requestRailPanelExtraWidth, toggleRailPanel, useActiveRailPanelId, useRailChromeExpanded, useRailOverlayAlpha, useRailPanelBehavior, useRailPanelExtraWidth } from "./rail-store.js";
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
const PREFS_PANEL_WIDTHS = "fleet-console.rail.panelWidths";
const LEGACY_PREFS_PANEL_WIDTH = "fleet-console.rail.panelWidth";

function readStoredPanelWidths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PREFS_PANEL_WIDTHS);
    if (raw === null) return Object.create(null) as Record<string, number>;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return Object.create(null) as Record<string, number>;

    const widths: Record<string, number> = Object.create(null);
    for (const [panelId, width] of Object.entries(parsed)) {
      if (typeof width === "number" && Number.isFinite(width) && width >= MIN_PANEL_WIDTH) {
        widths[panelId] = Math.round(width);
      }
    }
    return widths;
  } catch { /* ignore */ }
  return Object.create(null) as Record<string, number>;
}

function readStoredPanelWidthsWithLegacyMigration(activePanelId: string | null): Record<string, number> {
  const widths = readStoredPanelWidths();
  if (activePanelId === null) return widths;

  try {
    const legacyRaw = localStorage.getItem(LEGACY_PREFS_PANEL_WIDTH);
    if (legacyRaw === null) return widths;

    const legacyWidth = Number(legacyRaw);
    if (Number.isFinite(legacyWidth) && legacyWidth >= MIN_PANEL_WIDTH) {
      widths[activePanelId] = Math.round(legacyWidth);
      localStorage.setItem(PREFS_PANEL_WIDTHS, JSON.stringify(widths));
    }
    localStorage.removeItem(LEGACY_PREFS_PANEL_WIDTH);
  } catch { /* ignore */ }
  return widths;
}

function resolvePanelWidth(
  activePanelId: string | null,
  defaultWidth: number | undefined,
  maxWidth: number,
  storedWidths: Record<string, number>,
): number {
  const rememberedWidth = activePanelId === null ? undefined : storedWidths[activePanelId];
  if (rememberedWidth !== undefined && rememberedWidth >= MIN_PANEL_WIDTH && rememberedWidth <= maxWidth) {
    return rememberedWidth;
  }
  return Math.max(MIN_PANEL_WIDTH, Math.min(maxWidth, Math.round(defaultWidth ?? DEFAULT_PANEL_WIDTH)));
}

function clearStoredPanelWidth(panelId: string): void {
  try {
    const widths = readStoredPanelWidths();
    if (!(panelId in widths)) return;
    delete widths[panelId];
    localStorage.setItem(PREFS_PANEL_WIDTHS, JSON.stringify(widths));
  } catch { /* ignore */ }
}

function saveStoredPanelWidth(activePanelId: string | null, width: number): void {
  if (activePanelId === null) return;
  try {
    const widths = readStoredPanelWidths();
    widths[activePanelId] = Math.round(width);
    localStorage.setItem(PREFS_PANEL_WIDTHS, JSON.stringify(widths));
  } catch { /* ignore */ }
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
  const activeId = useActiveRailPanelId();
  const railChromeExpanded = useRailChromeExpanded();
  const panelBehavior = useRailPanelBehavior();
  const overlayAlpha = useRailOverlayAlpha();
  const previousRailChromeExpandedRef = useRef(railChromeExpanded);
  const previousPanelBehaviorRef = useRef(panelBehavior);
  const bindings = useRailEntries();
  // 페인을 세우는 엔트리와 그냥 실행하는 엔트리. 옛 판별 유니온이 하던 구분을, 이제는
  // "이 엔트리가 세우는 페인이 있는가"라는 사실 하나가 대신한다.
  const paneEntries = bindings.filter((binding) => binding.panes.length > 0);
  const actionEntries = bindings.filter((binding) => binding.panes.length === 0);
  // 표면 스토어를 구독한다 — 슬롯이 열리고 닫힐 때 rail 아이콘이 함께 켜지고 꺼져야 한다.
  const { instances: openSurfaces } = useExpandedSurfaces();
  const openSurfaceIds = useMemo(
    () => new Set(openSurfaces.map((instance) => instance.surfaceId)),
    [openSurfaces],
  );
  const activeBinding = paneEntries.find((binding) => binding.entry.id === activeId) ?? null;
  const activePrimary = activeBinding?.panes.find((pane) => pane.role === "primary") ?? activeBinding?.panes[0] ?? null;
  const activePanelTitle = activeBinding ? resolveLocalizedText(activeBinding.entry.title, language) : "";
  const hasPanel = activeBinding !== null;
  // 폭 요구는 페인이 스스로 말한다 — 코어가 특정 패널 id를 알아보던 자리를 없앴다.
  const extraWidth = useRailPanelExtraWidth();
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const maxPanelWidth = Math.max(MIN_PANEL_WIDTH, Math.floor(viewportWidth - 148 - extraWidth));
  const extraWidthRef = useRef(extraWidth);
  extraWidthRef.current = extraWidth;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const migrationPendingRef = useRef(activeBinding === null);
  const interpretedPanelIdRef = useRef(activeBinding?.entry.id ?? null);
  const [panelWidth, setPanelWidthState] = useState(() => {
    const storedWidths = readStoredPanelWidthsWithLegacyMigration(activeBinding?.entry.id ?? null);
    return resolvePanelWidth(activeId, activePrimary?.defaultWidth, maxPanelWidth, storedWidths);
  });
  const desiredWidthRef = useRef(panelWidth);
  const panelWidthRef = useRef(panelWidth);
  const [isDragging, setIsDragging] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);

  useLayoutEffect(() => {
    const onResize = () => {
      const next = window.innerWidth;
      setViewportWidth((current) => current === next ? current : next);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useLayoutEffect(() => {
    const nextPanelId = activeBinding?.entry.id ?? null;
    if (interpretedPanelIdRef.current === nextPanelId) {
      if (isDragging || activeBinding === null || activeId === null) return;
      const rememberedWidth = readStoredPanelWidths()[activeId];
      if (rememberedWidth === undefined || rememberedWidth > maxPanelWidth || rememberedWidth === desiredWidthRef.current) return;
      desiredWidthRef.current = rememberedWidth;
      panelWidthRef.current = rememberedWidth;
      setPanelWidthState(rememberedWidth);
      return;
    }
    interpretedPanelIdRef.current = nextPanelId;
    const canMigrate = activeBinding !== null;
    const storedWidths = migrationPendingRef.current && canMigrate
      ? readStoredPanelWidthsWithLegacyMigration(activeId)
      : readStoredPanelWidths();
    if (canMigrate) migrationPendingRef.current = false;
    const next = resolvePanelWidth(activeId, activePrimary?.defaultWidth, maxPanelWidth, storedWidths);
    desiredWidthRef.current = next;
    panelWidthRef.current = next;
    setPanelWidthState(next);
  }, [activeId, activeBinding?.entry.id, activePrimary?.defaultWidth, isDragging, maxPanelWidth]);

  useLayoutEffect(() => {
    const desiredWidth = isDragging ? panelWidthRef.current : desiredWidthRef.current;
    const next = Math.max(MIN_PANEL_WIDTH, Math.min(maxPanelWidth, desiredWidth));
    if (next === panelWidthRef.current) return;
    panelWidthRef.current = next;
    setPanelWidthState(next);
  }, [isDragging, maxPanelWidth]);

  useLayoutEffect(() => {
    if (previousRailChromeExpandedRef.current && !railChromeExpanded) focusCommandBandToggleWhenPanelContainsActiveElement(rootRef.current, ".command-band-rail-toggle");
    previousRailChromeExpandedRef.current = railChromeExpanded;
  }, [railChromeExpanded]);

  useLayoutEffect(() => {
    if (previousPanelBehaviorRef.current === panelBehavior) return;
    previousPanelBehaviorRef.current = panelBehavior;
    setIsSwitching(true);

    let releaseFrame: number | null = null;
    const paintedFrame = window.requestAnimationFrame(() => {
      releaseFrame = window.requestAnimationFrame(() => setIsSwitching(false));
    });

    return () => {
      window.cancelAnimationFrame(paintedFrame);
      if (releaseFrame !== null) window.cancelAnimationFrame(releaseFrame);
    };
  }, [panelBehavior]);

  const handleResizeDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidthRef.current;
    setIsDragging(true);

    const onMove = (ev: PointerEvent) => {
      const dx = startX - ev.clientX;
      const maxWidth = Math.max(MIN_PANEL_WIDTH, Math.floor(window.innerWidth - 148 - extraWidthRef.current));
      const next = Math.max(MIN_PANEL_WIDTH, Math.min(maxWidth, Math.round(startWidth + dx)));
      panelWidthRef.current = next;
      setPanelWidthState(next);
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      desiredWidthRef.current = panelWidthRef.current;
      setIsDragging(false);
      saveStoredPanelWidth(activeIdRef.current, desiredWidthRef.current);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);

  const handleResizeKeyDown = useCallback((event: React.KeyboardEvent) => {
    let next: number;
    const step = event.shiftKey ? 64 : 16;
    const currentMaxWidth = Math.max(MIN_PANEL_WIDTH, Math.floor(window.innerWidth - 148 - extraWidthRef.current));

    switch (event.key) {
      case "ArrowLeft":
        next = panelWidthRef.current + step;
        break;
      case "ArrowRight":
        next = panelWidthRef.current - step;
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
    panelWidthRef.current = next;
    setPanelWidthState(next);
    saveStoredPanelWidth(activeIdRef.current, desiredWidthRef.current);
  }, []);

  // 메뉴의 "패널 폭 초기화" — 기억된 폭을 지우고 패널이 선언한 기본값으로 되돌린다.
  // 폭 기억 effect는 저장값이 없으면 손대지 않으므로, 지운 뒤 상태를 직접 세우면 충돌하지 않는다.
  const handleResetPanelWidth = useCallback(() => {
    const panelId = activeIdRef.current;
    if (panelId === null) return;
    clearStoredPanelWidth(panelId);
    const currentMaxWidth = Math.max(MIN_PANEL_WIDTH, Math.floor(window.innerWidth - 148 - extraWidthRef.current));
    const next = resolvePanelWidth(panelId, activePrimary?.defaultWidth, currentMaxWidth, Object.create(null) as Record<string, number>);
    desiredWidthRef.current = next;
    panelWidthRef.current = next;
    setPanelWidthState(next);
  }, [activePrimary?.defaultWidth]);

  const baseCtx: RailPanelContext = useMemo(() => ({
    theaterId,
    pathContext: { kind: "root", relPath: null, label: theaterLabel },
    api,
    language,
    theme,
    surfaces: STABLE_RAIL_SURFACES,
    launchOperation: onLaunchOperation,
  }), [theaterId, theaterLabel, api, language, theme, onLaunchOperation]);
  const ctx: RailPanelContext = useMemo(() => ({
    ...baseCtx,
    requestExtraWidth: (px: number | null) => {
      if (activeId !== null) requestRailPanelExtraWidth(activeId, px);
    },
  }), [activeId, baseCtx]);

  return (
    <div
      ref={rootRef}
      className={`right-rail${hasPanel ? " is-open" : ""}${railChromeExpanded ? " is-expanded" : " is-closed"}${isDragging ? " is-dragging" : ""}${isSwitching ? " is-switching" : ""}${panelBehavior === "overlay" ? " is-overlay" : ""}`}
      data-rail-chrome={railChromeExpanded ? "expanded" : "closed"}
      role="complementary"
      aria-label={t("rail.chrome.aria")}
      inert={!railChromeExpanded}
      style={{ "--right-rail-panel-width": `${hasPanel ? panelWidth + extraWidth : 0}px` } as CSSProperties}
    >
      <div
        className="right-rail-panel-slot"
        style={panelBehavior === "overlay"
          ? { "--right-rail-overlay-alpha": overlayAlpha / 100 } as CSSProperties
          : undefined}
      >
        {activeBinding && (
          <div
            className="right-rail-resize-handle"
            onPointerDown={handleResizeDragStart}
            // 옛 톱니 메뉴의 "패널 폭 초기화"는 조작 대상 위의 직접 조작으로 온다 —
            // 더블클릭이 기억된 폭을 지우고 패널이 선언한 기본값으로 되돌린다.
            onDoubleClick={handleResetPanelWidth}
            title={t("rail.chrome.resetWidth")}
            onKeyDown={handleResizeKeyDown}
            role="separator"
            aria-orientation="vertical"
            tabIndex={0}
            aria-label={t("rail.chrome.resizePanel", { title: activePanelTitle })}
            aria-controls={`rail-panel-${activeBinding.entry.id}`}
            aria-valuenow={Math.round(panelWidth)}
            aria-valuemin={MIN_PANEL_WIDTH}
            aria-valuemax={maxPanelWidth}
          />
        )}
        {activeBinding && (
          <RailPanelBody binding={activeBinding} activeId={activeId} ctx={ctx} connection={connection} connectionLostAt={connectionLostAt} language={language} />
        )}
      </div>
      <nav className="right-rail-icons" aria-label={t("rail.chrome.toolsAria")}>
        {/* 설정은 열 최상단에 서고 디바이더가 패널 탭과 갈라 놓는다 — 콘솔을 다스리는 일과
            작업 패널을 고르는 일은 다른 종류의 동작이다. 톱니는 이제 메뉴가 아니라 설정
            표면의 문이고, 켜짐은 다른 패널과 같은 문법(brass)으로 "지금 여기"를 말한다. */}
        <button
          id="rail-settings-toggle"
          type="button"
          className={`right-rail-ico right-rail-settings-btn${activeId === SETTINGS_RAIL_ENTRY_ID ? " is-active" : ""}`}
          aria-pressed={activeId === SETTINGS_RAIL_ENTRY_ID}
          aria-controls={activeId === SETTINGS_RAIL_ENTRY_ID ? `rail-panel-${SETTINGS_RAIL_ENTRY_ID}` : undefined}
          aria-label={t("settings.title")}
          title={t("settings.title")}
          onClick={() => toggleRailPanel(SETTINGS_RAIL_ENTRY_ID)}
        >
          <GearGlyph />
        </button>
        <div className="right-rail-divider" role="separator" aria-orientation="horizontal" />
        <div className="right-rail-tabs" role="tablist" aria-label={t("rail.chrome.panelsAria")}>
          {paneEntries.filter((binding) => binding.core && binding.entry.id !== SETTINGS_RAIL_ENTRY_ID).map(({ entry }) => (
            <RailIcon key={entry.id} entry={entry} context={baseCtx} language={language} isActive={activeId === entry.id} />
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
        <div className="right-rail-tabs" role="tablist" aria-label={t("rail.chrome.panelsAria")}>
          {paneEntries.filter((binding) => !binding.core).map(({ entry }) => (
            <RailIcon key={entry.id} entry={entry} context={baseCtx} language={language} isActive={activeId === entry.id} />
          ))}
        </div>
      </nav>
    </div>
  );
}

interface RailPanelBodyProps {
  readonly binding: RailEntryBinding;
  readonly activeId: string | null;
  readonly ctx: RailPanelContext;
  readonly connection: ConnectionState;
  readonly connectionLostAt: number | null;
  readonly language: ConsoleLocale;
}

// 패널 본문은 무거운 플러그인 콘텐츠(파일 트리·diff·Codex)를 렌더한다. 폭·알파와 무관한
// props만 받는 memo 경계로 리사이즈/알파 드래그 중 본문 재렌더를 건너뛰고, 경량 헤더는
// 경계 밖에서 자유롭게 재렌더한다(좌측 SideBar처럼 가벼운 부분만 재렌더).
const RailPanelBody = memo(function RailPanelBody({ binding, activeId, ctx, connection, connectionLostAt, language }: RailPanelBodyProps) {
  const t = useT();
  const connectionLostTime = connectionLostAt === null ? "" : new Date(connectionLostAt).toLocaleTimeString(language);
  const staleVisible = connection !== "live" && connectionLostAt !== null;
  const panelBodyRef = useRef<HTMLDivElement>(null);
  const panelContentRef = useRef<HTMLDivElement>(null);
  const staleVeilRef = useRef<HTMLDivElement>(null);
  const reconnectButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const previousStaleVisibleRef = useRef(false);

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

  // 설정은 탭이 아니라 문(토글)이 연다 — 탭 없는 tabpanel은 고아가 되므로, 문이 여는 표면은
  // 문을 라벨로 삼는 region으로 선다. 탭 문법은 실제 탭(rail-tab-*)이 있는 엔트리만 쓴다.
  const doorSurface = binding.entry.id === SETTINGS_RAIL_ENTRY_ID;
  return (
    <div
      ref={panelBodyRef}
      id={`rail-panel-${binding.entry.id}`}
      className="right-rail-panel-body"
      role={doorSurface ? "region" : "tabpanel"}
      aria-labelledby={doorSurface ? "rail-settings-toggle" : `rail-tab-${activeId}`}
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
          onRequestExtraWidth={ctx.requestExtraWidth}
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
      role={entry.activate ? "button" : "tab"}
      aria-selected={entry.activate ? undefined : isActive}
      // 표면을 여닫는 동작은 탭이 아니라 토글 버튼이다 — 켜짐은 pressed로 말한다.
      aria-pressed={entry.activate && entry.surfaceId !== undefined ? isActive : undefined}
      aria-label={title}
      disabled={entry.activate !== undefined && context.theaterId === null}
      title={title}
      onClick={handleClick}
    >
      {icon}
    </button>
  );
}

/* 패널 접기 아이콘 — 우측 영역을 선으로 구분한 패널 모양(#44 시안, 우측 미러). */

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";
import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import "../styles/rail.css";
import { BUILT_IN_RAIL_PANELS } from "./built-in-panels.js";
import { focusCommandBandToggleWhenPanelContainsActiveElement } from "../focus-guards.js";
import { useGlobalSettingsStore } from "../global-settings-store.js";
import { useT } from "../i18n/index.js";
import { ReconnectButton } from "../components/reconnect-button.js";
import { getState, subscribe } from "../store.js";
import type { ConnectionState } from "../types.js";
import { resolveConsoleLanguage } from "../whatsnew-i18n.js";
import { closeRailPanel, RAIL_OVERLAY_ALPHA_DEFAULT, RAIL_OVERLAY_ALPHA_MAX, RAIL_OVERLAY_ALPHA_MIN, requestRailPanelExtraWidth, setRailOverlayAlpha, toggleRailPanel, toggleRailPanelBehavior, useActiveRailPanelId, useRailChromeExpanded, useRailOverlayAlpha, useRailPanelBehavior, useRailPanelExtraWidth, type RailOverlayAlpha } from "./rail-store.js";
import { useRailPanels } from "./rail-registry.js";
import { useCodexSplitExtraWidth } from "./use-codex-split-extra-width.js";

interface RightRailProps {
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
}

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

function saveStoredPanelWidth(activePanelId: string | null, width: number): void {
  if (activePanelId === null) return;
  try {
    const widths = readStoredPanelWidths();
    widths[activePanelId] = Math.round(width);
    localStorage.setItem(PREFS_PANEL_WIDTHS, JSON.stringify(widths));
  } catch { /* ignore */ }
}

export function RightRail({ theaterId, api }: RightRailProps) {
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
  const pluginPanels = useRailPanels();
  const builtInPanels = BUILT_IN_RAIL_PANELS;
  const allPanels = [...builtInPanels, ...pluginPanels];
  const activePanel = allPanels.find((p) => p.id === activeId) ?? null;
  const activePanelTitle = activePanel ? resolveLocalizedText(activePanel.title, language) : "";
  const hasPanel = activePanel !== null;
  const extraWidth = useCodexSplitExtraWidth(activeId) + (activePanel?.preferredExtraWidth ?? 0) + useRailPanelExtraWidth();
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const maxPanelWidth = Math.max(MIN_PANEL_WIDTH, Math.floor(viewportWidth - 148 - extraWidth));
  const extraWidthRef = useRef(extraWidth);
  extraWidthRef.current = extraWidth;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const migrationPendingRef = useRef(activePanel === null);
  const interpretedPanelIdRef = useRef(activePanel?.id ?? null);
  const [panelWidth, setPanelWidthState] = useState(() => {
    const storedWidths = readStoredPanelWidthsWithLegacyMigration(activePanel?.id ?? null);
    return resolvePanelWidth(activeId, activePanel?.defaultWidth, maxPanelWidth, storedWidths);
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
    const nextPanelId = activePanel?.id ?? null;
    if (interpretedPanelIdRef.current === nextPanelId) {
      if (isDragging || activePanel === null || activeId === null) return;
      const rememberedWidth = readStoredPanelWidths()[activeId];
      if (rememberedWidth === undefined || rememberedWidth > maxPanelWidth || rememberedWidth === desiredWidthRef.current) return;
      desiredWidthRef.current = rememberedWidth;
      panelWidthRef.current = rememberedWidth;
      setPanelWidthState(rememberedWidth);
      return;
    }
    interpretedPanelIdRef.current = nextPanelId;
    const canMigrate = activePanel !== null;
    const storedWidths = migrationPendingRef.current && canMigrate
      ? readStoredPanelWidthsWithLegacyMigration(activeId)
      : readStoredPanelWidths();
    if (canMigrate) migrationPendingRef.current = false;
    const next = resolvePanelWidth(activeId, activePanel?.defaultWidth, maxPanelWidth, storedWidths);
    desiredWidthRef.current = next;
    panelWidthRef.current = next;
    setPanelWidthState(next);
  }, [activeId, activePanel?.id, activePanel?.defaultWidth, isDragging, maxPanelWidth]);

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

  const ctx: RailPanelContext = useMemo(() => ({
    theaterId,
    pathContext: { kind: "root", relPath: null, label: theaterLabel },
    api,
    language,
    theme,
    requestExtraWidth: (px: number | null) => {
      if (activeId !== null) requestRailPanelExtraWidth(activeId, px);
    },
  }), [theaterId, theaterLabel, api, language, theme, activeId]);

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
        {activePanel && (
          <div
            className="right-rail-resize-handle"
            onPointerDown={handleResizeDragStart}
            onKeyDown={handleResizeKeyDown}
            role="separator"
            aria-orientation="vertical"
            tabIndex={0}
            aria-label={t("rail.chrome.resizePanel", { title: activePanelTitle })}
            aria-controls={`rail-panel-${activePanel.id}`}
            aria-valuenow={Math.round(panelWidth)}
            aria-valuemin={MIN_PANEL_WIDTH}
            aria-valuemax={maxPanelWidth}
          />
        )}
        {activePanel && (
          <>
            <RailPanelHead activePanelTitle={activePanelTitle} panelBehavior={panelBehavior} overlayAlpha={overlayAlpha} />
            <RailPanelBody activePanel={activePanel} activeId={activeId} ctx={ctx} connection={connection} connectionLostAt={connectionLostAt} language={language} />
          </>
        )}
      </div>
      <nav className="right-rail-icons" aria-label={t("rail.chrome.toolsAria")}>
        <div className="right-rail-tabs" role="tablist" aria-label={t("rail.chrome.panelsAria")}>
          {builtInPanels.map((panel) => (
            <RailIcon key={panel.id} panel={panel} language={language} isActive={activeId === panel.id} />
          ))}
          {builtInPanels.length > 0 && pluginPanels.length > 0 ? (
            <div className="right-rail-divider" role="separator" aria-hidden="true" />
          ) : null}
          {pluginPanels.map((panel) => (
            <RailIcon key={panel.id} panel={panel} language={language} isActive={activeId === panel.id} />
          ))}
        </div>
      </nav>
    </div>
  );
}

interface RailPanelHeadProps {
  readonly activePanelTitle: string;
  readonly panelBehavior: "push" | "overlay";
  readonly overlayAlpha: RailOverlayAlpha;
}

function RailPanelHead({ activePanelTitle, panelBehavior, overlayAlpha }: RailPanelHeadProps) {
  const t = useT();

  return (
    <div className="right-rail-panel-head">
      <span className="right-rail-panel-title">{activePanelTitle}</span>
      <button
        className={`right-rail-float-toggle${panelBehavior === "overlay" ? " is-active" : ""}`}
        type="button"
        aria-pressed={panelBehavior === "overlay"}
        aria-label={t("rail.chrome.floatToggle")}
        title={t("rail.chrome.floatLabel")}
        onClick={toggleRailPanelBehavior}
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" /><rect x="7.5" y="7.5" width="5" height="4" rx="1" fill="currentColor" /></svg>
      </button>
      {panelBehavior === "overlay" ? (
        <div className="right-rail-alpha">
          <input
            className="right-rail-alpha-slider"
            type="range"
            min={RAIL_OVERLAY_ALPHA_MIN}
            max={RAIL_OVERLAY_ALPHA_MAX}
            step={1}
            value={overlayAlpha}
            aria-label={t("rail.chrome.opacityAria")}
            onChange={(event) => setRailOverlayAlpha(Number(event.currentTarget.value))}
            onDoubleClick={() => setRailOverlayAlpha(RAIL_OVERLAY_ALPHA_DEFAULT)}
            style={{ "--alpha-fill": `${((overlayAlpha - RAIL_OVERLAY_ALPHA_MIN) / (RAIL_OVERLAY_ALPHA_MAX - RAIL_OVERLAY_ALPHA_MIN)) * 100}%` } as CSSProperties}
          />
          <span className="right-rail-alpha-value" aria-hidden="true">{overlayAlpha}%</span>
        </div>
      ) : null}
      <button
        className="right-rail-close-btn"
        type="button"
        aria-label={t("rail.chrome.closePanel", { title: activePanelTitle })}
        onClick={closeRailPanel}
      >
        ✕
      </button>
    </div>
  );
}

interface RailPanelBodyProps {
  readonly activePanel: RailPanelDescriptor;
  readonly activeId: string | null;
  readonly ctx: RailPanelContext;
  readonly connection: ConnectionState;
  readonly connectionLostAt: number | null;
  readonly language: ConsoleLocale;
}

// 패널 본문은 무거운 플러그인 콘텐츠(파일 트리·diff·Codex)를 렌더한다. 폭·알파와 무관한
// props만 받는 memo 경계로 리사이즈/알파 드래그 중 본문 재렌더를 건너뛰고, 경량 헤더는
// 경계 밖에서 자유롭게 재렌더한다(좌측 SideBar처럼 가벼운 부분만 재렌더).
const RailPanelBody = memo(function RailPanelBody({ activePanel, activeId, ctx, connection, connectionLostAt, language }: RailPanelBodyProps) {
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

  return (
    <div ref={panelBodyRef} id={`rail-panel-${activePanel.id}`} className="right-rail-panel-body" role="tabpanel" aria-labelledby={`rail-tab-${activeId}`} tabIndex={-1}>
      <div ref={panelContentRef} className="right-rail-panel-content" inert={staleVisible || undefined}>
        {activePanel.render(ctx)}
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
  readonly panel: RailPanelDescriptor;
  readonly language: ConsoleLocale;
  readonly isActive: boolean;
}

function RailIcon({ panel, language, isActive }: RailIconProps) {
  const handleClick = useCallback(() => toggleRailPanel(panel.id), [panel.id]);
  const icon = typeof panel.icon === "function" ? panel.icon() : panel.icon;
  const title = resolveLocalizedText(panel.title, language);

  return (
    <button
      id={`rail-tab-${panel.id}`}
      className={`right-rail-ico${isActive ? " is-active" : ""}`}
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-label={title}
      title={title}
      onClick={handleClick}
    >
      {icon}
    </button>
  );
}

/* 패널 접기 아이콘 — 우측 영역을 선으로 구분한 패널 모양(#44 시안, 우측 미러). */

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";
import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import "../styles/rail.css";
import { BUILT_IN_RAIL_PANELS } from "./built-in-panels.js";
import { focusCommandBandToggleWhenPanelContainsActiveElement } from "../components/command-band-focus.js";
import { useGlobalSettingsStore } from "../global-settings-store.js";
import { getState, subscribe } from "../store.js";
import { resolveConsoleLanguage } from "../whatsnew-i18n.js";
import { closeRailPanel, requestRailPanelExtraWidth, setRailOverlayAlpha, toggleRailPanel, toggleRailPanelBehavior, useActiveRailPanelId, useRailChromeExpanded, useRailOverlayAlpha, useRailPanelBehavior, useRailPanelExtraWidth, type RailOverlayAlpha } from "./rail-store.js";
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
const FALLBACK_THEATER_LABEL = "Theater";
const OVERLAY_ALPHA_PRESETS: readonly { readonly label: string; readonly value: RailOverlayAlpha }[] = [
  { label: "Solid", value: 100 },
  { label: "90", value: 90 },
  { label: "75", value: 75 },
  { label: "60", value: 60 },
];

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
  const theaterLabel = useSyncExternalStore(
    subscribe,
    () => getState().theaters.find((theater) => theater.id === theaterId)?.label ?? FALLBACK_THEATER_LABEL,
    () => FALLBACK_THEATER_LABEL,
  );
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
    requestExtraWidth: (px: number | null) => {
      if (activeId !== null) requestRailPanelExtraWidth(activeId, px);
    },
  }), [theaterId, theaterLabel, api, language, activeId]);

  return (
    <div
      ref={rootRef}
      className={`right-rail${hasPanel ? " is-open" : ""}${railChromeExpanded ? " is-expanded" : " is-closed"}${isDragging ? " is-dragging" : ""}${isSwitching ? " is-switching" : ""}${panelBehavior === "overlay" ? " is-overlay" : ""}`}
      data-rail-chrome={railChromeExpanded ? "expanded" : "closed"}
      role="complementary"
      aria-label="Activity Rail"
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
            aria-label={`Resize ${activePanelTitle} panel`}
            aria-controls={`rail-panel-${activePanel.id}`}
            aria-valuenow={Math.round(panelWidth)}
            aria-valuemin={MIN_PANEL_WIDTH}
            aria-valuemax={maxPanelWidth}
          />
        )}
        {activePanel && (
          <RailPanelContent activePanel={activePanel} activePanelTitle={activePanelTitle} activeId={activeId} ctx={ctx} panelBehavior={panelBehavior} overlayAlpha={overlayAlpha} />
        )}
      </div>
      <nav className="right-rail-icons" aria-label="Activity tools">
        <div className="right-rail-tabs" role="tablist" aria-label="Activity panels">
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

interface RailPanelContentProps {
  readonly activePanel: RailPanelDescriptor;
  readonly activePanelTitle: string;
  readonly activeId: string | null;
  readonly ctx: RailPanelContext;
  readonly panelBehavior: "push" | "overlay";
  readonly overlayAlpha: RailOverlayAlpha;
}

// 패널 본문은 무거운 플러그인 콘텐츠(파일 트리·diff·Codex)를 렌더한다. 리사이즈 드래그가
// 매 프레임 RightRail을 재렌더해도 이 본문이 함께 재렌더되면 끊김이 생기므로, 폭과 무관한
// (activePanel·ctx·activeId·panelBehavior·overlayAlpha) props로 memo해 드래그 중 본문 재렌더를 건너뛴다(좌측 SideBar처럼 가벼운 부분만 재렌더).
const RailPanelContent = memo(function RailPanelContent({ activePanel, activePanelTitle, activeId, ctx, panelBehavior, overlayAlpha }: RailPanelContentProps) {
  return (
    <>
      <div className="right-rail-panel-head">
        <span className="right-rail-panel-title">{activePanelTitle}</span>
        <button
          className={`right-rail-float-toggle${panelBehavior === "overlay" ? " is-active" : ""}`}
          type="button"
          aria-pressed={panelBehavior === "overlay"}
          aria-label="Float panel over the Map"
          onClick={toggleRailPanelBehavior}
        >
          Float over Map
        </button>
        {panelBehavior === "overlay" ? (
          <div className="right-rail-opacity-segments" role="group" aria-label="Panel opacity">
            {OVERLAY_ALPHA_PRESETS.map((preset) => {
              const isActive = preset.value === overlayAlpha;
              return (
                <button
                  key={preset.value}
                  className={`right-rail-opacity-segment${isActive ? " is-active" : ""}`}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => setRailOverlayAlpha(preset.value)}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        ) : null}
        <button
          className="right-rail-close-btn"
          type="button"
          aria-label={`Close ${activePanelTitle}`}
          onClick={closeRailPanel}
        >
          ✕
        </button>
      </div>
      <div id={`rail-panel-${activePanel.id}`} className="right-rail-panel-body" role="tabpanel" aria-labelledby={`rail-tab-${activeId}`}>
        {activePanel.render(ctx)}
      </div>
    </>
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

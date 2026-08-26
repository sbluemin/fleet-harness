import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";
import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import "../styles/rail.css";
import { BUILT_IN_RAIL_PANELS } from "./built-in-panels.js";
import { focusCommandBandToggleWhenPanelContainsActiveElement } from "../shortcuts.js";
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
  readonly onLaunchOperation?: (pluginId: string, kind: OperationLaunchKind) => void;
}

const MIN_PANEL_WIDTH = 240;
const DEFAULT_PANEL_WIDTH = 312;
// 호버-리빌 헤더 입력 계약: 진입은 pointermove로만 판정하고(스크롤-언더-포인터 오발화 방지)
// 의도 지연을 거친다. 진입 띠와 64px 이탈 경계 사이는 히스테리시스 중립 지대다.
// 진입 띠는 패널 본문 상단 컨트롤(저장소 동기화·Skills 탭 등)의 클릭을 방해하지 않도록
// 가장자리 12px로 좁게 잡는다 — 24px에서는 상단 첫 줄 컨트롤로 향하는 호버가 헤더를 오발화했다.
const HEAD_REVEAL_ZONE_PX = 12;
const HEAD_REVEAL_TOUCH_ZONE_PX = 28;
const HEAD_HIDE_BOUNDARY_PX = 64;
const HEAD_REVEAL_INTENT_DELAY_MS = 120;
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
  const pluginContributions = useRailPanels();
  const builtInPanels = BUILT_IN_RAIL_PANELS;
  const pluginPanels = pluginContributions.filter((panel) => panel.render !== undefined);
  const pluginActions = pluginContributions.filter((panel) => panel.activate !== undefined && panel.render === undefined);
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
  const [headRevealed, setHeadRevealed] = useState(false);
  const headRevealedRef = useRef(headRevealed);
  headRevealedRef.current = headRevealed;
  const revealIntentTimerRef = useRef<number | null>(null);

  const cancelRevealIntent = useCallback(() => {
    if (revealIntentTimerRef.current === null) return;
    window.clearTimeout(revealIntentTimerRef.current);
    revealIntentTimerRef.current = null;
  }, []);

  const holdHeadOpen = useCallback(() => {
    cancelRevealIntent();
    if (!headRevealedRef.current) setHeadRevealed(true);
  }, [cancelRevealIntent]);

  const hideHeadUnlessFocused = useCallback(() => {
    // 키보드 포커스(:focus-visible)가 헤더 안에 남아 있는 동안만 숨기지 않는다 — 숨기면
    // 포커스가 투명한 컨트롤에 갇힌다. 마우스 클릭·드래그가 남긴 잔류 포커스는 리빌을
    // 붙잡는 근거가 아니므로, 블러로 걷어내고 즉시 숨긴다.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(".right-rail-panel-head-reveal") !== null) {
      if (active.matches(":focus-visible")) return;
      active.blur();
    }
    setHeadRevealed(false);
  }, []);

  // 이탈은 지연 없이 즉시 숨긴다 — 리빌 진입만 의도 지연을 거친다.
  const releaseHead = useCallback(() => {
    cancelRevealIntent();
    if (!headRevealedRef.current) return;
    hideHeadUnlessFocused();
  }, [cancelRevealIntent, hideHeadUnlessFocused]);

  // 패널이 바뀌거나 닫히면 리빌 상태를 초기화한다.
  useLayoutEffect(() => {
    cancelRevealIntent();
    setHeadRevealed(false);
  }, [activeId, cancelRevealIntent]);

  useLayoutEffect(() => () => {
    cancelRevealIntent();
  }, [cancelRevealIntent]);

  const handleSlotPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // 진입 판정은 hover 포인터에만 적용한다. 터치는 pointerdown 폴백이 담당한다.
    if (event.pointerType === "touch") return;
    const slotTop = event.currentTarget.getBoundingClientRect().top;
    const y = event.clientY - slotTop;
    if (y <= HEAD_REVEAL_ZONE_PX) {
      if (headRevealedRef.current || revealIntentTimerRef.current !== null) return;
      revealIntentTimerRef.current = window.setTimeout(() => {
        revealIntentTimerRef.current = null;
        setHeadRevealed(true);
      }, HEAD_REVEAL_INTENT_DELAY_MS);
      return;
    }
    cancelRevealIntent();
    if (y > HEAD_HIDE_BOUNDARY_PX) releaseHead();
  }, [cancelRevealIntent, releaseHead]);

  const handleSlotPointerLeave = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // 터치 탭은 pointerup 뒤에 pointerleave가 따라온다. 그걸 숨김으로 받으면
    // 방금 연 헤더가 접혀 두 번째 탭(플로팅·닫기)이 닿지 않는다.
    if (event.pointerType === "touch") return;
    releaseHead();
  }, [releaseHead]);

  const handleSlotPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") return;
    const slotTop = event.currentTarget.getBoundingClientRect().top;
    const y = event.clientY - slotTop;
    if (!headRevealedRef.current) {
      // 상단 가장자리 탭 = 리빌. preventDefault 없이 콘텐츠 탭도 그대로 통과시킨다.
      if (y <= HEAD_REVEAL_TOUCH_ZONE_PX) holdHeadOpen();
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".right-rail-panel-head-reveal") === null) {
      hideHeadUnlessFocused();
    }
  }, [hideHeadUnlessFocused, holdHeadOpen]);

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

  const baseCtx: RailPanelContext = useMemo(() => ({
    theaterId,
    pathContext: { kind: "root", relPath: null, label: theaterLabel },
    api,
    language,
    theme,
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
        onPointerMove={hasPanel ? handleSlotPointerMove : undefined}
        onPointerLeave={hasPanel ? handleSlotPointerLeave : undefined}
        onPointerDown={hasPanel ? handleSlotPointerDown : undefined}
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
            <RailPanelHead
              activePanelTitle={activePanelTitle}
              panelBehavior={panelBehavior}
              overlayAlpha={overlayAlpha}
              revealed={headRevealed}
              onHoldOpen={holdHeadOpen}
              onRelease={releaseHead}
            />
            <div className="right-rail-panel-peek" aria-hidden="true" />
            <RailPanelBody activePanel={activePanel} activeId={activeId} ctx={ctx} connection={connection} connectionLostAt={connectionLostAt} language={language} />
          </>
        )}
      </div>
      <nav className="right-rail-icons" aria-label={t("rail.chrome.toolsAria")}>
        <div className="right-rail-tabs" role="tablist" aria-label={t("rail.chrome.panelsAria")}>
          {builtInPanels.map((panel) => (
            <RailIcon key={panel.id} panel={panel} context={baseCtx} language={language} isActive={activeId === panel.id} />
          ))}
          {builtInPanels.length > 0 && (pluginActions.length > 0 || pluginPanels.length > 0) ? (
            <div className="right-rail-divider" role="separator" aria-hidden="true" />
          ) : null}
        </div>
        {pluginActions.map((panel) => (
          <RailIcon key={panel.id} panel={panel} context={baseCtx} language={language} isActive={false} />
        ))}
        <div className="right-rail-tabs" role="tablist" aria-label={t("rail.chrome.panelsAria")}>
          {pluginPanels.map((panel) => (
            <RailIcon key={panel.id} panel={panel} context={baseCtx} language={language} isActive={activeId === panel.id} />
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
  readonly revealed: boolean;
  readonly onHoldOpen: () => void;
  readonly onRelease: () => void;
}

// 헤더의 세 통제(타이틀·플로팅·닫기)는 전부 저빈도라 상주 캡션 대신 호버-리빌
// 오버레이로 소환한다. 숨김 상태에서도 DOM에 남아 Tab 진입(focus)이 리빌 경로가 된다.
function RailPanelHead({ activePanelTitle, panelBehavior, overlayAlpha, revealed, onHoldOpen, onRelease }: RailPanelHeadProps) {
  const t = useT();

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    // slot의 진입/이탈 판정으로 버블되면 32px 헤더 하단부(y>12px)가 이탈로 오판된다.
    event.stopPropagation();
    onHoldOpen();
  };

  const handlePointerLeave = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    onRelease();
  };

  const handleBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    onRelease();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    // Esc 닫기는 헤더 포커스 범위로 한정한다 — 패널 본문(Shell PTY 등)의 Esc 어휘를 뺏지 않는다.
    event.stopPropagation();
    closeRailPanel();
  };

  return (
    <div
      className={`right-rail-panel-head-reveal${revealed ? " is-revealed" : ""}`}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onFocusCapture={onHoldOpen}
      onBlurCapture={handleBlur}
      onKeyDown={handleKeyDown}
    >
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
              className="right-rail-alpha-slider fleet-slider"
              type="range"
              min={RAIL_OVERLAY_ALPHA_MIN}
              max={RAIL_OVERLAY_ALPHA_MAX}
              step={1}
              value={overlayAlpha}
              aria-label={t("rail.chrome.opacityAria")}
              onChange={(event) => setRailOverlayAlpha(Number(event.currentTarget.value))}
              onDoubleClick={() => setRailOverlayAlpha(RAIL_OVERLAY_ALPHA_DEFAULT)}
              style={{ "--slider-fill": `${((overlayAlpha - RAIL_OVERLAY_ALPHA_MIN) / (RAIL_OVERLAY_ALPHA_MAX - RAIL_OVERLAY_ALPHA_MIN)) * 100}%` } as CSSProperties}
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
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" /></svg>
        </button>
      </div>
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
        {activePanel.render?.(ctx)}
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
  readonly context: RailPanelContext;
  readonly language: ConsoleLocale;
  readonly isActive: boolean;
}

function RailIcon({ panel, context, language, isActive }: RailIconProps) {
  const handleClick = useCallback(() => {
    if (panel.activate) {
      if (context.theaterId === null) return;
      panel.activate(context);
      return;
    }
    toggleRailPanel(panel.id);
  }, [context, panel]);
  const icon = typeof panel.icon === "function" ? panel.icon() : panel.icon;
  const title = resolveLocalizedText(panel.title, language);

  return (
    <button
      id={`rail-tab-${panel.id}`}
      className={`right-rail-ico${isActive ? " is-active" : ""}`}
      type="button"
      role={panel.activate ? "button" : "tab"}
      aria-selected={panel.activate ? undefined : isActive}
      aria-label={title}
      disabled={panel.activate !== undefined && context.theaterId === null}
      title={title}
      onClick={handleClick}
    >
      {icon}
    </button>
  );
}

/* 패널 접기 아이콘 — 우측 영역을 선으로 구분한 패널 모양(#44 시안, 우측 미러). */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";

import type { ConsoleLocale, Translate } from "@fleet-console/i18n";
import { getViewModeSnapshot } from "../../../core/client/src/integration/view-mode-store.js";
import { openSettingsSurface, closeSettingsModal } from "../../settings/client/settings-door.js";
import { pluginSettingsSectionId } from "../../settings/client/settings-entry.js";
import { QUOTA_PLUGIN_ID, QUOTA_USAGE_SECTION_ID } from "./section-id.js";
import type { ComposerTopEntryContext } from "../../workspace/shared/surface-contracts.js";
import { useStoreSnapshot } from "@fleet-console/ui/store";

import type { ProviderDto, QuotaSummaryDto, QuotaWindow } from "@fleet-console/ai-gateway";
import { sanitizeProviderOrder, type ProviderId } from "../shared/provider-order.js";
import { providerGlyph } from "./cli-glyphs.js";
import { getT, type QuotaMessageKey } from "./i18n/index.js";
import { blockMessage, formatSpendUsd, isSpendProvider, spendSeverity } from "./spend-section.js";
import {
  displayPlanName,
  elapsed,
  elapsedMarkPercent,
  formatCountdown,
  meterSeverity,
  mostUrgentWindow,
  NO_SUBSCRIPTION_KEY,
  projectedSpan,
  providerName,
  QuotaPanel,
  riskNote,
  windowLabel,
} from "./quota-panel.js";
import { getQuotaApi, getQuotaSummarySnapshot, holdQuotaSummary, subscribeQuotaApi, subscribeQuotaSummary } from "./summary-store.js";
import { getQuotaToolbarSetting, subscribeQuotaToolbarSetting } from "./toolbar-setting.js";

/** 컴포저 오른쪽 위의 사용량 요약. 평상시에는 공급자 글리프를 정밀 원형 링으로 감싸 공간을 줄이고,
 * 경고·위험 압박에 들어간 공급자만 캡슐 안에 2층 퍼센트를 상시 표출한다. 호버 시 공유 글라이딩 카드로
 * 전 창·리셋·지출을, 클릭 시 전체 사용 한도 팝업을 연다. */

/** Claude의 세션 창(5시간) — 기간을 싣지 않은 세션 창을 짧은 쪽에 세우는 기준. */
const SESSION_FALLBACK_MS = 5 * 3_600_000;

/** 원형 링 기하(viewBox 0 0 24 24) — 1~4% 미세 사용량도 12시 방향 최소 호(4%)로 존재감을 지킨다. */
const RING_RADIUS = 10.3;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const RING_MIN_VISIBLE_PERCENT = 4;

/** 호버 프리뷰 의도 지연과 이웃 링 간 글라이드 유예(ToolbarTipLayer와 같은 리듬). */
const HOVER_SHOW_DELAY_MS = 80;
const HOVER_HANDOFF_GRACE_MS = 260;
const HOVER_EXIT_UNMOUNT_MS = 180;
const HOVER_GAP = 10;
const HOVER_ARROW_INSET = 14;

type T = Translate<QuotaMessageKey>;
type RingSeverity = "normal" | "warning" | "critical";

const SEVERITY_RANK: Readonly<Record<RingSeverity, number>> = {
  normal: 0,
  warning: 1,
  critical: 2,
};

interface PillLine {
  readonly percent: number;
  readonly severity: RingSeverity;
}

export interface QuotaToolbarReading {
  readonly id: ProviderId;
  /** 비어 있으면 아직 읽지 못했거나 읽을 수 없는 공급자다 — 칸은 남기고 점선 링으로 상태를 알린다. */
  readonly lines: readonly QuotaWindow[];
  /**
   * 창이 아니라 금액으로만 아는 공급자(Gemini·Anthropic)의 예산 사용률. 창을 만들지 않고 이 칸에만 싣는다 —
   * 지출을 QuotaWindow로 만들면 routing이 그것으로 압박도를 계산한다.
   */
  readonly spendPercent?: number;
}

interface RingPresentation {
  readonly id: ProviderId;
  readonly provider: ProviderDto | undefined;
  readonly windows: readonly QuotaWindow[];
  readonly loading: boolean;
  readonly disconnected: boolean;
  readonly stale: boolean;
  readonly exhausted: boolean;
  readonly percent: number | null;
  readonly severity: RingSeverity;
  /** 경고·위험 공급자 캡슐의 2층 퍼센트(최대 2줄). 평상시 링 ↔ 캡슐 전환 모션이 끊기지 않도록 읽을 수 있을 때 채워 둔다. */
  readonly pillLines: readonly PillLine[];
  readonly elevated: boolean;
}

function readableWindows(provider: ProviderDto | undefined): readonly QuotaWindow[] {
  if (provider === undefined || (provider.status !== "ok" && provider.status !== "stale")) return [];
  // 집계 창은 형제 풀의 합이다 — 풀이 있으면 그 풀들이 공급자를 대변한다.
  const windows = provider.windows ?? [];
  const pools = windows.filter((window) => window.isAggregate !== true);
  return pools.length > 0 ? pools : windows;
}

/** 고른 공급자마다 한 칸 — 사용자 순서를 따른다. 값이 없어도 칸은 선다(켜고 끈 것만 폭을 바꾼다). */
export function toolbarReadings(
  data: QuotaSummaryDto | null,
  shown: readonly ProviderId[],
  order: readonly ProviderId[],
): readonly QuotaToolbarReading[] {
  return sanitizeProviderOrder(order)
    .filter((id) => shown.includes(id))
    .map((id) => {
      const lines = summaryLines(readableWindows(data?.providers[id]));
      const spendPercent = lines.length === 0 ? data?.providers[id]?.spend?.usedPercent : undefined;
      return { id, lines, ...(spendPercent !== undefined ? { spendPercent } : {}) };
    });
}

/** 공급자가 풀을 나눠 재면 풀마다 한 줄 — 풀마다 가장 급한 창 하나.
 *  한 풀이 소진돼도 다른 풀의 숫자에 묻히지 않는다. 그 밖에는 두 줄 — 가장 짧은 창 하나와, 남은 창 중 가장 급한 하나. */
export function summaryLines(windows: readonly QuotaWindow[]): readonly QuotaWindow[] {
  if (windows.length <= 1) return windows;
  const byPool = new Map<string, readonly QuotaWindow[]>();
  for (const window of windows) {
    // 범위 없는 창은 공급자 공통 한도다 — 풀 하나로 묶어 한 줄로 대표한다.
    const pool = window.scope?.startsWith("pool:") ? window.scope : "";
    byPool.set(pool, [...(byPool.get(pool) ?? []), window]);
  }
  if ([...byPool.keys()].some((pool) => pool !== "")) {
    return [...byPool.values()].flatMap((pool) => {
      const urgent = mostUrgentWindow(pool);
      return urgent === null ? [] : [urgent];
    });
  }
  const duration = (window: QuotaWindow) => window.period?.durationMs ?? (window.id === "session" ? SESSION_FALLBACK_MS : Number.POSITIVE_INFINITY);
  const short = windows.reduce((shortest, window) => (duration(window) < duration(shortest) ? window : shortest));
  const long = mostUrgentWindow(windows.filter((window) => window !== short));
  return long === null ? [short] : [short, long];
}

function pillLinesOf(reading: QuotaToolbarReading, readable: boolean): readonly PillLine[] {
  if (!readable) return [];
  if (reading.lines.length > 0) {
    const entries = reading.lines.map((window, index) => ({
      index,
      percent: Math.round(window.usedPercent),
      rawPercent: window.usedPercent,
      severity: meterSeverity(window),
    }));
    const selected = entries.length <= 2
      ? entries
      : [...entries]
        .sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || (b.rawPercent - a.rawPercent))
        .slice(0, 2)
        .sort((a, b) => a.index - b.index);
    return selected.map(({ percent, severity }) => ({ percent, severity }));
  }
  if (reading.spendPercent !== undefined) {
    return [{ percent: Math.round(reading.spendPercent), severity: spendSeverity(reading.spendPercent) }];
  }
  return [];
}

function ringPresentationOf(
  reading: QuotaToolbarReading,
  data: QuotaSummaryDto | null,
): RingPresentation {
  const provider = data?.providers[reading.id];
  const loading = data === null;
  const status = provider?.status;
  const readable = !loading && (status === "ok" || status === "stale");
  const windows = readable ? readableWindows(provider) : [];
  const primary = mostUrgentWindow(windows);

  const percent = primary !== null
    ? primary.usedPercent
    : (readable && reading.spendPercent !== undefined ? reading.spendPercent : null);
  const severity: RingSeverity = primary !== null
    ? meterSeverity(primary)
    : (percent !== null ? spendSeverity(percent) : "normal");
  const pillLines = pillLinesOf(reading, readable);
  const elevated = readable && severity !== "normal" && pillLines.length > 0;

  return {
    id: reading.id,
    provider,
    windows,
    loading,
    disconnected: !loading && !readable,
    stale: !loading && status === "stale",
    exhausted: readable && percent !== null && percent >= 100,
    percent,
    severity,
    pillLines,
    elevated,
  };
}

function ringArcOffset(percent: number): number {
  const clamped = Math.min(100, Math.max(0, percent));
  if (clamped <= 0) return RING_CIRCUMFERENCE;
  const visual = Math.max(clamped, RING_MIN_VISIBLE_PERCENT);
  return RING_CIRCUMFERENCE * (1 - visual / 100);
}

function readingAriaLabel(
  reading: QuotaToolbarReading,
  data: QuotaSummaryDto | null,
  mobile: boolean,
  t: T,
): string {
  const name = providerName(reading.id, mobile);
  if (data === null) return `${name} · ${t("quota.toolbar.empty")}`;
  const windowsText = reading.lines.length === 0
    ? (reading.spendPercent !== undefined
      ? t("quota.gemini.budget.used", { pct: Math.round(reading.spendPercent) })
      : "–")
    : reading.lines.map((window) => `${windowLabel(window, t)} ${t("quota.meter.used", { pct: Math.round(window.usedPercent) })}`).join(" · ");
  return t("quota.toolbar.reading", { provider: name, windows: windowsText });
}

function currentLocale(): ConsoleLocale {
  return document.documentElement.lang === "ko" ? "ko" : "en";
}

/**
 * 대화 컴포저가 없을 때 설정이 로그인 패널을 대신 연다.
 * 툴바 요약이 있으면 그 요약이 소유한 팝오버를 연다.
 */
export const QUOTA_PANEL_OPEN_EVENT = "fleet:quota-panel-open";
const QUOTA_TOOLBAR_OPEN_EVENT = "fleet:quota-toolbar-open";

/**
 * 어떤 화면에서 눌러도 로그인 자리에 닿게 한다.
 *
 * 폰은 설정 › 사용량이 로그인 자리다. 데스크톱은 설정 모달이 컴포저를 덮으므로 모달을 닫고,
 * 대화 위 사용량 요약이 있으면 그 팝오버를 연다. 대화가 없어 요약이 없으면 상주 호스트가
 * 같은 패널을 화면 가운데 연다.
 */
export function requestQuotaPanelOpen(): void {
  if (getViewModeSnapshot().effective === "mobile") {
    openSettingsSurface(pluginSettingsSectionId(QUOTA_PLUGIN_ID, QUOTA_USAGE_SECTION_ID));
    return;
  }
  closeSettingsModal();
  window.setTimeout(() => {
    const summary = document.querySelector<HTMLElement>(".quota-toolbar-summary");
    if (summary) {
      summary.dispatchEvent(new CustomEvent(QUOTA_TOOLBAR_OPEN_EVENT));
      return;
    }
    window.dispatchEvent(new Event(QUOTA_PANEL_OPEN_EVENT));
  }, 0);
}

export function QuotaToolbarSummary({ popoverAnchorRef, layout, placement = "top" }: ComposerTopEntryContext) {
  const mobile = layout === "mobile";
  const inCapsule = placement === "capsule";
  const { toolbarProviders: shown, providerOrder, loaded } = useStoreSnapshot(subscribeQuotaToolbarSetting, getQuotaToolbarSetting);
  const snapshot = useStoreSnapshot(subscribeQuotaSummary, getQuotaSummarySnapshot);
  const [open, setOpen] = useState(false);
  const [spotlightProvider, setSpotlightProvider] = useState<ProviderId | null>(null);
  const [hoveredId, setHoveredId] = useState<ProviderId | null>(null);
  const [cardState, setCardState] = useState<{
    readonly providerId: ProviderId;
    readonly anchor: HTMLButtonElement;
    readonly visible: boolean;
    readonly gliding: boolean;
  } | null>(null);

  const summaryRef = useRef<HTMLElement | null>(null);
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  const hiddenAtRef = useRef(0);
  const visibleRef = useRef(false);
  visibleRef.current = cardState?.visible === true;

  const popoverId = useId();
  const hoverCardId = useId();

  const clearHoverTimers = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
  }, []);

  const hideHover = useCallback((immediate = false) => {
    clearHoverTimers();
    if (visibleRef.current) hiddenAtRef.current = performance.now();
    setHoveredId(null);
    if (immediate) {
      setCardState(null);
      return;
    }
    setCardState((current) => (current === null ? null : { ...current, visible: false, gliding: false }));
    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = null;
      setCardState((current) => (current?.visible === false ? null : current));
    }, HOVER_EXIT_UNMOUNT_MS);
  }, [clearHoverTimers]);

  const requestHover = useCallback((id: ProviderId, anchor: HTMLButtonElement, immediate = false) => {
    if (open) return;
    clearHoverTimers();
    setHoveredId(id);
    const alreadyVisible = visibleRef.current;
    const withinGrace = performance.now() - hiddenAtRef.current < HOVER_HANDOFF_GRACE_MS;
    const showNow = () => {
      setCardState((current) => ({
        providerId: id,
        anchor,
        visible: true,
        gliding: current !== null && current.visible && current.providerId !== id,
      }));
    };
    if (immediate || alreadyVisible || withinGrace) {
      showNow();
      return;
    }
    showTimerRef.current = window.setTimeout(() => {
      showTimerRef.current = null;
      showNow();
    }, HOVER_SHOW_DELAY_MS);
  }, [open, clearHoverTimers]);

  // 외부 요청(`requestQuotaPanelOpen`)으로 팝오버를 열 때는 특정 공급자 강조 없이 전체 목록을 연다.
  useEffect(() => {
    const element = summaryRef.current;
    if (element === null) return;
    const onHostOpen = () => {
      hideHover(true);
      setSpotlightProvider(null);
      setOpen(true);
    };
    element.addEventListener(QUOTA_TOOLBAR_OPEN_EVENT, onHostOpen);
    return () => element.removeEventListener(QUOTA_TOOLBAR_OPEN_EVENT, onHostOpen);
  }, [loaded, shown.length, hideHover]);

  // 뷰포트 변화·창 블러·Escape에서는 떠 있는 호버 카드를 즉시 거둔다.
  useEffect(() => {
    if (cardState === null) return;
    const onDismiss = () => hideHover(true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      hideHover(false);
    };
    window.addEventListener("blur", onDismiss);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("scroll", onDismiss, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("blur", onDismiss);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("scroll", onDismiss, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [cardState !== null, hideHover]);

  useEffect(() => () => clearHoverTimers(), [clearHoverTimers]);

  // 저장값을 읽기 전에는 그리지 않는다 — 전부(기본)로 그렸다가 저장된 선택으로 줄어드는 깜빡임을 막는다.
  if (!loaded) return null;
  const locale = currentLocale();
  const t = getT(locale, mobile);
  // 저장된 선호는 그대로 두고, 지원하는 공급자만 표시한다.
  const glyphOnly = shown.length === 0;
  const readings = toolbarReadings(snapshot.data, shown, providerOrder);

  const togglePopoverFor = (providerId: ProviderId | null, trigger: HTMLButtonElement | null) => {
    hideHover(true);
    lastTriggerRef.current = trigger;
    setOpen((wasOpen) => {
      if (wasOpen) {
        setSpotlightProvider(null);
        return false;
      }
      setSpotlightProvider(providerId);
      return true;
    });
  };

  const fullSummaryLabel = glyphOnly
    ? t("quota.panel.title")
    : snapshot.data === null
      ? t("quota.toolbar.empty")
      : readings.map((reading) => readingAriaLabel(reading, snapshot.data, mobile, t)).join(" / ");

  const activeHoverReading = cardState !== null
    ? readings.find((reading) => reading.id === cardState.providerId) ?? null
    : null;

  // 모바일 390px 폭에서는 7개 링이 컴포저 동작 칩과 충돌해 잘린다 — 단일 요약 알약으로 접고 누르면 전체 사용량 팝오버를 연다.
  const mobileCompact = mobile && !glyphOnly;
  const mobilePeak = mobileCompact
    ? readings
      .map((reading) => ringPresentationOf(reading, snapshot.data))
      .filter((ring) => !ring.disconnected && !ring.loading && ring.percent !== null)
      .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0] ?? null
    : null;

  return (
    <>
      {glyphOnly ? null : <QuotaSummaryHold />}
      {mobileCompact ? (
        <button
          ref={(node) => { summaryRef.current = node; }}
          type="button"
          className={`quota-toolbar-summary quota-toolbar-summary--mobile-pill${inCapsule ? " quota-toolbar-summary--capsule" : ""}${mobilePeak ? ` quota-toolbar-summary--${mobilePeak.severity}` : ""}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? popoverId : undefined}
          aria-label={fullSummaryLabel}
          onClick={(event) => togglePopoverFor(null, event.currentTarget)}
        >
          <QuotaBarsGlyph />
          {mobilePeak && mobilePeak.percent !== null ? <span className="quota-toolbar-summary__mobile-pct">{Math.round(mobilePeak.percent)}%</span> : null}
        </button>
      ) : glyphOnly ? (
        <button
          ref={(node) => { summaryRef.current = node; }}
          type="button"
          className={`quota-toolbar-summary quota-toolbar-summary--glyph${inCapsule ? " quota-toolbar-summary--capsule" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? popoverId : undefined}
          aria-label={fullSummaryLabel}
          data-tip={open ? undefined : fullSummaryLabel}
          title={open ? undefined : fullSummaryLabel}
          onClick={(event) => togglePopoverFor(null, event.currentTarget)}
        >
          <QuotaBarsGlyph />
        </button>
      ) : (
        <div
          ref={(node) => { summaryRef.current = node; }}
          className={`quota-toolbar-summary${inCapsule ? " quota-toolbar-summary--capsule" : ""}${hoveredId !== null ? " is-hovering" : ""}${open ? " is-open" : ""}`}
          role="group"
          aria-label={t("quota.toolbar.group")}
          onPointerLeave={() => {
            if (hoveredId !== null || cardState !== null) hideHover(false);
          }}
        >
          {readings.map((reading) => {
            const ring = ringPresentationOf(reading, snapshot.data);
            const ariaLabel = readingAriaLabel(reading, snapshot.data, mobile, t);
            const hovered = hoveredId === reading.id;
            const showArc = !ring.disconnected && !ring.loading && ring.percent !== null && ring.percent > 0;
            const ringClassName = [
              "quota-toolbar-summary__ring",
              ring.elevated ? "quota-toolbar-summary__ring--elevated" : "",
              ring.disconnected || ring.loading ? "quota-toolbar-summary__ring--muted" : "",
              ring.stale ? "quota-toolbar-summary__ring--stale" : "",
              hovered ? "is-hovered" : "",
            ].filter(Boolean).join(" ");
            return (
              <button
                key={reading.id}
                type="button"
                data-provider={reading.id}
                className={ringClassName}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? popoverId : undefined}
                aria-describedby={cardState?.visible && cardState.providerId === reading.id ? hoverCardId : undefined}
                aria-label={ariaLabel}
                onPointerEnter={(event) => {
                  if (event.pointerType === "touch") return;
                  requestHover(reading.id, event.currentTarget, false);
                }}
                onPointerDown={() => hideHover(true)}
                onFocus={(event) => {
                  if (!event.currentTarget.matches(":focus-visible")) return;
                  requestHover(reading.id, event.currentTarget, true);
                }}
                onBlur={() => {
                  if (hoveredId === reading.id) hideHover(false);
                }}
                onClick={(event) => togglePopoverFor(reading.id, event.currentTarget)}
              >
                <span className="quota-toolbar-summary__dial" aria-hidden="true">
                  <svg className="quota-toolbar-summary__svg" viewBox="0 0 24 24">
                    {ring.exhausted ? <circle className="quota-toolbar-summary__exhaust" cx="12" cy="12" r="9.3" /> : null}
                    <circle
                      className={`quota-toolbar-summary__track${ring.disconnected || ring.loading ? " quota-toolbar-summary__track--dotted" : ""}`}
                      cx="12"
                      cy="12"
                      r={RING_RADIUS}
                      strokeWidth="1.6"
                    />
                    {showArc && ring.percent !== null ? (
                      <circle
                        className={`quota-toolbar-summary__arc quota-toolbar-summary__arc--${ring.severity}`}
                        cx="12"
                        cy="12"
                        r={RING_RADIUS}
                        strokeWidth="1.8"
                        strokeDasharray={RING_CIRCUMFERENCE.toFixed(2)}
                        strokeDashoffset={ringArcOffset(ring.percent).toFixed(2)}
                      />
                    ) : null}
                  </svg>
                  <span className={`quota-toolbar-summary__glyph quota-provider__mark quota-provider__mark--${reading.id}`}>
                    {providerGlyph(reading.id)}
                  </span>
                  {ring.stale ? (
                    <span className="quota-toolbar-summary__pip quota-toolbar-summary__pip--stale" />
                  ) : null}
                </span>
                <span className="quota-toolbar-summary__pill-slot" aria-hidden="true">
                  <span className="quota-toolbar-summary__pill-lines">
                    {ring.pillLines.map((line, index) => (
                      <span key={index} className={`quota-toolbar-summary__pct quota-toolbar-summary__pct--${line.severity}`}>
                        {line.percent}%
                      </span>
                    ))}
                  </span>
                </span>
              </button>
            );
          })}
          {inCapsule ? (
            <button
              type="button"
              className="quota-toolbar-summary__compact-glyph"
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-controls={open ? popoverId : undefined}
              aria-label={fullSummaryLabel}
              onClick={(event) => togglePopoverFor(null, event.currentTarget)}
            >
              <QuotaBarsGlyph />
            </button>
          ) : null}
        </div>
      )}
      {!open && cardState !== null && activeHoverReading !== null ? (
        <QuotaHoverCard
          id={hoverCardId}
          anchor={cardState.anchor}
          visible={cardState.visible}
          gliding={cardState.gliding}
          reading={activeHoverReading}
          data={snapshot.data}
          locale={locale}
          mobile={mobile}
          t={t}
        />
      ) : null}
      {open ? (
        <QuotaPopover
          id={popoverId}
          anchorRef={summaryRef}
          placementAnchorRef={popoverAnchorRef}
          inCapsule={inCapsule}
          locale={locale}
          mobile={mobile}
          spotlightProvider={spotlightProvider}
          onClose={(restoreFocus) => {
            setOpen(false);
            setSpotlightProvider(null);
            if (restoreFocus) {
              const target = lastTriggerRef.current?.isConnected ? lastTriggerRef.current : summaryRef.current;
              target?.focus();
            }
          }}
        />
      ) : null}
    </>
  );
}

/**
 * 개별 공급자 링 위에 부드럽게 떠오르는 공유 호버 카드.
 * 이웃 링으로 커서를 옮겨도 노드를 재마운트하지 않고 transform으로 수평 글라이드한다.
 */
function QuotaHoverCard({
  id,
  anchor,
  visible,
  gliding,
  reading,
  data,
  locale,
  mobile,
  t,
}: {
  readonly id: string;
  readonly anchor: HTMLButtonElement;
  readonly visible: boolean;
  readonly gliding: boolean;
  readonly reading: QuotaToolbarReading;
  readonly data: QuotaSummaryDto | null;
  readonly locale: ConsoleLocale;
  readonly mobile: boolean;
  readonly t: T;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [entered, setEntered] = useState(false);
  const [placement, setPlacement] = useState<"above" | "below">("above");
  const now = Date.now();
  const ring = ringPresentationOf(reading, data);
  const provider = ring.provider;
  const name = providerName(reading.id, mobile);

  useLayoutEffect(() => {
    const element = cardRef.current;
    if (element === null || !anchor.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const center = rect.left + rect.width / 2;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(center - width / 2, window.innerWidth - width - VIEWPORT_MARGIN));
    const aboveTop = rect.top - HOVER_GAP - height;
    const below = aboveTop < VIEWPORT_MARGIN;
    const top = below
      ? Math.min(rect.bottom + HOVER_GAP, window.innerHeight - height - VIEWPORT_MARGIN)
      : aboveTop;
    const arrowX = Math.max(HOVER_ARROW_INSET, Math.min(center - left, width - HOVER_ARROW_INSET));
    element.style.setProperty("--quota-hover-x", `${Math.round(left)}px`);
    element.style.setProperty("--quota-hover-y", `${Math.round(top)}px`);
    element.style.setProperty("--quota-hover-arrow-x", `${Math.round(arrowX)}px`);
    setPlacement(below ? "below" : "above");
  }, [anchor, reading.id, data, visible]);

  // 첫 등장은 (0,0)에서 날아오지 않도록 위치를 잡은 다음 프레임에 부드럽게 떠오른다.
  useEffect(() => {
    if (!visible) {
      setEntered(false);
      return;
    }
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, [visible]);

  const statusNote = (): string => {
    if (ring.loading) return t("quota.hover.loading");
    switch (provider?.status) {
      case "expired": return t("quota.hover.expired");
      case "no_subscription": return t(NO_SUBSCRIPTION_KEY[reading.id]);
      case "error": return t("quota.hover.error");
      default: return t("quota.hover.disconnected");
    }
  };

  const spendProvider = !ring.loading && !ring.disconnected && isSpendProvider(reading.id) && provider?.spend !== undefined
    ? reading.id
    : undefined;
  const spend = spendProvider !== undefined ? provider?.spend : undefined;
  const spendPct = spend?.budget !== undefined ? spend.usedPercent : undefined;
  const spendSev: RingSeverity = spendPct !== undefined ? spendSeverity(spendPct) : "normal";
  const spendText = spendProvider !== undefined && spend !== undefined
    ? (spend.budget !== undefined
      ? t(spendProvider === "gemini" ? "quota.gemini.spend.withBudget" : "quota.anthropic.spend.withBudget", {
        spent: formatSpendUsd(locale, spend.spent),
        budget: formatSpendUsd(locale, spend.budget),
      })
      : t(spendProvider === "gemini" ? "quota.gemini.spend.withoutBudget" : "quota.anthropic.spend.withoutBudget", {
        spent: formatSpendUsd(locale, spend.spent),
      }))
    : null;

  const isShown = visible && entered;

  return createPortal(
    <div
      {...(isShown ? { "data-covers-native-view": "" } : {})}
      ref={cardRef}
      id={id}
      role="tooltip"
      data-placement={placement}
      aria-hidden={!isShown || undefined}
      className={`quota-hover-card${isShown ? " is-visible" : ""}${gliding ? " is-gliding" : ""}`}
    >
      <div className="quota-hover-card__head">
        <span className={`quota-hover-card__mark quota-provider__mark quota-provider__mark--${reading.id}${ring.disconnected || ring.loading ? " is-muted" : ""}`}>
          {providerGlyph(reading.id)}
        </span>
        <strong className="quota-hover-card__name">{name}</strong>
        {provider?.plan ? (
          <span className="quota-plan">{displayPlanName(reading.id, provider.plan)}</span>
        ) : null}
      </div>

      {ring.loading || ring.disconnected ? (
        <p className="quota-hover-card__status">{statusNote()}</p>
      ) : (
        <div className="quota-hover-card__rows">
          {spend !== undefined ? (
            <div className={`quota-hover-card__row quota-hover-card__row--${spendSev}`}>
              <div className="quota-hover-card__row-top">
                <span className="quota-hover-card__label">{t("quota.meter.weekly")}</span>
                {spendPct !== undefined ? (
                  <span className="quota-hover-card__val">{Math.round(spendPct)}%</span>
                ) : null}
              </div>
              {spendPct !== undefined ? (
                <div className="quota-hover-card__bar">
                  <span className="quota-hover-card__fill" style={{ width: `${Math.min(100, Math.max(0, spendPct))}%` }} />
                </div>
              ) : null}
              <div className="quota-hover-card__meta">
                <span>{spendText}</span>
                <span>{t("quota.meter.resets", { t: formatCountdown(spend.resetsAt, now) })}</span>
              </div>
            </div>
          ) : null}

          {ring.windows.map((window, index) => {
            const severity = meterSeverity(window);
            const label = windowLabel(window, t);
            const note = riskNote(window, now, t);
            const projection = projectedSpan(window, now);
            const elapsedMark = elapsedMarkPercent(window);
            const reset = window.resetsAt !== undefined
              ? t("quota.meter.resets", { t: formatCountdown(window.resetsAt, now) })
              : null;
            return (
              <div key={`${window.id}-${window.label ?? index}`} className={`quota-hover-card__row quota-hover-card__row--${severity}`}>
                <div className="quota-hover-card__row-top">
                  <span className="quota-hover-card__label">{label}</span>
                  <span className="quota-hover-card__val">{Math.round(window.usedPercent)}%</span>
                </div>
                <div className="quota-hover-card__bar">
                  {projection !== null ? (
                    <span
                      className="quota-hover-card__projection"
                      style={{ left: `${projection.left}%`, width: `${projection.width}%` }}
                    />
                  ) : null}
                  <span className="quota-hover-card__fill" style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }} />
                  {elapsedMark !== null ? (
                    <span className="quota-hover-card__elapsed" style={{ left: `${elapsedMark}%` }} />
                  ) : null}
                </div>
                <div className="quota-hover-card__meta">
                  <span className={note !== null ? "quota-hover-card__alert" : undefined}>
                    {note ?? (elapsedMark !== null ? t("quota.meter.elapsed", { pct: elapsedMark }) : "")}
                  </span>
                  {reset !== null ? <span>{reset}</span> : null}
                </div>
              </div>
            );
          })}

          {spendProvider !== undefined && provider?.block !== undefined ? (
            <p className="quota-hover-card__notice quota-hover-card__notice--error">
              {blockMessage(spendProvider, provider.block, t)}
            </p>
          ) : null}

          {ring.stale ? (
            <p className="quota-hover-card__notice quota-hover-card__notice--stale">
              {t("quota.hover.stale", { t: elapsed(provider?.fetchedAt, now) })}
            </p>
          ) : null}
        </div>
      )}

      <div className="quota-hover-card__foot">
        <span>{t("quota.hover.openAll")}</span>
        <span className="quota-hover-card__enter" aria-hidden="true">↵</span>
      </div>
      <span className="quota-hover-card__arrow" aria-hidden="true" />
    </div>,
    document.body,
  );
}

/** 링 요약이 서 있는 동안 요약 폴링을 쥔다. 글리프만 선 상태에서는 읽을 숫자가 없으니 묻지 않는다. */
function QuotaSummaryHold() {
  useEffect(() => holdQuotaSummary(), []);
  return null;
}

const POPOVER_WIDTH = 364;
const POPOVER_MAX_HEIGHT = 470;
const POPOVER_GAP = 6;
const VIEWPORT_MARGIN = 8;

interface PopoverPlacement {
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
  /** 아래로 열면 top, 위로 열면 bottom(뷰포트 아래 끝에서의 거리). */
  readonly top?: number;
  readonly bottom?: number;
}

/**
 * 컴포저 요약 줄(또는 캡슐 안 쿼터 알약)에서 위로 연다. 폭과 높이를 뷰포트 안으로 제한하고,
 * 높이가 낮으면 팝업 안에서 스크롤한다.
 */
export function placePopover(
  anchor: { readonly left: number; readonly width: number; readonly top: number; readonly bottom: number },
  viewport: { readonly width: number; readonly height: number },
  align: "start" | "end" = "start",
): PopoverPlacement {
  const width = Math.max(0, Math.min(POPOVER_WIDTH, viewport.width - VIEWPORT_MARGIN * 2));
  const preferredLeft = align === "end" ? anchor.left + anchor.width - width : anchor.left;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(preferredLeft, viewport.width - width - VIEWPORT_MARGIN));
  const edge = Math.max(VIEWPORT_MARGIN, Math.min(anchor.top - POPOVER_GAP, viewport.height - VIEWPORT_MARGIN));
  return { left, width, maxHeight: Math.max(0, Math.min(POPOVER_MAX_HEIGHT, edge - VIEWPORT_MARGIN)), bottom: viewport.height - edge };
}

function measurePopoverAnchor(anchor: HTMLElement, inCapsule: boolean): { readonly left: number; readonly width: number; readonly height: number; readonly top: number; readonly bottom: number } {
  const rect = anchor.getBoundingClientRect();
  if (!inCapsule) return rect;
  const capsule = anchor.closest(".fc-composer-capsule")?.getBoundingClientRect();
  return capsule ? { left: rect.left, width: rect.width, height: capsule.height, top: capsule.top, bottom: capsule.bottom } : rect;
}

/**
 * 사용 한도 팝업 — document.body로 포털해 컴포저의 덱·스크롤 경계에서 잘리지 않게 한다.
 * 자리는 호스트가 준 요약 줄의 화면 좌표로 잡고, 창 크기나 닻 상자가 바뀌면 다시 잡는다.
 * Console 어디든(팝업과 요약 자신은 빼고) 누르면 닫히고, Esc로 닫으면 포커스가 버튼으로 돌아간다.
 */
function QuotaPopover({ id, anchorRef, placementAnchorRef, inCapsule, locale, mobile, spotlightProvider, onClose }: {
  readonly id: string;
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly placementAnchorRef: RefObject<HTMLElement | null>;
  readonly inCapsule: boolean;
  readonly locale: ConsoleLocale;
  readonly mobile: boolean;
  readonly spotlightProvider: ProviderId | null;
  readonly onClose: (restoreFocus: boolean) => void;
}) {
  const api = useStoreSnapshot(subscribeQuotaApi, getQuotaApi);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  // 첫 렌더부터 자리를 갖고 선다 — 숨은 채로 한 번 그리면 열자마자 주는 포커스가 그 상자에 앉지 못한다.
  const [placement, setPlacement] = useState<PopoverPlacement | null>(() => {
    const anchor = placementAnchorRef.current ?? anchorRef.current;
    return anchor === null ? null : placePopover(measurePopoverAnchor(anchor, inCapsule), { width: window.innerWidth, height: window.innerHeight }, "end");
  });
  const labelId = `${id}-title`;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const anchor = placementAnchorRef.current ?? anchorRef.current;
    if (!anchor) return;
    // 요약은 크기가 그대로인 채 자리만 옮겨 갈 수 있다. 창 크기·요약 크기 신호로는 그 이동을 듣지 못하므로,
    // 열려 있는 동안만 프레임마다 닻 상자와 뷰포트를 비교해 달라졌을 때만 다시 잡는다.
    let last = "";
    let frame = 0;
    const track = () => {
      const rect = measurePopoverAnchor(anchor, inCapsule);
      const key = `${rect.left},${rect.top},${rect.width},${rect.height},${window.innerWidth},${window.innerHeight}`;
      if (key !== last) {
        last = key;
        setPlacement(placePopover(rect, { width: window.innerWidth, height: window.innerHeight }, "end"));
      }
      frame = window.requestAnimationFrame(track);
    };
    track();
    return () => window.cancelAnimationFrame(frame);
  }, [anchorRef, placementAnchorRef, inCapsule]);

  const placed = placement !== null;
  useEffect(() => {
    if (placed) popoverRef.current?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target) === true || anchorRef.current?.contains(target) === true) return;
      closeRef.current(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // 범례 말풍선이 먼저 받은 Escape(defaultPrevented)는 말풍선만 닫는다.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeRef.current(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [anchorRef]);

  if (api === null) return null;
  return createPortal(
    <div data-covers-native-view=""
      ref={popoverRef}
      id={id}
      className={`quota-popover${placement?.bottom !== undefined ? " quota-popover--above" : ""}`}
      role="dialog"
      aria-labelledby={labelId}
      tabIndex={-1}
      style={placement === null
        ? { visibility: "hidden" }
        : {
          left: placement.left,
          width: placement.width,
          maxHeight: placement.maxHeight,
          ...(placement.top !== undefined ? { top: placement.top } : { bottom: placement.bottom }),
        }}
    >
      <QuotaPanel api={api} locale={locale} labelId={labelId} mobile={mobile} spotlightProvider={spotlightProvider} />
    </div>,
    document.body,
  );
}

/** 고른 공급자가 없을 때와 좁은 캡슐 폴백의 표식 — 막대 글리프. */
function QuotaBarsGlyph() {
  return (
    <svg viewBox="0 0 18 18" stroke="currentColor" fill="none" strokeWidth="1.2" aria-hidden="true">
      <path d="M3 14.5V9m4 5.5V5m4 9.5V7m4 7.5V3.5" />
    </svg>
  );
}

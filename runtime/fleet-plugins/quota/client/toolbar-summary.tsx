import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { SidebarFooterEntryContext } from "@fleet-console/sdk/plugin";
import { useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";

import type { ProviderDto, QuotaSummaryDto, QuotaWindow } from "@fleet-console/ai-gateway";
import { PROVIDER_ORDER_DEFAULT, type ProviderId } from "../provider-order.js";
import { providerGlyph } from "./cli-glyphs.js";
import { getT } from "./i18n/index.js";
import { meterSeverity, mostUrgentWindow, PROVIDER_NAME, QuotaPanel, windowLabel } from "./quota-panel.js";
import { getQuotaApi, getQuotaSummarySnapshot, holdQuotaSummary, subscribeQuotaApi, subscribeQuotaSummary } from "./summary-store.js";
import { getQuotaToolbarSetting, subscribeQuotaToolbarSetting } from "./toolbar-setting.js";

/** 사이드바 바닥의 사용량 요약. 공급자마다 글리프 옆에 창별 사용 %를 두 줄로 쌓는다.
 * 짧은 창·남은 창 중 가장 급한 창을 고르는 정책과 신호 채널은 상세 팝업과 같다. */

/** Claude의 세션 창(5시간) — 기간을 싣지 않은 세션 창을 짧은 쪽에 세우는 기준. */
const SESSION_FALLBACK_MS = 5 * 3_600_000;

export interface QuotaToolbarReading {
  readonly id: ProviderId;
  /** 비어 있으면 아직 읽지 못했거나 읽을 수 없는 공급자다 — 칸은 남기고 숫자 자리에 「–」를 둔다. */
  readonly lines: readonly QuotaWindow[];
}

function readableWindows(provider: ProviderDto | undefined): readonly QuotaWindow[] {
  if (provider === undefined || (provider.status !== "ok" && provider.status !== "stale")) return [];
  // 집계 창은 형제 풀의 합이다 — 풀이 있으면 그 풀들이 공급자를 대변한다.
  const windows = provider.windows ?? [];
  const pools = windows.filter((window) => window.isAggregate !== true);
  return pools.length > 0 ? pools : windows;
}

/** 고른 공급자마다 한 칸 — 고정 순서를 따른다. 값이 없어도 칸은 선다(켜고 끈 것만 폭을 바꾼다). */
export function toolbarReadings(
  data: QuotaSummaryDto | null,
  shown: readonly ProviderId[],
): readonly QuotaToolbarReading[] {
  return PROVIDER_ORDER_DEFAULT
    .filter((id) => shown.includes(id))
    .map((id) => ({ id, lines: summaryLines(readableWindows(data?.providers[id])) }));
}

/** 두 줄 — 가장 짧은 창 하나와, 남은 창 중 가장 급한 하나. 창이 하나면 한 줄. */
export function summaryLines(windows: readonly QuotaWindow[]): readonly QuotaWindow[] {
  if (windows.length <= 1) return windows;
  const duration = (window: QuotaWindow) => window.period?.durationMs ?? (window.id === "session" ? SESSION_FALLBACK_MS : Number.POSITIVE_INFINITY);
  const short = windows.reduce((shortest, window) => (duration(window) < duration(shortest) ? window : shortest));
  const long = mostUrgentWindow(windows.filter((window) => window !== short));
  return long === null ? [short] : [short, long];
}

function currentLocale(): ConsoleLocale {
  return document.documentElement.lang === "ko" ? "ko" : "en";
}

export function QuotaToolbarSummary({ popoverAnchorRef }: SidebarFooterEntryContext) {
  const { toolbarProviders: shown, loaded } = useStoreSnapshot(subscribeQuotaToolbarSetting, getQuotaToolbarSetting);
  const snapshot = useStoreSnapshot(subscribeQuotaSummary, getQuotaSummarySnapshot);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverId = useId();
  // 저장값을 읽기 전에는 그리지 않는다 — 전부(기본)로 그렸다가 저장된 선택으로 줄어드는 깜빡임을 막는다.
  if (!loaded) return null;
  const locale = currentLocale();
  const t = getT(locale);
  const glyphOnly = shown.length === 0;
  const readings = toolbarReadings(snapshot.data, shown);
  const label = glyphOnly
    ? t("quota.panel.title")
    : snapshot.data === null
      ? t("quota.toolbar.empty")
      : readings.map((reading) => t("quota.toolbar.reading", {
        provider: PROVIDER_NAME[reading.id],
        windows: reading.lines.length === 0
          ? "–"
          : reading.lines.map((window) => `${windowLabel(window, t)} ${t("quota.meter.used", { pct: Math.round(window.usedPercent) })}`).join(" · "),
      })).join(" / ");
  return (
    <>
      {glyphOnly ? null : <QuotaSummaryHold />}
      <button
        ref={buttonRef}
        type="button"
        className={glyphOnly ? "quota-toolbar-summary quota-toolbar-summary--glyph" : "quota-toolbar-summary"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={label}
        // 열려 있는 동안은 말풍선을 띄우지 않는다 — 버튼 바로 아래의 팝업을 가린다.
        data-tip={open ? undefined : label}
        title={open ? undefined : label}
        onClick={() => setOpen((value) => !value)}
      >
        {glyphOnly ? <QuotaBarsGlyph /> : readings.map((reading) => (
          <span key={reading.id} className="quota-toolbar-summary__cell" data-sidebar-footer-unit="" aria-hidden="true">
            <span className={snapshot.data === null ? "quota-toolbar-summary__mark" : `quota-toolbar-summary__mark quota-provider__mark quota-provider__mark--${reading.id}`}>
              {snapshot.data === null ? <QuotaBarsGlyph /> : providerGlyph(reading.id)}
            </span>
            <span className="quota-toolbar-summary__lines">
              {reading.lines.length === 0
                ? <span className="quota-toolbar-summary__pct">–</span>
                : reading.lines.map((window, index) => (
                  <span key={`${window.id}-${window.label ?? index}`} className={`quota-toolbar-summary__pct quota-toolbar-summary__pct--${meterSeverity(window)}`}>
                    {Math.round(window.usedPercent)}%
                  </span>
                ))}
            </span>
          </span>
        ))}
      </button>
      {open ? (
        <QuotaPopover
          id={popoverId}
          anchorRef={buttonRef}
          placementAnchorRef={popoverAnchorRef}
          locale={locale}
          onClose={(restoreFocus) => {
            setOpen(false);
            if (restoreFocus) buttonRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

/** 숫자 칸이 서 있는 동안 요약 폴링을 쥔다. 글리프만 선 상태에서는 읽을 숫자가 없으니 묻지 않는다. */
function QuotaSummaryHold() {
  useEffect(() => holdQuotaSummary(), []);
  return null;
}

const POPOVER_WIDTH = 340;
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
 * 사이드바 사용량 줄의 왼쪽 끝에 맞춰 위로 연다. 폭과 높이를 뷰포트 안으로 제한하고,
 * 높이가 낮으면 팝업 안에서 스크롤한다.
 */
export function placePopover(anchor: { readonly left: number; readonly width: number; readonly top: number; readonly bottom: number }, viewport: { readonly width: number; readonly height: number }): PopoverPlacement {
  const width = Math.max(0, Math.min(POPOVER_WIDTH, viewport.width - VIEWPORT_MARGIN * 2));
  const left = Math.max(VIEWPORT_MARGIN, Math.min(anchor.left, viewport.width - width - VIEWPORT_MARGIN));
  const edge = Math.max(VIEWPORT_MARGIN, Math.min(anchor.top - POPOVER_GAP, viewport.height - VIEWPORT_MARGIN));
  return { left, width, maxHeight: Math.max(0, Math.min(POPOVER_MAX_HEIGHT, edge - VIEWPORT_MARGIN)), bottom: viewport.height - edge };
}

/**
 * 사용 한도 팝업 — document.body로 포털한다. 사이드바 요약 칸은 폭 단계 때문에 가로를 잘라 내므로(overflow)
 * 그 안에 두면 팝업이 잘린다. 자리는 버튼의 화면 좌표로 잡고, 창 크기나 버튼 상자가 바뀌면 다시 잡는다.
 * Console 어디든(팝업과 버튼 자신은 빼고) 누르면 닫히고, Esc로 닫으면 포커스가 버튼으로 돌아간다.
 */
function QuotaPopover({ id, anchorRef, placementAnchorRef, locale, onClose }: {
  readonly id: string;
  readonly anchorRef: RefObject<HTMLButtonElement | null>;
  readonly placementAnchorRef: RefObject<HTMLElement | null>;
  readonly locale: ConsoleLocale;
  readonly onClose: (restoreFocus: boolean) => void;
}) {
  const api = useStoreSnapshot(subscribeQuotaApi, getQuotaApi);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  // 첫 렌더부터 자리를 갖고 선다 — 숨은 채로 한 번 그리면 열자마자 주는 포커스가 그 상자에 앉지 못한다.
  const [placement, setPlacement] = useState<PopoverPlacement | null>(() => {
    const anchor = placementAnchorRef.current ?? anchorRef.current;
    return anchor === null ? null : placePopover(anchor.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
  });
  const labelId = `${id}-title`;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const anchor = placementAnchorRef.current ?? anchorRef.current;
    if (!anchor) return;
    // 버튼은 크기가 그대로인 채 자리만 옮겨 갈 수 있다. 창 크기·버튼 크기 신호로는 그 이동을 듣지 못하므로,
    // 열려 있는 동안만 프레임마다
    // 버튼 상자와 뷰포트를 비교해 달라졌을 때만 다시 잡는다.
    let last = "";
    let frame = 0;
    const track = () => {
      const rect = anchor.getBoundingClientRect();
      const key = `${rect.left},${rect.top},${rect.width},${rect.height},${window.innerWidth},${window.innerHeight}`;
      if (key !== last) {
        last = key;
        setPlacement(placePopover(rect, { width: window.innerWidth, height: window.innerHeight }));
      }
      frame = window.requestAnimationFrame(track);
    };
    track();
    return () => window.cancelAnimationFrame(frame);
  }, [anchorRef, placementAnchorRef]);

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
    <div
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
      <QuotaPanel api={api} locale={locale} labelId={labelId} />
    </div>,
    document.body,
  );
}

/** 아직 읽은 값이 없을 때, 그리고 고른 공급자가 없을 때의 표식 — 막대 글리프. */
function QuotaBarsGlyph() {
  return (
    <svg viewBox="0 0 18 18" stroke="currentColor" fill="none" strokeWidth="1.2" aria-hidden="true">
      <path d="M3 14.5V9m4 5.5V5m4 9.5V7m4 7.5V3.5" />
    </svg>
  );
}

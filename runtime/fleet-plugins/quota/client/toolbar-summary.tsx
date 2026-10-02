import { useEffect } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { ClientRailCapability } from "@fleet-console/sdk/plugin";
import { useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";

import type { ProviderDto, QuotaSummaryDto, QuotaWindow } from "@fleet-console/ai-gateway";
import type { ProviderId } from "../provider-order.js";
import { providerGlyph } from "./cli-glyphs.js";
import { getT } from "./i18n/index.js";
import { foldedWindow, meterSeverity, PROVIDER_NAME, windowLabel } from "./rail-panel.js";
import { getQuotaSummarySnapshot, holdQuotaSummary, subscribeQuotaSummary } from "./summary-store.js";
import { getQuotaToolbarSetting, subscribeQuotaToolbarSetting } from "./toolbar-setting.js";

/**
 * 도구모음 Bridge의 사용 한도 요약 — 가장 급한 공급자 하나의 글리프 옆에 창별 사용 %를 두 줄로 쌓는다
 * (위: 짧은 창, 아래: 그보다 긴 창 중 가장 급한 것). 숫자는 패널과 같은 「사용 %」이고 심각도는 패널과 같은
 * 판정·같은 신호 채널(warn·coral)을 탄다. 폭은 고정이라 켜고 끄거나 값이 바뀌어도 도구모음 가운데 정렬이
 * 흔들리지 않는다. 누르면 사용 한도 패널을 열고 닫는다. 꺼져 있으면 아무것도 그리지 않는다(칸째 사라진다).
 */

const QUOTA_RAIL_ENTRY_ID = "quota";
/** Claude의 세션 창(5시간) — 기간을 싣지 않은 세션 창을 짧은 쪽에 세우는 기준. */
const SESSION_FALLBACK_MS = 5 * 3_600_000;

let rail: ClientRailCapability | null = null;

export function connectQuotaToolbarRail(next: ClientRailCapability): () => void {
  rail = next;
  return () => {
    if (rail === next) rail = null;
  };
}

export interface QuotaToolbarReading {
  readonly id: ProviderId;
  readonly lines: readonly QuotaWindow[];
}

const SEVERITY_RANK = { normal: 0, warning: 1, critical: 2 } as const;

function readableWindows(provider: ProviderDto | undefined): readonly QuotaWindow[] {
  if (provider === undefined || (provider.status !== "ok" && provider.status !== "stale")) return [];
  return provider.windows ?? [];
}

/** 가장 급한 공급자 하나 — 패널의 접힌 행과 같은 순위(판정 먼저, 그다음 사용 %). 같으면 패널 순서가 앞인 쪽. */
export function toolbarReading(data: QuotaSummaryDto | null, order: readonly ProviderId[]): QuotaToolbarReading | null {
  if (data === null) return null;
  let best: { readonly id: ProviderId; readonly worst: QuotaWindow; readonly windows: readonly QuotaWindow[] } | null = null;
  for (const id of order) {
    const windows = readableWindows(data.providers[id]);
    const worst = foldedWindow(windows);
    if (worst === null) continue;
    if (best === null) { best = { id, worst, windows }; continue; }
    const rank = SEVERITY_RANK[meterSeverity(worst)] - SEVERITY_RANK[meterSeverity(best.worst)];
    if (rank > 0 || (rank === 0 && worst.usedPercent > best.worst.usedPercent)) best = { id, worst, windows };
  }
  return best === null ? null : { id: best.id, lines: summaryLines(best.windows) };
}

/** 두 줄 — 가장 짧은 창 하나와, 남은 창 중 가장 급한 하나. 창이 하나면 한 줄. */
export function summaryLines(windows: readonly QuotaWindow[]): readonly QuotaWindow[] {
  if (windows.length <= 1) return windows;
  const duration = (window: QuotaWindow) => window.period?.durationMs ?? (window.id === "session" ? SESSION_FALLBACK_MS : Number.POSITIVE_INFINITY);
  const short = windows.reduce((shortest, window) => (duration(window) < duration(shortest) ? window : shortest));
  const long = foldedWindow(windows.filter((window) => window !== short));
  return long === null ? [short] : [short, long];
}

function currentLocale(): ConsoleLocale {
  return document.documentElement.lang === "ko" ? "ko" : "en";
}

export function QuotaToolbarSummary() {
  const { toolbarSummary } = useStoreSnapshot(subscribeQuotaToolbarSetting, getQuotaToolbarSetting);
  if (!toolbarSummary) return null;
  return <QuotaToolbarSummaryButton />;
}

function QuotaToolbarSummaryButton() {
  const snapshot = useStoreSnapshot(subscribeQuotaSummary, getQuotaSummarySnapshot);
  useEffect(() => holdQuotaSummary(), []);
  const t = getT(currentLocale());
  const reading = toolbarReading(snapshot.data, snapshot.order);
  const label = reading === null
    ? t("quota.toolbar.empty")
    : t("quota.toolbar.reading", {
      provider: PROVIDER_NAME[reading.id],
      windows: reading.lines.map((window) => `${windowLabel(window, t)} ${t("quota.meter.used", { pct: Math.round(window.usedPercent) })}`).join(" · "),
    });
  return (
    <button
      type="button"
      className={`quota-toolbar-summary${snapshot.panelOpen ? " is-active" : ""}`}
      aria-pressed={snapshot.panelOpen}
      aria-label={label}
      data-tip={label}
      onClick={() => {
        if (rail === null) return;
        if (rail.isOpen(QUOTA_RAIL_ENTRY_ID)) rail.close(QUOTA_RAIL_ENTRY_ID);
        else rail.open(QUOTA_RAIL_ENTRY_ID);
      }}
    >
      <span className="quota-toolbar-summary__mark" aria-hidden="true">
        {reading === null ? <QuotaBarsGlyph /> : providerGlyph(reading.id)}
      </span>
      <span className="quota-toolbar-summary__lines" aria-hidden="true">
        {reading === null
          ? <span className="quota-toolbar-summary__pct">–</span>
          : reading.lines.map((window, index) => (
            <span key={`${window.id}-${window.label ?? index}`} className={`quota-toolbar-summary__pct quota-toolbar-summary__pct--${meterSeverity(window)}`}>
              {Math.round(window.usedPercent)}%
            </span>
          ))}
      </span>
    </button>
  );
}

/** 아직 읽은 값이 없을 때의 표식 — 레일 진입점과 같은 막대 글리프. */
function QuotaBarsGlyph() {
  return (
    <svg viewBox="0 0 18 18" stroke="currentColor" fill="none" strokeWidth="1.2" aria-hidden="true">
      <path d="M3 14.5V9m4 5.5V5m4 9.5V7m4 7.5V3.5" />
    </svg>
  );
}

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
 * 도구모음 Bridge의 사용 한도 요약 — 사용자가 고른 공급자마다 한 칸씩, 글리프 옆에 창별 사용 %를 두 줄로
 * 쌓는다(위: 짧은 창, 아래: 그보다 긴 창 중 가장 급한 것). 칸의 순서는 패널의 카드 순서다. 숫자는 패널과
 * 같은 「사용 %」이고 심각도는 패널과 같은 판정·같은 신호 채널(warn·coral)을 탄다. 칸은 글리프에 숫자를
 * 바짝 붙인 내용 폭이다(고정 폭이면 한 자릿수 칸이 벌어져 보인다). 누르면 사용 한도 패널을
 * 열고 닫는다. 고른 공급자가 없으면 아무것도 그리지 않는다(칸째 사라진다).
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
  /** 비어 있으면 아직 읽지 못했거나 읽을 수 없는 공급자다 — 칸은 남기고 숫자 자리에 「–」를 둔다. */
  readonly lines: readonly QuotaWindow[];
}

function readableWindows(provider: ProviderDto | undefined): readonly QuotaWindow[] {
  if (provider === undefined || (provider.status !== "ok" && provider.status !== "stale")) return [];
  return provider.windows ?? [];
}

/** 고른 공급자마다 한 칸 — 패널 카드 순서를 따른다. 값이 없어도 칸은 선다(켜고 끈 것만 폭을 바꾼다). */
export function toolbarReadings(
  data: QuotaSummaryDto | null,
  order: readonly ProviderId[],
  shown: readonly ProviderId[],
): readonly QuotaToolbarReading[] {
  return order
    .filter((id) => shown.includes(id))
    .map((id) => ({ id, lines: summaryLines(readableWindows(data?.providers[id])) }));
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
  const { toolbarProviders } = useStoreSnapshot(subscribeQuotaToolbarSetting, getQuotaToolbarSetting);
  if (toolbarProviders.length === 0) return null;
  return <QuotaToolbarSummaryButton shown={toolbarProviders} />;
}

function QuotaToolbarSummaryButton({ shown }: { readonly shown: readonly ProviderId[] }) {
  const snapshot = useStoreSnapshot(subscribeQuotaSummary, getQuotaSummarySnapshot);
  useEffect(() => holdQuotaSummary(), []);
  const t = getT(currentLocale());
  const readings = toolbarReadings(snapshot.data, snapshot.order, shown);
  const label = snapshot.data === null
    ? t("quota.toolbar.empty")
    : readings.map((reading) => t("quota.toolbar.reading", {
      provider: PROVIDER_NAME[reading.id],
      windows: reading.lines.length === 0
        ? "–"
        : reading.lines.map((window) => `${windowLabel(window, t)} ${t("quota.meter.used", { pct: Math.round(window.usedPercent) })}`).join(" · "),
    })).join(" / ");
  return (
    <button
      type="button"
      className="quota-toolbar-summary"
      aria-pressed={snapshot.panelOpen}
      aria-label={label}
      data-tip={label}
      onClick={() => {
        if (rail === null) return;
        if (rail.isOpen(QUOTA_RAIL_ENTRY_ID)) rail.close(QUOTA_RAIL_ENTRY_ID);
        else rail.open(QUOTA_RAIL_ENTRY_ID);
      }}
    >
      {readings.map((reading) => (
        <span key={reading.id} className="quota-toolbar-summary__cell" aria-hidden="true">
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

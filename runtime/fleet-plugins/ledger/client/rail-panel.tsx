import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";
import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { LedgerDailyDetailDto, LedgerModelRowDto, LedgerSummaryDto, LedgerWindow } from "../server/types.js";
import { providerGlyph } from "./cli-glyphs.js";
import {
  costValueTier,
  formatCost,
  formatCostParts,
  formatTokenParts,
  formatTokens,
  lowerValueTier,
  tokenValueTier,
  type FormattedValueParts,
  type ValueTier,
} from "./formatters.js";
import { getT, type LedgerMessageKey } from "./i18n/index.js";
import "./ledger.css";

interface LedgerPanelProps {
  readonly ctx: RailPanelContext;
}

type T = Translate<LedgerMessageKey>;
type TrendScale = "linear" | "sqrt";

function relativeTime(atMs: number, nowMs: number, t: T): string {
  const minutes = Math.max(0, Math.floor((nowMs - atMs) / 60_000));
  if (minutes < 1) return t("ledger.time.justNow");
  if (minutes < 60) return t("ledger.time.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("ledger.time.hours", { count: hours });
  return t("ledger.time.days", { count: Math.floor(hours / 24) });
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return <div className="ledger-metric"><span>{label}</span><strong>{value}</strong></div>;
}

function totalTokens(usage: {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function ValueAmount({ parts, tier, className = "" }: {
  readonly parts: FormattedValueParts;
  readonly tier: ValueTier;
  readonly className?: string;
}) {
  const unitTier = lowerValueTier(tier);
  return (
    <span className={`ledger-value ${className}`} aria-label={`${parts.prefix}${parts.number}${parts.suffix}`}>
      {parts.prefix ? <span className={`ledger-value-part ledger-value--${unitTier}`}>{parts.prefix}</span> : null}
      <span className={`ledger-value-part ledger-value--${tier}`}>{parts.number}</span>
      {parts.suffix ? <span className={`ledger-value-part ledger-value--${unitTier}`}>{parts.suffix}</span> : null}
    </span>
  );
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  claude: "Anthropic",
  codex: "Codex",
  cursor: "Cursor",
  kimi: "Kimi",
  opencode: "OpenCode",
  xai: "xAI",
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function providerClass(provider: string): string {
  return /^[a-z0-9-]+$/.test(provider) ? provider : "unknown";
}

function ModelRow({ row }: { readonly row: LedgerModelRowDto }) {
  const tokens = totalTokens(row.usage);
  return (
    <div className="ledger-client-row">
      <span className={`ledger-client-mark is-${providerClass(row.provider)}`}>{providerGlyph(row.provider)}</span>
      <span className="ledger-client-copy">
        <strong>{row.label}</strong>
        <small>{providerLabel(row.provider)}</small>
      </span>
      <span className="ledger-client-values">
        <ValueAmount parts={formatCostParts(row.costUsd)} tier={costValueTier(row.costUsd)} />
        <ValueAmount parts={formatTokenParts(tokens)} tier={tokenValueTier(tokens)} />
      </span>
    </div>
  );
}

const TREND_DAY_MARKER = "{ledgerTrendDayValue}";
const TREND_COST_MARKER = "{ledgerTrendCostValue}";
const TREND_VALUE_MARKERS = /(\{ledgerTrendDayValue\}|\{ledgerTrendCostValue\})/;

function TrendSummaryText({ t, message, day, cost }: {
  readonly t: T;
  readonly message: "ledger.trend.peak" | "ledger.trend.average";
  readonly day?: string;
  readonly cost: string;
}) {
  const text = t(message, { day: TREND_DAY_MARKER, cost: TREND_COST_MARKER });
  return (
    <span>
      {text.split(TREND_VALUE_MARKERS).map((part, index) => {
        if (part === TREND_DAY_MARKER) return <strong key={`${part}-${index}`}>{day}</strong>;
        if (part === TREND_COST_MARKER) return <strong key={`${part}-${index}`}>{cost}</strong>;
        return part;
      })}
    </span>
  );
}

function DailyDetail({ detail, language, t }: {
  readonly detail: LedgerDailyDetailDto;
  readonly language: RailPanelContext["language"];
  readonly t: T;
}) {
  const day = new Intl.DateTimeFormat(language, { month: "short", day: "numeric" })
    .format(new Date(`${detail.day}T12:00:00`));
  return (
    <section className="ledger-daily-detail">
      <h3>{t("ledger.daily.detail", { day })}</h3>
      <div className="ledger-client-list">
        {detail.models.map((row) => <ModelRow key={row.modelId} row={row} />)}
      </div>
      {detail.modelCount > detail.models.length ? (
        <div className="ledger-coverage-more">
          {t("ledger.models.more", { count: detail.modelCount - detail.models.length })}
        </div>
      ) : null}
    </section>
  );
}

function detailDays(data: LedgerSummaryDto): readonly string[] {
  if (data.scope.window !== "today") return [];
  return data.dailyDetails
    .filter((detail) => detail.day === data.currentDay)
    .map((detail) => detail.day);
}

function defaultSelectedDay(data: LedgerSummaryDto): string | null {
  const available = new Set(detailDays(data));
  return data.daily.filter((point) => available.has(point.day) && point.costUsd > 0).at(-1)?.day
    ?? data.daily.filter((point) => available.has(point.day)).at(-1)?.day
    ?? null;
}

function TrendSection({ data, language, t }: {
  readonly data: LedgerSummaryDto;
  readonly language: RailPanelContext["language"];
  readonly t: T;
}) {
  const [scale, setScale] = useState<TrendScale>("linear");
  const [selectedDay, setSelectedDay] = useState<string | null>(() => defaultSelectedDay(data));
  const fallbackDay = defaultSelectedDay(data);
  const availableDetailDays = new Set(detailDays(data));
  const selected = selectedDay && availableDetailDays.has(selectedDay)
    ? selectedDay
    : fallbackDay;
  const detail = selected ? data.dailyDetails.find((entry) => entry.day === selected) : undefined;
  const dayFormatter = useMemo(
    () => new Intl.DateTimeFormat(language, { month: "short", day: "numeric" }),
    [language],
  );
  const formatDay = (day: string) => dayFormatter.format(new Date(`${day}T12:00:00`));
  const transform = (value: number) => scale === "sqrt" ? Math.sqrt(value) : value;
  const maxCost = Math.max(...data.daily.map((point) => point.costUsd));
  const maxTransformed = transform(maxCost);
  const peak = data.daily.reduce((current, point) => point.costUsd > current.costUsd ? point : current);
  const average = data.daily.reduce((total, point) => total + point.costUsd / data.daily.length, 0);
  const averageCost = formatCost(Number.isFinite(average) ? average : 0);
  const scaleLabel = t(scale === "sqrt" ? "ledger.trend.scale.sqrt" : "ledger.trend.scale.linear");

  return (
    <div className="ledger-trend">
      <div className="ledger-trend-header">
        <h3>{t("ledger.trend.title")}</h3>
        <div className="ledger-segment ledger-segment--compact" role="group" aria-label={t("ledger.trend.scale.aria")}>
          <button type="button" aria-pressed={scale === "linear"} onClick={() => setScale("linear")}>
            {t("ledger.trend.scale.linear")}
          </button>
          <button type="button" aria-pressed={scale === "sqrt"} onClick={() => setScale("sqrt")}>
            {t("ledger.trend.scale.sqrt")}
          </button>
        </div>
      </div>
      <p className="ledger-trend-description">{t("ledger.trend.explanation")}</p>
      <div className="ledger-trend-bars" role="group" aria-label={t("ledger.trend.aria")}>
        {data.daily.map((point, index) => {
          const day = formatDay(point.day);
          const label = t("ledger.trend.day", {
            day,
            cost: formatCost(point.costUsd),
            scale: scaleLabel,
          });
          const height = `${Math.max(3, maxTransformed > 0 ? (transform(point.costUsd) / maxTransformed) * 100 : 0)}%`;
          return (
            <button
              type="button"
              key={point.day}
              className="ledger-trend-bar"
              aria-label={label}
              aria-pressed={selected === point.day}
              aria-disabled={!availableDetailDays.has(point.day)}
              style={{ height, ["--ledger-bar-pos" as string]: String(index / Math.max(1, data.daily.length - 1)) }}
              onClick={() => {
                if (availableDetailDays.has(point.day)) setSelectedDay(point.day);
              }}
            >
              <span className="ledger-trend-tooltip" aria-hidden="true">{label}</span>
            </button>
          );
        })}
      </div>
      <div className="ledger-trend-axis">
        <span>{formatDay(data.daily[0]!.day)}</span>
        <span>{formatDay(data.daily[data.daily.length - 1]!.day)}</span>
      </div>
      <div className="ledger-trend-summary">
        <TrendSummaryText t={t} message="ledger.trend.peak" day={formatDay(peak.day)} cost={formatCost(peak.costUsd)} />
        <TrendSummaryText t={t} message="ledger.trend.average" cost={averageCost} />
      </div>
      <p className="ledger-trend-scale-note">
        {t(scale === "sqrt" ? "ledger.trend.scaleNoteSqrt" : "ledger.trend.scaleNoteLinear")}
      </p>
      {detail ? <DailyDetail detail={detail} language={language} t={t} /> : null}
    </div>
  );
}

function LoadingState({ t }: { readonly t: T }) {
  return (
    <div className="ledger-state ledger-source-notice" data-ledger-source-status="bootstrapping">
      <span className="ledger-state-mark ledger-state-mark--loading" />
      <strong>{t("ledger.loading.title")}</strong>
      <p>{t("ledger.loading.body")}</p>
    </div>
  );
}

function ErrorState({ t, retry }: { readonly t: T; readonly retry: () => void }) {
  return (
    <div className="ledger-state">
      <span className="ledger-state-mark ledger-state-mark--error" />
      <strong>{t("ledger.error.title")}</strong>
      <p>{t("ledger.error.body")}</p>
      <button type="button" className="ledger-button" onClick={retry}>{t("ledger.action.retry")}</button>
    </div>
  );
}

function SourceFailureState({ data, t, retry }: {
  readonly data: LedgerSummaryDto;
  readonly t: T;
  readonly retry: () => void;
}) {
  const status = data.source.status === "unreadable" ? "unreadable" : "unavailable";
  return (
    <div className="ledger-state ledger-source-notice" data-ledger-source-status={status}>
      <span className="ledger-state-mark ledger-state-mark--error" />
      <strong>{t(`ledger.source.${status}`)}</strong>
      <p>{t(`ledger.source.${status}Detail`)}</p>
      <button type="button" className="ledger-button" onClick={retry}>{t("ledger.action.retry")}</button>
    </div>
  );
}

function SourceSection({ data, t }: { readonly data: LedgerSummaryDto; readonly t: T }) {
  const skipped = data.source.skippedEntries + data.source.skippedSessions;
  const reportUnavailable = data.source.report === "unavailable" || data.source.report === "unreadable";
  return (
    <section className="ledger-source ledger-source-notice" data-ledger-source-status="degraded">
      <div>
        <h3>{t("ledger.section.source")}</h3>
        <span className="ledger-source-status ledger-source-status--degraded">{t("ledger.source.degraded")}</span>
      </div>
      {skipped > 0 ? <p>{t("ledger.source.degradedRecords", { count: skipped })}</p> : null}
      {reportUnavailable ? <p>{t("ledger.daily.unavailable")}</p> : null}
      {data.dailySource.unmatchedEntries > 0 ? (
        <p>{t("ledger.daily.unmatched", { count: data.dailySource.unmatchedEntries })}</p>
      ) : null}
    </section>
  );
}

function LedgerPanelBody({ ctx }: LedgerPanelProps) {
  const t = getT(ctx.language);
  const [window, setWindow] = useState<LedgerWindow>("week");
  const [data, setData] = useState<LedgerSummaryDto | null>(null);
  const [error, setError] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const forceRefresh = useRef(false);

  const refresh = useCallback(() => {
    forceRefresh.current = true;
    setRefreshEpoch((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setError(false);
    const params = new URLSearchParams({ window });
    if (forceRefresh.current) params.set("refresh", "1");
    forceRefresh.current = false;
    ctx.api.fetch("ledger", `summary?${params.toString()}`)
      .then((response) => response.json() as Promise<LedgerSummaryDto>)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        if (result.source.status === "bootstrapping") {
          timer = setTimeout(() => setRefreshEpoch((value) => value + 1), 1500);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [ctx.api, refreshEpoch, window]);

  // Keep a previous response cached for back-and-forth controls, but never paint it under a new window label.
  const visibleData = data?.scope.window === window ? data : null;
  return (
    <div className="ledger-root">
      <div className="ledger-controls">
        <div className="ledger-segment" role="group" aria-label={t("ledger.window.aria")}>
          {(["today", "week", "month"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={window === value} onClick={() => setWindow(value)}>
              {t(`ledger.window.${value}`)}
            </button>
          ))}
        </div>
      </div>

      {error ? <ErrorState t={t} retry={refresh} /> : !visibleData ? <LoadingState t={t} /> : visibleData.source.status === "bootstrapping" ? (
        <LoadingState t={t} />
      ) : visibleData.source.status === "unavailable" || visibleData.source.status === "unreadable" ? (
        <SourceFailureState data={visibleData} t={t} retry={refresh} />
      ) : (
        <>
          <section className="ledger-summary">
            <div className="ledger-hero-cost">{formatCost(visibleData.totals.costUsd)}</div>
            <p>{t("ledger.summary.scope", { count: visibleData.modelCount })}</p>
            <div className="ledger-total-token">
              <span>{t("ledger.metric.totalTokens")}</span>
              <ValueAmount
                parts={formatTokenParts(totalTokens(visibleData.totals))}
                tier={tokenValueTier(totalTokens(visibleData.totals))}
              />
            </div>
            <div className="ledger-metrics">
              <Metric label={t("ledger.metric.input")} value={formatTokens(visibleData.totals.input)} />
              <Metric label={t("ledger.metric.output")} value={formatTokens(visibleData.totals.output)} />
              <Metric label={t("ledger.metric.cacheRead")} value={formatTokens(visibleData.totals.cacheRead)} />
              <Metric label={t("ledger.metric.messages")} value={formatTokens(visibleData.totals.messages)} />
            </div>
          </section>

          <section className="ledger-clients">
            {visibleData.daily.length > 0 ? (
              <TrendSection
                key={`${visibleData.scope.window}:${visibleData.generatedAtMs}`}
                data={visibleData}
                language={ctx.language}
                t={t}
              />
            ) : null}
            <h3>{t("ledger.section.models")}</h3>
            <p className="ledger-clients-description">{t("ledger.models.explanation")}</p>
            {visibleData.modelRows.length === 0 ? (
              <div className="ledger-inline-empty">
                <strong>{t("ledger.empty.title")}</strong>
                <p>{t("ledger.empty.body")}</p>
              </div>
            ) : (
              <div className="ledger-client-list">
                {visibleData.modelRows.map((row) => <ModelRow key={row.modelId} row={row} />)}
              </div>
            )}
            {visibleData.modelCount > visibleData.modelRows.length ? (
              <div className="ledger-coverage-more">
                {t("ledger.models.more", { count: visibleData.modelCount - visibleData.modelRows.length })}
              </div>
            ) : null}
          </section>

          {visibleData.source.status === "degraded" || visibleData.dailySource.unmatchedEntries > 0 ? (
            <SourceSection data={visibleData} t={t} />
          ) : null}
          <footer className="ledger-footer">
            <span>{t("ledger.footer.generated", { time: relativeTime(visibleData.generatedAtMs, Date.now(), t) })}</span>
            <button type="button" className="ledger-button" onClick={refresh}>{t("ledger.action.refresh")}</button>
          </footer>
        </>
      )}
    </div>
  );
}

function LedgerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" stroke="currentColor" fill="none" aria-hidden="true" strokeWidth="1.2">
      <path d="M3.5 2.5h11v13h-11zM6.5 6h5M6.5 9h5M6.5 12h3" />
    </svg>
  );
}

export const ledgerPanel: RailPanelDescriptor = {
  id: "ledger",
  title: (locale) => getT(locale)("ledger.panel.title"),
  icon: LedgerIcon,
  defaultWidth: 392,
  render: (ctx) => <LedgerPanelBody ctx={ctx} />,
};

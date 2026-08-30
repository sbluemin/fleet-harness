import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";
import type { PaneContext, PaneDescriptor } from "@fleet-console/sdk/pane";
import type { RailEntryDescriptor } from "@fleet-console/sdk/rail";

import type { LedgerDailyDetailDto, LedgerModelRowDto, LedgerSummaryDto, LedgerWindow } from "../server/types.js";
import { providerGlyph } from "./cli-glyphs.js";
import {
  costValueTier,
  formatCost,
  formatCostParts,
  formatShare,
  formatTokenParts,
  formatTokens,
  lowerValueTier,
  safePercent,
  tokenValueTier,
  type FormattedValueParts,
  type ValueTier,
} from "./formatters.js";
import { getT, type LedgerMessageKey } from "./i18n/index.js";
import "./ledger.css";

interface LedgerPanelProps {
  readonly ctx: PaneContext;
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

interface BackendGroup {
  readonly provider: string;
  readonly label: string;
  readonly costUsd: number;
  readonly tokens: number;
  readonly share: number;
  readonly rows: readonly LedgerModelRowDto[];
}

/**
 * 운영자가 실제로 당길 수 있는 손잡이는 모델이 아니라 백엔드다. 서버는 백엔드 합계를 주지
 * 않지만 `modelRows`가 이미 provider와 금액을 함께 나르므로 클라이언트에서 접는다 —
 * 따라서 이 분해는 서버가 상한(80행)까지 보낸 모델만 덮는다. 그 사실은 섹션의
 * `+N more models` 줄이 그대로 진다.
 */
function groupByBackend(
  rows: readonly LedgerModelRowDto[],
  totalCostUsd: number,
): readonly BackendGroup[] {
  const groups = new Map<string, { rows: LedgerModelRowDto[]; costUsd: number; tokens: number }>();
  for (const row of rows) {
    const group = groups.get(row.provider) ?? { rows: [], costUsd: 0, tokens: 0 };
    group.rows.push(row);
    group.costUsd += row.costUsd;
    group.tokens += totalTokens(row.usage);
    groups.set(row.provider, group);
  }
  return [...groups.entries()]
    .map(([provider, group]) => ({
      provider,
      label: providerLabel(provider),
      costUsd: group.costUsd,
      tokens: group.tokens,
      share: safePercent(group.costUsd, totalCostUsd),
      rows: group.rows,
    }))
    .sort((a, b) => (
      b.costUsd - a.costUsd
      || b.tokens - a.tokens
      || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
    ));
}

/**
 * 조각 너비는 `flex-grow`가 나누므로 분모가 조각 합계다. 라벨의 share는 창 전체 합계를 분모로
 * 쓴다 — 두 분모가 갈리면 폭과 퍼센트가 어긋난다(서버가 모델 행을 80개로 자르면 특히 그렇다).
 * 남은 몫을 중립 조각으로 명시해 두 분모를 하나로 되돌린다.
 */
function BackendComposition({ groups, totalCostUsd, t }: {
  readonly groups: readonly BackendGroup[];
  readonly totalCostUsd: number;
  readonly t: T;
}) {
  const grouped = groups.reduce((total, group) => total + group.costUsd, 0);
  const remainder = totalCostUsd - grouped;
  // `min-width`는 진짜 몫이 사라지지 않게 막는 하한이라, 비용이 0인 그룹까지 조각으로 두면
  // 자기 라벨이 `0%`라고 말하는 백엔드가 실제 지출과 같은 폭을 차지한다. 행은 남기고 조각만 뺀다.
  const slices = groups.filter((group) => group.costUsd > 0);
  return (
    <div className="ledger-backend-composition" role="img" aria-label={t("ledger.backends.composition")}>
      {slices.map((group) => (
        <span
          key={group.provider}
          className={`ledger-backend-slice is-${providerClass(group.provider)}`}
          style={{ flexGrow: group.costUsd }}
          title={t("ledger.backends.slice", { label: group.label, share: formatShare(group.share) })}
        />
      ))}
      {remainder > 0 ? (
        <span
          className="ledger-backend-slice ledger-backend-slice--remainder"
          style={{ flexGrow: remainder }}
          title={t("ledger.backends.remainder", {
            cost: formatCost(remainder),
            share: formatShare(safePercent(remainder, totalCostUsd)),
          })}
        />
      ) : null}
    </div>
  );
}

function BackendGroupRow({ group, t }: { readonly group: BackendGroup; readonly t: T }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ledger-backend">
      <button
        type="button"
        className="ledger-backend-head"
        aria-expanded={open}
        aria-label={t("ledger.backends.row", {
          label: group.label,
          cost: formatCost(group.costUsd),
          tokens: formatTokens(group.tokens),
          share: formatShare(group.share),
        })}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`ledger-client-mark is-${providerClass(group.provider)}`}>
          {providerGlyph(group.provider)}
        </span>
        <span className="ledger-backend-copy">
          <strong>{group.label}</strong>
          <small>{formatShare(group.share)}</small>
        </span>
        <span className="ledger-backend-values">
          <ValueAmount parts={formatCostParts(group.costUsd)} tier={costValueTier(group.costUsd)} />
          <ValueAmount parts={formatTokenParts(group.tokens)} tier={tokenValueTier(group.tokens)} />
        </span>
        <span className="ledger-backend-chevron" aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" fill="none" strokeWidth="1.4">
            <path d="M3.5 1.5 L7 5 L3.5 8.5" />
          </svg>
        </span>
      </button>
      {/* 펼친 백엔드는 받은 행을 전부 보여준다 — 여기서 한 번 더 자르면 그 모델에 닿을 길이 없다. */}
      {open ? (
        <div className="ledger-backend-models">
          <div className="ledger-client-list">
            {group.rows.map((row) => <ModelRow key={row.modelId} row={row} />)}
          </div>
        </div>
      ) : null}
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
  readonly language: PaneContext["language"];
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

/**
 * 상세를 가진 날은 서버가 이미 모든 창에 대해 직렬화한다(`dailyDetails`). Today만 열어 두던
 * 게이트는 나머지 창의 막대를 눌러도 아무 일이 없는 컨트롤로 만들었고, 그 창들이 받아 놓고
 * 버리는 payload가 주 73.9%·월 82.3%였다. 이제 상세가 있는 날은 어느 창에서든 선택할 수 있다.
 */
function detailDays(data: LedgerSummaryDto): readonly string[] {
  return data.dailyDetails.map((detail) => detail.day);
}

/**
 * 창 전체 목록과 하루 목록은 같은 행 문법을 쓰므로, 하루를 자동 선택하면 같은 모델이 서로
 * 다른 금액으로 두 번 그려진다(창 목록은 날짜가 붙지 않은 기록까지 포함한다). 선택은 항상
 * 사용자의 클릭에서만 시작한다.
 */
const NO_DAY_SELECTED: string | null = null;

function TrendSection({ data, language, t }: {
  readonly data: LedgerSummaryDto;
  readonly language: PaneContext["language"];
  readonly t: T;
}) {
  const [scale, setScale] = useState<TrendScale>("linear");
  const [selectedDay, setSelectedDay] = useState<string | null>(NO_DAY_SELECTED);
  const availableDetailDays = new Set(detailDays(data));
  const selected = selectedDay && availableDetailDays.has(selectedDay) ? selectedDay : null;
  const detail = selected ? data.dailyDetails.find((entry) => entry.day === selected) : undefined;
  // 날짜를 붙이지 못한 기록은 합계에 남고 일별 축에서만 빠진다(summary.ts). 그 차이를 건수가
  // 아니라 금액으로 말하지 않으면 히어로와 차트가 조용히 어긋난다.
  const residual = undatedResidual(data);
  // 날짜 없는 기록이 흔한 원인이지만 유일한 원인은 아니다(예: fillDailyPoints의 366일 상한).
  // 금액으로 문을 열고, 건수는 실제로 있을 때만 말한다.
  const showsResidual = residual >= MIN_VISIBLE_RESIDUAL_USD;
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
      <p className="ledger-trend-description">{t("ledger.trend.select")}</p>
      <div className="ledger-trend-chart">
      <div className="ledger-trend-bars" role="group" aria-label={t("ledger.trend.aria")}>
        {data.daily.map((point, index) => {
          const day = formatDay(point.day);
          const label = t("ledger.trend.day", {
            day,
            cost: formatCost(point.costUsd),
            scale: scaleLabel,
          });
          const height = `${Math.max(3, maxTransformed > 0 ? (transform(point.costUsd) / maxTransformed) * 100 : 0)}%`;
          const style = { height, ["--ledger-bar-pos" as string]: String(index / Math.max(1, data.daily.length - 1)) };
          const tooltip = <span className="ledger-trend-tooltip" aria-hidden="true">{label}</span>;
          // 상세가 없는 날은 눌러도 열 것이 없다. `aria-disabled`만 붙인 <button>은 탭 순서에
          // 남아 죽은 정지점이 되므로, 작동할 수 없는 막대는 컨트롤이 아니라 표식으로 그린다.
          if (!availableDetailDays.has(point.day)) {
            return (
              <div
                key={point.day}
                className="ledger-trend-bar ledger-trend-bar--inert"
                role="img"
                aria-label={label}
                style={style}
              >
                {tooltip}
              </div>
            );
          }
          return (
            <button
              type="button"
              key={point.day}
              className="ledger-trend-bar"
              aria-label={label}
              aria-pressed={selected === point.day}
              style={style}
              onClick={() => setSelectedDay((current) => current === point.day ? null : point.day)}
            >
              {tooltip}
            </button>
          );
        })}
      </div>
      {/* 잔여 마개는 `.ledger-trend-bars` 밖에 선다 — 툴팁이 그 컨테이너 폭을 기준으로 앵커되므로
          안에 끼우면 모든 날짜 툴팁이 마개 폭만큼 밀린다. */}
      {showsResidual ? (
        <div
          className="ledger-trend-residual-cap"
          role="img"
          aria-label={t("ledger.trend.residualAria", { cost: formatCost(residual) })}
          style={{ height: `${Math.max(6, maxTransformed > 0 ? Math.min(100, (transform(residual) / maxTransformed) * 100) : 0)}%` }}
        />
      ) : null}
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
      {showsResidual ? (
        <p className="ledger-trend-residual">
          <span className="ledger-trend-residual-mark" aria-hidden="true" />
          <span>{data.dailySource.unmatchedEntries > 0
            ? t("ledger.trend.residual", {
              cost: formatCost(residual),
              count: data.dailySource.unmatchedEntries,
            })
            : t("ledger.trend.residualPlain", { cost: formatCost(residual) })}</span>
        </p>
      ) : null}
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

/** 금액이 센트로 반올림되어 사라지는 잔여는 말하지 않는다. */
const MIN_VISIBLE_RESIDUAL_USD = 0.005;

/** 합계에 있으나 일별 축의 어느 날에도 놓이지 못한 금액. */
function undatedResidual(data: LedgerSummaryDto): number {
  return data.totals.costUsd - data.daily.reduce((total, point) => total + point.costUsd, 0);
}

/**
 * 모델 행의 세션이 리포트 메타데이터에 하나도 없으면 일별 축이 통째로 비고(summary.ts),
 * 부모가 차트를 아예 렌더하지 않아 차트 안의 잔여 문장도 함께 사라진다. 그 상태에서는
 * 지출 전액이 차트에서 빠진 것이므로, 차트가 없을 때야말로 금액을 말해야 한다.
 * 리포트 자체를 읽지 못한 경우는 `ledger.daily.unavailable`이 이미 정확히 설명하므로 제외한다.
 */
function showsChartlessResidual(data: LedgerSummaryDto): boolean {
  const reportCanProvideDates = data.source.report === "ok" || data.source.report === "degraded";
  return data.daily.length === 0
    && reportCanProvideDates
    && undatedResidual(data) >= MIN_VISIBLE_RESIDUAL_USD;
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
  const backends = useMemo(
    () => visibleData ? groupByBackend(visibleData.modelRows, visibleData.totals.costUsd) : [],
    [visibleData],
  );
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
            {showsChartlessResidual(visibleData) ? (
              <p className="ledger-trend-residual">
                <span className="ledger-trend-residual-mark" aria-hidden="true" />
                <span>{t("ledger.trend.residualNoChart", {
                  cost: formatCost(undatedResidual(visibleData)),
                  count: visibleData.dailySource.unmatchedEntries,
                })}</span>
              </p>
            ) : null}
            {visibleData.daily.length > 0 ? (
              <TrendSection
                key={`${visibleData.scope.window}:${visibleData.generatedAtMs}`}
                data={visibleData}
                language={ctx.language}
                t={t}
              />
            ) : null}
            <h3>{t("ledger.section.backends")}</h3>
            <p className="ledger-clients-description">{t("ledger.backends.explanation")}</p>
            {visibleData.modelRows.length === 0 ? (
              <div className="ledger-inline-empty">
                <strong>{t("ledger.empty.title")}</strong>
                <p>{t("ledger.empty.body")}</p>
              </div>
            ) : (
              <div className="ledger-backend-list" role="group" aria-label={t("ledger.backends.aria")}>
                {visibleData.totals.costUsd > 0
                  ? <BackendComposition groups={backends} totalCostUsd={visibleData.totals.costUsd} t={t} />
                  : null}
                {backends.map((group) => (
                  <BackendGroupRow key={group.provider} group={group} t={t} />
                ))}
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

// `satisfies`, not an annotation: `RailPanelDescriptor` is a union of a rendering panel and an
// activate-only rail action, so annotating erases which arm this is and leaves `render` optional
// to every caller. The check against the contract is identical; the concrete shape survives it.
export const ledgerEntry: RailEntryDescriptor = {
  id: "ledger",
  title: (locale) => getT(locale)("ledger.panel.title"),
  icon: LedgerIcon,
  panes: ["ledger"],
};

/** 지표판 한 열. 옆에 설 상세가 없으므로 detail 페인도 없다. */
export const ledgerPane: PaneDescriptor = {
  id: "ledger",
  role: "primary",
  mounts: ["rail"],
  title: (ctx) => getT(ctx.language ?? "en")("ledger.panel.title"),
  render: (ctx) => <LedgerPanelBody ctx={ctx} />,
  defaultWidth: 392,
};

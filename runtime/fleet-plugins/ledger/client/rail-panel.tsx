import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";
import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { LedgerOperationDto, LedgerSummaryDto, LedgerUnmatchedOperationDto, LedgerWindow } from "../server/types.js";
import { cliDisplayName, cliGlyph, markKeyFromCliId } from "./cli-glyphs.js";
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

type T = Translate<LedgerMessageKey>;
type ScopeMode = "theater" | "all";
type SortMode = "activity" | "cost";

type DisplayRow =
  | { readonly kind: "matched"; readonly operation: LedgerOperationDto }
  | { readonly kind: "unmatched"; readonly operation: LedgerUnmatchedOperationDto };

/** 유령 행은 시각 홍수를 막기 위해 5개까지 — 전체 수는 커버리지 라인과 롤업이 전한다. */
const MAX_GHOST_ROWS = 5;

interface LedgerPanelProps {
  readonly ctx: RailPanelContext;
}

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

function totalTokens(usage: { readonly input: number; readonly output: number; readonly cacheRead: number }): number {
  return usage.input + usage.output + usage.cacheRead;
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

type TrendScale = "linear" | "sqrt";

function TrendSection({ daily, dailyAttributed, language, t }: {
  readonly daily: LedgerSummaryDto["daily"];
  readonly dailyAttributed: LedgerSummaryDto["dailyAttributed"];
  readonly language: RailPanelContext["language"];
  readonly t: T;
}) {
  const [scale, setScale] = useState<TrendScale>("linear");
  // Intl 포매터 생성은 비싸므로 스케일 토글 같은 무관한 리렌더에서 재생성하지 않는다.
  const dayFormatter = useMemo(
    () => new Intl.DateTimeFormat(language, { month: "short", day: "numeric" }),
    [language],
  );
  const formatDay = (day: string) => dayFormatter.format(new Date(day + "T12:00:00"));
  // 스케일은 값에 적용하는 함수다 — 막대 전체와 귀속 레이어에 같은 함수를 써야
  // sqrt 모드에서도 "높이 ∝ 변환(값)" 해석이 모든 세그먼트에 일관되게 성립한다.
  const transform = (value: number) => scale === "sqrt" ? Math.sqrt(value) : value;
  const maxCost = Math.max(...daily.map((point) => point.costUsd));
  const maxTransformed = transform(maxCost);
  const peak = daily.reduce((current, point) => point.costUsd > current.costUsd ? point : current);
  const average = daily.reduce((total, point) => total + point.costUsd / daily.length, 0);
  const averageCost = formatCost(Number.isFinite(average) ? average : 0);
  const scaleLabel = t(scale === "sqrt" ? "ledger.trend.scale.sqrt" : "ledger.trend.scale.linear");
  // 인덱스 상관 대신 day 키로 정렬 — 서버는 축 동일을 보장하지만, 키 조회는 미래 회귀에 대한
  // 저항을 추가 비용 없이 준다(맵 구축 1회).
  const attributedByDay = useMemo(
    () => new Map(dailyAttributed.map((point) => [point.day, point.costUsd])),
    [dailyAttributed],
  );

  return (
    <div className="ledger-trend">
      <div className="ledger-trend-header">
        <h3>{t("ledger.trend.title")}</h3>
        <div className="ledger-segment ledger-segment--compact" role="group" aria-label={t("ledger.trend.scale.aria")}>
          <button type="button" aria-pressed={scale === "linear"} onClick={() => setScale("linear")}>{t("ledger.trend.scale.linear")}</button>
          <button type="button" aria-pressed={scale === "sqrt"} onClick={() => setScale("sqrt")}>{t("ledger.trend.scale.sqrt")}</button>
        </div>
      </div>
      <p className="ledger-trend-description">{t("ledger.trend.explanation")}</p>
      <p className="ledger-trend-attributed-note">{t("ledger.trend.attributedNote")}</p>
      <div className="ledger-trend-bars" role="group" aria-label={t("ledger.trend.aria")}>
        {daily.map((point, index) => {
          const day = formatDay(point.day);
          const cost = formatCost(point.costUsd);
          const attributed = attributedByDay.get(point.day) ?? 0;
          const label = attributed > 0
            ? t("ledger.trend.dayAttributed", { day, cost, attributed: formatCost(attributed), scale: scaleLabel })
            : t("ledger.trend.day", { day, cost, scale: scaleLabel });
          const height = `${Math.max(3, maxTransformed > 0 ? (transform(point.costUsd) / maxTransformed) * 100 : 0)}%`;
          const attributedHeight = point.costUsd > 0 && attributed > 0
            ? `${Math.min(100, (transform(attributed) / transform(point.costUsd)) * 100)}%`
            : null;
          return (
            <span
              key={point.day}
              className="ledger-trend-bar"
              style={{ height, ["--ledger-bar-pos" as string]: String(index / (daily.length - 1)) }}
              tabIndex={0}
              role="img"
              aria-label={label}
            >
              {attributedHeight ? <span className="ledger-trend-bar-attributed" style={{ height: attributedHeight }} /> : null}
              <span className="ledger-trend-tooltip" aria-hidden="true">{label}</span>
            </span>
          );
        })}
      </div>
      <div className="ledger-trend-axis">
        <span>{formatDay(daily[0]!.day)}</span>
        <span>{formatDay(daily[daily.length - 1]!.day)}</span>
      </div>
      <div className="ledger-trend-summary">
        <TrendSummaryText t={t} message="ledger.trend.peak" day={formatDay(peak.day)} cost={formatCost(peak.costUsd)} />
        <TrendSummaryText t={t} message="ledger.trend.average" cost={averageCost} />
      </div>
      <p className="ledger-trend-scale-note">{t(scale === "sqrt" ? "ledger.trend.scaleNoteSqrt" : "ledger.trend.scaleNoteLinear")}</p>
    </div>
  );
}

function attributionShare(attributed: number, deviceWide: number): number {
  if (deviceWide <= 0 || attributed <= 0) return 0;
  return Math.min(1, attributed / deviceWide);
}

function formatShare(share: number): string {
  const percent = share * 100;
  if (percent <= 0) return "0%";
  if (share >= 1) return "100%";
  // 반올림이 정확한 범례 수치와 모순되는 극단은 부등호로 표기한다(0.04%→"0.0%", 99.96%→"100%" 방지).
  if (percent < 0.05) return "<0.1%";
  if (percent > 99.95) return ">99.9%";
  if (percent >= 9.95) return `${Math.min(99, Math.round(percent))}%`;
  return `${percent.toFixed(1)}%`;
}

/** 귀속분(totals)과 기기 전체(deviceTotals)의 관계를 한눈에 잇는 브릿지 — 두 숫자가
    같은 window의 서로 다른 모집단이라는 사실을 패널의 첫 문장으로 올린다.
    Theater 스코프에서는 다른 Theater의 Console 귀속분을 별도 버킷으로 분리해
    "기타 로컬 세션"이 Console 바깥 사용량만 뜻하도록 정직하게 나눈다. */
function BridgeSection({ data, t }: { readonly data: LedgerSummaryDto; readonly t: T }) {
  const attributed = data.totals.costUsd;
  const deviceWide = data.deviceTotals.costUsd;
  if (deviceWide <= 0) return null;
  const otherTheater = data.scope.theaterId !== null ? data.otherTheaterTotals.costUsd : 0;
  const share = attributionShare(attributed, deviceWide);
  const otherTheaterShare = attributionShare(otherTheater, deviceWide);
  const other = Math.max(0, deviceWide - attributed - otherTheater);
  // ARIA 라벨도 시각 범례와 같은 버킷으로 말한다 — otherTheater를 "기타 로컬 세션"에 합산하면
  // 스크린리더 사용자에게 모순된 2버킷 설명이 된다.
  const aria = otherTheater > 0
    ? t("ledger.bridge.ariaTheater", {
      attributed: formatCost(attributed),
      share: formatShare(share),
      otherTheater: formatCost(otherTheater),
      other: formatCost(other),
    })
    : t("ledger.bridge.aria", {
      attributed: formatCost(attributed),
      share: formatShare(share),
      other: formatCost(other),
    });
  return (
    <div className="ledger-bridge">
      <div className="ledger-bridge-bar" role="img" aria-label={aria}>
        {share > 0 ? <span className="ledger-bridge-attributed" style={{ width: `${share * 100}%` }} /> : null}
        {otherTheaterShare > 0 ? <span className="ledger-bridge-other-theater" style={{ width: `${otherTheaterShare * 100}%` }} /> : null}
      </div>
      <div className="ledger-bridge-legend">
        <span className="ledger-bridge-row">
          <span className="ledger-bridge-swatch ledger-bridge-swatch--attributed" aria-hidden="true" />
          <span>{data.scope.theaterId !== null ? t("ledger.bridge.attributedTheater") : t("ledger.bridge.attributed")}</span>
          <strong>{formatCost(attributed)} · {formatShare(share)}</strong>
        </span>
        {otherTheater > 0 ? (
          <span className="ledger-bridge-row">
            <span className="ledger-bridge-swatch ledger-bridge-swatch--other-theater" aria-hidden="true" />
            <span>{t("ledger.bridge.otherTheaters")}</span>
            <strong>{formatCost(otherTheater)}</strong>
          </span>
        ) : null}
        <span className="ledger-bridge-row">
          <span className="ledger-bridge-swatch ledger-bridge-swatch--other" aria-hidden="true" />
          <span>{t("ledger.bridge.other")}</span>
          <strong>{formatCost(other)}</strong>
        </span>
      </div>
      <div className="ledger-bridge-total">
        <span>{t("ledger.bridge.deviceTotal")}</span>
        <strong>{formatCost(deviceWide)}</strong>
      </div>
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

function SourceFailureState({ data, t, retry }: { readonly data: LedgerSummaryDto; readonly t: T; readonly retry: () => void }) {
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

function DetailView({ operation, t, back }: { readonly operation: LedgerOperationDto; readonly t: T; readonly back: () => void }) {
  return (
    <div className="ledger-detail">
      <button type="button" className="ledger-back" onClick={back}>{t("ledger.action.back")}</button>
      <h2>{operation.title}</h2>
      <div className="ledger-hero-cost">{formatCost(operation.costUsd)}</div>
      <div className="ledger-total-token">
        <span>{t("ledger.metric.totalTokens")}</span>
        <ValueAmount parts={formatTokenParts(totalTokens(operation.usage))} tier={tokenValueTier(totalTokens(operation.usage))} />
      </div>
      <div className="ledger-metrics">
        <Metric label={t("ledger.metric.input")} value={formatTokens(operation.usage.input)} />
        <Metric label={t("ledger.metric.output")} value={formatTokens(operation.usage.output)} />
        <Metric label={t("ledger.metric.cacheRead")} value={formatTokens(operation.usage.cacheRead)} />
        <Metric label={t("ledger.metric.messages")} value={formatTokens(operation.messages)} />
      </div>
      <section className="ledger-detail-section">
        <h3>{t("ledger.detail.models")}</h3>
        <p>{operation.models.length > 0 ? operation.models.join(", ") : t("ledger.value.noModels")}</p>
      </section>
      <section className="ledger-detail-section">
        <h3>{t("ledger.detail.lastActivity")}</h3>
        <p>{relativeTime(operation.lastActivityAtMs, Date.now(), t)}</p>
      </section>
    </div>
  );
}

function SourceSection({ data, t }: { readonly data: LedgerSummaryDto; readonly t: T }) {
  const statusKey = `ledger.source.${data.source.status}` as LedgerMessageKey;
  const detail = data.source.status === "degraded"
    ? t("ledger.source.degradedDetail", { count: data.source.skippedSessions })
    : t(`${statusKey}Detail` as LedgerMessageKey);
  return (
    <section className="ledger-source ledger-source-notice" data-ledger-source-status={data.source.status}>
      <div>
        <h3>{t("ledger.section.source")}</h3>
        <span className={`ledger-source-status ledger-source-status--${data.source.status}`}>{t(statusKey)}</span>
      </div>
      {detail ? <p>{detail}</p> : null}
    </section>
  );
}

function LedgerPanel({ ctx }: LedgerPanelProps) {
  return <LedgerPanelBody key={ctx.theaterId ?? "all"} ctx={ctx} />;
}

function LedgerPanelBody({ ctx }: LedgerPanelProps) {
  const t = getT(ctx.language);
  const [scope, setScope] = useState<ScopeMode>(ctx.theaterId ? "theater" : "all");
  const [window, setWindow] = useState<LedgerWindow>("week");
  const [sort, setSort] = useState<SortMode>("activity");
  const [data, setData] = useState<LedgerSummaryDto | null>(null);
  const [error, setError] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [forceRefresh, setForceRefresh] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listScrollRef = useRef(0);

  const openDetail = useCallback((operationId: string) => {
    listScrollRef.current = rootRef.current?.scrollTop ?? 0;
    setSelectedId(operationId);
  }, []);

  // 목록과 상세는 같은 .ledger-root DOM을 재사용하므로 scrollTop이 그대로 이어진다 —
  // 상세 진입 시 맨 위로, 복귀 시 목록 위치 복원을 레이아웃 단계에서 처리해 깜빡임을 막는다.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.scrollTop = selectedId ? 0 : listScrollRef.current;
  }, [selectedId]);

  const refresh = useCallback(() => {
    setForceRefresh(true);
    setRefreshEpoch((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setError(false);
    const params = new URLSearchParams({ window });
    if (scope === "theater" && ctx.theaterId) params.set("theaterId", ctx.theaterId);
    if (forceRefresh) params.set("refresh", "1");
    ctx.api.fetch("ledger", `summary?${params.toString()}`)
      .then((response) => response.json() as Promise<LedgerSummaryDto>)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setForceRefresh(false);
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
  }, [ctx.api, ctx.theaterId, forceRefresh, refreshEpoch, scope, window]);

  const expectedTheaterId = scope === "theater" ? ctx.theaterId : null;
  const visibleData = data?.scope.window === window && data.scope.theaterId === expectedTheaterId ? data : null;
  // 서버는 matched를 최근 활동순으로 보낸다. activity 모드는 유령 행을 lastActivityAtMs
  // (미귀속은 Operation 갱신 시각)로 인터리브하고, cost 모드는 비용을 알 수 없는 유령을 뒤에 묶는다.
  const displayRows = useMemo<DisplayRow[]>(() => {
    if (!visibleData) return [];
    const matched = visibleData.operations.map((operation) => ({ kind: "matched" as const, operation }));
    const ghosts = visibleData.unmatched.map((operation) => ({ kind: "unmatched" as const, operation }));
    if (sort === "cost") {
      matched.sort((a, b) => b.operation.costUsd - a.operation.costUsd || b.operation.lastActivityAtMs - a.operation.lastActivityAtMs);
      return [...matched, ...ghosts];
    }
    return [...matched, ...ghosts].sort((a, b) => b.operation.lastActivityAtMs - a.operation.lastActivityAtMs);
  }, [visibleData, sort]);
  const displayRowsCapped = useMemo(() => {
    let ghosts = 0;
    return displayRows.filter((row) => row.kind === "matched" || ++ghosts <= MAX_GHOST_ROWS);
  }, [displayRows]);
  const ghostsRendered = Math.min(visibleData?.unmatched.length ?? 0, MAX_GHOST_ROWS);
  const selected = visibleData?.operations.find((operation) => operation.operationId === selectedId) ?? null;
  if (selected) return <div className="ledger-root" ref={rootRef}><DetailView operation={selected} t={t} back={() => setSelectedId(null)} /></div>;

  return (
    <div className="ledger-root" ref={rootRef}>
      <div className="ledger-controls">
        <div className="ledger-segment" role="group" aria-label={t("ledger.scope.aria")}>
          <button type="button" aria-pressed={scope === "theater"} disabled={!ctx.theaterId} onClick={() => setScope("theater")}>{t("ledger.scope.theater")}</button>
          <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>{t("ledger.scope.all")}</button>
        </div>
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
            <p>{t("ledger.summary.operations", { count: visibleData.operations.length })}</p>
            <div className="ledger-total-token">
              <span>{t("ledger.metric.totalTokens")}</span>
              <ValueAmount parts={formatTokenParts(totalTokens(visibleData.totals))} tier={tokenValueTier(totalTokens(visibleData.totals))} />
            </div>
            <div className="ledger-metrics">
              <Metric label={t("ledger.metric.input")} value={formatTokens(visibleData.totals.input)} />
              <Metric label={t("ledger.metric.output")} value={formatTokens(visibleData.totals.output)} />
              <Metric label={t("ledger.metric.cacheRead")} value={formatTokens(visibleData.totals.cacheRead)} />
              <Metric label={t("ledger.metric.messages")} value={formatTokens(visibleData.totals.messages)} />
            </div>
            <BridgeSection data={visibleData} t={t} />
          </section>

          <section className="ledger-list">
            <div className="ledger-list-header">
              <h3>{t("ledger.section.operations")}</h3>
              <div className="ledger-segment ledger-segment--compact" role="group" aria-label={t("ledger.sort.aria")}>
                <button type="button" aria-pressed={sort === "activity"} onClick={() => setSort("activity")}>{t("ledger.sort.activity")}</button>
                <button type="button" aria-pressed={sort === "cost"} onClick={() => setSort("cost")}>{t("ledger.sort.cost")}</button>
              </div>
            </div>
            {visibleData.unmatchedTotal > 0 ? (
              <div className="ledger-coverage">
                <span>{t("ledger.coverage.count", { count: visibleData.operations.length + visibleData.unmatchedTotal })}</span>
                <span className="ledger-coverage-match">
                  {t("ledger.coverage.matched", { matched: visibleData.operations.length, unmatched: visibleData.unmatchedTotal })}
                </span>
              </div>
            ) : null}
            {displayRows.length === 0 ? (
              <div className="ledger-inline-empty"><strong>{t("ledger.empty.title")}</strong><p>{t("ledger.empty.body")}</p></div>
            ) : null}
            {displayRowsCapped.map((row) => row.kind === "matched" ? (
              <button type="button" className={`ledger-operation ledger-operation--${markKeyFromCliId(row.operation.cliId)}`} key={row.operation.operationId} onClick={() => openDetail(row.operation.operationId)}>
                <span className="ledger-operation-mark">{cliGlyph(markKeyFromCliId(row.operation.cliId))}</span>
                <span className="ledger-operation-copy">
                  <strong>{row.operation.title}</strong>
                  <small>{t("ledger.operation.messages", { cliLabel: row.operation.cliLabel || t("ledger.value.unknownCli"), count: row.operation.messages })}</small>
                </span>
                <span className="ledger-operation-values">
                  <ValueAmount parts={formatCostParts(row.operation.costUsd)} tier={costValueTier(row.operation.costUsd)} />
                  <ValueAmount parts={formatTokenParts(totalTokens(row.operation.usage))} tier={tokenValueTier(totalTokens(row.operation.usage))} />
                </span>
                <span className="ledger-chevron">›</span>
              </button>
            ) : (
              <div
                className={`ledger-operation ledger-operation--unmatched ledger-operation--${markKeyFromCliId(row.operation.cliId)}`}
                key={row.operation.operationId}
              >
                <span className="ledger-operation-mark">{cliGlyph(markKeyFromCliId(row.operation.cliId))}</span>
                <span className="ledger-operation-copy">
                  <strong>{row.operation.title}</strong>
                  <small>{t("ledger.operation.unmatched", { cliLabel: row.operation.cliLabel || t("ledger.value.unknownCli") })}</small>
                </span>
              </div>
            ))}
            {visibleData.unmatchedTotal > ghostsRendered ? (
              <div className="ledger-coverage-more">{t("ledger.coverage.more", { count: visibleData.unmatchedTotal - ghostsRendered })}</div>
            ) : null}
          </section>

          <section className="ledger-clients">
            {visibleData.daily.length >= 2 ? <TrendSection daily={visibleData.daily} dailyAttributed={visibleData.dailyAttributed} language={ctx.language} t={t} /> : null}
            <h3>{t("ledger.section.clients")}</h3>
            <p className="ledger-clients-description">{t("ledger.clients.explanation")}</p>
            <div className="ledger-client-list">
              {visibleData.clients.map((entry) => {
                const tokens = totalTokens(entry.usage);
                return (
                  <div className={`ledger-client-row ledger-client-row--${entry.client}`} key={entry.client}>
                    <span className="ledger-client-mark">{cliGlyph(entry.client)}</span>
                    <span className="ledger-client-copy">
                      <strong>{cliDisplayName(entry.client)}</strong>
                      <small>{t("ledger.clients.sessions", { count: entry.sessions })}</small>
                    </span>
                    <span className="ledger-client-values">
                      <ValueAmount parts={formatCostParts(entry.costUsd)} tier={costValueTier(entry.costUsd)} />
                      <ValueAmount parts={formatTokenParts(tokens)} tier={tokenValueTier(tokens)} />
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          {visibleData.source.status === "degraded" ? <SourceSection data={visibleData} t={t} /> : null}
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
  render: (ctx) => <LedgerPanel ctx={ctx} />,
};

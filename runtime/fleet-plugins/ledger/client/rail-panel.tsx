import { useCallback, useEffect, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";
import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { LedgerOperationDto, LedgerSummaryDto, LedgerWindow } from "../server/types.js";
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
  const [data, setData] = useState<LedgerSummaryDto | null>(null);
  const [error, setError] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [forceRefresh, setForceRefresh] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
  const selected = visibleData?.operations.find((operation) => operation.operationId === selectedId) ?? null;
  if (selected) return <div className="ledger-root"><DetailView operation={selected} t={t} back={() => setSelectedId(null)} /></div>;

  return (
    <div className="ledger-root">
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
          </section>

          <section className="ledger-list">
            <h3>{t("ledger.section.operations")}</h3>
            {visibleData.operations.length === 0 ? (
              <div className="ledger-inline-empty"><strong>{t("ledger.empty.title")}</strong><p>{t("ledger.empty.body")}</p></div>
            ) : null}
            {visibleData.operations.map((operation) => (
              <button type="button" className={`ledger-operation ledger-operation--${markKeyFromCliId(operation.cliId)}`} key={operation.operationId} onClick={() => setSelectedId(operation.operationId)}>
                <span className="ledger-operation-mark">{cliGlyph(markKeyFromCliId(operation.cliId))}</span>
                <span className="ledger-operation-copy">
                  <strong>{operation.title}</strong>
                  <small>{t("ledger.operation.messages", { cliLabel: operation.cliLabel || t("ledger.value.unknownCli"), count: operation.messages })}</small>
                </span>
                <span className="ledger-operation-values">
                  <ValueAmount parts={formatCostParts(operation.costUsd)} tier={costValueTier(operation.costUsd)} />
                  <ValueAmount parts={formatTokenParts(totalTokens(operation.usage))} tier={tokenValueTier(totalTokens(operation.usage))} />
                </span>
                <span className="ledger-chevron">›</span>
              </button>
            ))}
          </section>

          <section className="ledger-clients">
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

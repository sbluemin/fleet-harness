import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";
import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { ProviderDto, QuotaSummaryDto, QuotaWindow } from "@dotobokuri/core-ai-gateway";
import { providerGlyph } from "./cli-glyphs.js";
import { getT, type QuotaMessageKey } from "./i18n/index.js";
import "./quota.css";

type T = Translate<QuotaMessageKey>;
type ProviderId = "claude" | "codex" | "cursor" | "kimi" | "opencode";
/** Providers whose credential read is gated behind an explicit connect. */
type ConnectableProviderId = "claude" | "cursor";

const PROVIDER_NAME: Readonly<Record<ProviderId, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  kimi: "Kimi",
  opencode: "OpenCode Go",
};

export const SIGNED_OUT_KEY: Readonly<Record<ProviderId, QuotaMessageKey>> = {
  claude: "quota.claude.signedOut",
  codex: "quota.codex.signedOut",
  cursor: "quota.cursor.signedOut",
  kimi: "quota.kimi.signedOut",
  opencode: "quota.opencode.signedOut",
};

export const EXPIRED_KEY: Readonly<Record<ProviderId, QuotaMessageKey>> = {
  claude: "quota.expired.claude",
  codex: "quota.expired.codex",
  cursor: "quota.expired.cursor",
  kimi: "quota.expired.kimi",
  opencode: "quota.expired.opencode",
};

// Cursor와 Kimi만 이 상태에 도달하지만(claude·codex 파서는 반환하지 않는다), 프로바이더별
// 안내를 공용 문구로 대신하면 다른 공급자의 지시를 보여주게 되므로 나머지도 명시한다.
export const NO_SUBSCRIPTION_KEY: Readonly<Record<ProviderId, QuotaMessageKey>> = {
  claude: "quota.noSubscription",
  codex: "quota.noSubscription",
  cursor: "quota.noSubscription",
  kimi: "quota.kimi.noSubscription",
  opencode: "quota.noSubscription",
};

function isConnectable(id: ProviderId): id is ConnectableProviderId {
  return id === "claude" || id === "cursor";
}

interface RequestGeneration {
  current: number;
}

export function beginRequestGeneration(generation: RequestGeneration): number {
  generation.current += 1;
  return generation.current;
}

export function isLatestRequestGeneration(generation: RequestGeneration, captured: number): boolean {
  return generation.current === captured;
}

function elapsed(at: number | undefined, now: number): string {
  const delta = Math.max(0, now - (at ?? now));
  const days = Math.floor(delta / 86_400_000);
  if (days > 0) return `${days}d`;
  const hours = Math.floor(delta / 3_600_000);
  if (hours > 0) return `${hours}h`;
  return `${Math.floor(delta / 60_000)}m`;
}

export function formatCountdown(target: number | undefined, now: number): string {
  let delta = Math.max(0, (target ?? now) - now);
  const days = Math.floor(delta / 86_400_000);
  delta -= days * 86_400_000;
  const hours = Math.floor(delta / 3_600_000);
  delta -= hours * 3_600_000;
  const minutes = Math.floor(delta / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function Meter({
  window,
  cycleDays,
  now,
  t,
}: {
  readonly window: QuotaWindow;
  readonly cycleDays?: number;
  readonly now: number;
  readonly t: T;
}) {
  const severity = window.usedPercent >= 90 ? "critical" : window.usedPercent >= 70 ? "warning" : "normal";
  const label = window.label ?? t(
    window.id === "session"
      ? "quota.meter.session"
      : window.id === "cycle" ? "quota.meter.cycle" : "quota.meter.weekly",
  );
  const windowChip = window.id === "session"
    ? "5h"
    : window.id === "weekly"
      ? "7d"
      : window.id === "cycle" && cycleDays !== undefined ? `${cycleDays}d` : undefined;
  return (
    <div className={`quota-meter quota-meter--${severity}`}>
      <div className="quota-meter__top">
        <span className="quota-meter__label">{label}{windowChip ? <span className="quota-meter__window">{windowChip}</span> : null}</span>
        <span className="quota-meter__percent">{t("quota.meter.used", { pct: window.usedPercent })}</span>
      </div>
      <div className="quota-meter__bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.usedPercent}>
        <span className="quota-meter__fill" style={{ width: `${window.usedPercent}%` }} />
      </div>
      {window.resetsAt !== undefined ? <div className="quota-meter__reset">{t("quota.meter.resets", { t: formatCountdown(window.resetsAt, now) })}</div> : null}
    </div>
  );
}

function StatusStrip({ kind, children }: { readonly kind: "expired" | "stale" | "error"; readonly children: React.ReactNode }) {
  return <div className={`quota-strip quota-strip--${kind}`}>{children}</div>;
}

function ProviderCard({
  id,
  provider,
  now,
  t,
  connect,
}: {
  readonly id: ProviderId;
  readonly provider: ProviderDto;
  readonly now: number;
  readonly t: T;
  readonly connect: (provider: ConnectableProviderId, connected: boolean) => void;
}) {
  const name = PROVIDER_NAME[id];
  if (isConnectable(id) && provider.status === "not_connected") {
    const titleKey = id === "claude" ? "quota.connect.title" : "quota.connect.title.cursor";
    const bodyKey = id === "claude" ? "quota.connect.body" : "quota.connect.body.cursor";
    const actionKey = id === "claude" ? "quota.connect.action" : "quota.connect.action.cursor";
    return (
      <section className="quota-connect-card">
        <h3>
          <span className={`quota-provider__mark quota-provider__mark--${id}`}>{providerGlyph(id)}</span>
          {t(titleKey)}
        </h3>
        <p>{t(bodyKey)}</p>
        {provider.method === "keychain" ? <p className="quota-connect-card__hint">{t("quota.connect.keychain")}</p> : null}
        <button type="button" className="quota-button quota-button--primary" onClick={() => connect(id, true)}>{t(actionKey)}</button>
      </section>
    );
  }
  return (
    <section className="quota-provider" data-provider={id}>
      <header className="quota-provider__header">
        <span className={`quota-provider__mark quota-provider__mark--${id}`}>{providerGlyph(id)}</span>
        <h3>{name}</h3>
        {isConnectable(id) ? <button type="button" className="quota-disconnect" onClick={() => connect(id, false)}>{t("quota.disconnect.action")}</button> : null}
        {provider.plan ? <span className="quota-plan">{provider.plan}</span> : null}
      </header>
      {provider.status === "signed_out" ? <div className="quota-signed-out">{t(SIGNED_OUT_KEY[id])}</div> : null}
      {provider.status === "no_subscription" ? <div className="quota-signed-out">{t(NO_SUBSCRIPTION_KEY[id])}</div> : null}
      {provider.status === "expired" ? <StatusStrip kind="expired">{t(EXPIRED_KEY[id])}</StatusStrip> : null}
      {provider.status === "stale" ? <StatusStrip kind="stale">{t("quota.stale", { provider: name, t: elapsed(provider.fetchedAt, now) })}</StatusStrip> : null}
      {provider.status === "error" ? (() => {
        const match = provider.message?.match(/^Certificate verification failed \(([A-Za-z0-9_]+)\)$/);
        return match?.[1] !== undefined
          ? <StatusStrip kind="error">{t("quota.error.tls", { provider: name, code: match[1] })}</StatusStrip>
          : <div className="quota-error">{t("quota.error", { provider: name })}</div>;
      })() : null}
      {(provider.status === "ok" || provider.status === "stale") ? provider.windows?.map((window, index) => (
        <Meter key={`${window.id}-${window.label ?? index}`} window={window} cycleDays={provider.cycleDays} now={now} t={t} />
      )) : null}
      {/* OpenCode Go에는 키 인증 사용량 API가 없다. 창은 이 기기 opencode CLI 로그의
          관측 스펜딩이고(OpenUsage 방식), 로컬 데이터가 없으면 그 사실만 정직하게 알린다. */}
      {id === "opencode" && (provider.status === "ok" || provider.status === "stale")
        ? (provider.windows?.length ?? 0) === 0
          ? <div className="quota-signed-out">{t("quota.opencode.noLocalData")}</div>
          : <div className="quota-signed-out">{t("quota.opencode.observedLocal")}</div>
        : null}
      {(provider.status === "ok" || provider.status === "stale") && provider.credits ? (
        <div className="quota-credits">
          <span>{t("quota.credits", { n: provider.credits.available })}</span>
          {provider.credits.nextExpiresAt !== undefined ? <small>{t("quota.credits.expiry", { t: formatCountdown(provider.credits.nextExpiresAt, now) })}</small> : null}
        </div>
      ) : null}
    </section>
  );
}

function QuotaPanel({ ctx }: { readonly ctx: RailPanelContext }) {
  const t = useMemo(() => getT(ctx.language), [ctx.language]);
  const [data, setData] = useState<QuotaSummaryDto | null>(null);
  const [requestError, setRequestError] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [refreshNonce, setRefreshNonce] = useState(0);
  const forceRef = useRef(false);
  const requestGenerationRef = useRef(0);

  const refresh = useCallback((forceRequest = false) => {
    forceRef.current = forceRequest;
    setRefreshNonce((value) => value + 1);
  }, []);

  const connect = useCallback((provider: ConnectableProviderId, connected: boolean) => {
    const generation = beginRequestGeneration(requestGenerationRef);
    if (isLatestRequestGeneration(requestGenerationRef, generation)) setRequestError(false);
    ctx.api.fetch("quota", "connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, connected }),
    })
      .then((response) => {
        if (!response.ok) throw new Error("connect_failed");
        return response.json() as Promise<QuotaSummaryDto>;
      })
      .then((result) => {
        if (isLatestRequestGeneration(requestGenerationRef, generation)) {
          setData(result);
          setRequestError(false);
          setNow(Date.now());
        }
      })
      .catch(() => {
        if (isLatestRequestGeneration(requestGenerationRef, generation)) setRequestError(true);
      });
  }, [ctx.api]);

  useEffect(() => {
    const generation = beginRequestGeneration(requestGenerationRef);
    if (isLatestRequestGeneration(requestGenerationRef, generation)) setRequestError(false);
    const force = forceRef.current;
    forceRef.current = false;
    ctx.api.fetch("quota", force ? "summary?force=1" : "summary")
      .then((response) => {
        if (!response.ok) throw new Error("summary_failed");
        return response.json() as Promise<QuotaSummaryDto>;
      })
      .then((result) => {
        if (isLatestRequestGeneration(requestGenerationRef, generation)) {
          setData(result);
          setRequestError(false);
          setNow(Date.now());
        }
      })
      .catch(() => {
        if (isLatestRequestGeneration(requestGenerationRef, generation)) setRequestError(true);
      });
    return () => {
      if (isLatestRequestGeneration(requestGenerationRef, generation)) {
        beginRequestGeneration(requestGenerationRef);
      }
    };
  }, [ctx.api, refreshNonce]);

  useEffect(() => () => {
    beginRequestGeneration(requestGenerationRef);
  }, []);

  useEffect(() => {
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") refresh(false);
    }, 60_000);
    const ticker = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(ticker);
    };
  }, [refresh]);

  const fetchedAt = Math.max(
    data?.providers.claude.fetchedAt ?? 0,
    data?.providers.codex.fetchedAt ?? 0,
    data?.providers.cursor.fetchedAt ?? 0,
    data?.providers.kimi.fetchedAt ?? 0,
    data?.providers.opencode.fetchedAt ?? 0,
  );
  const updatedMinutes = Math.max(0, Math.floor((now - fetchedAt) / 60_000));
  return (
    <div className="quota-root">
      <div className="quota-body">
        {requestError ? <div className="quota-error">{t("quota.error.summary")}</div> : null}
        {!data && !requestError ? <div className="quota-loading" aria-live="polite">…</div> : null}
        {data ? (
          <>
            <ProviderCard id="claude" provider={data.providers.claude} now={now} t={t} connect={connect} />
            <ProviderCard id="codex" provider={data.providers.codex} now={now} t={t} connect={connect} />
            <ProviderCard id="cursor" provider={data.providers.cursor} now={now} t={t} connect={connect} />
            <ProviderCard id="kimi" provider={data.providers.kimi} now={now} t={t} connect={connect} />
            <ProviderCard id="opencode" provider={data.providers.opencode} now={now} t={t} connect={connect} />
          </>
        ) : null}
      </div>
      <footer className="quota-footer">
        <div className="quota-footer__row">
          {fetchedAt > 0 ? <span>{updatedMinutes < 1 ? t("quota.updated.now") : t("quota.updated.ago", { m: updatedMinutes })}</span> : null}
          <button type="button" className="quota-refresh" onClick={() => refresh(true)}>{t("quota.refresh")}</button>
        </div>
        <p>{t("quota.privacy")}</p>
      </footer>
    </div>
  );
}

function QuotaIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" stroke="currentColor" fill="none" aria-hidden="true" strokeWidth="1.2">
      <path d="M3 14.5V9m4 5.5V5m4 9.5V7m4 7.5V3.5" />
    </svg>
  );
}

export const quotaPanel: RailPanelDescriptor = {
  id: "quota",
  title: (locale) => getT(locale)("quota.panel.title"),
  icon: QuotaIcon,
  defaultWidth: 392,
  render: (ctx) => <QuotaPanel ctx={ctx} />,
};

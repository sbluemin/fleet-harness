import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";
import { useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";

import type { ProviderDto, ProviderStatus, QuotaSummaryDto, QuotaWindow, ResetCredits } from "@fleet-console/ai-gateway";
import { PROVIDER_ORDER_DEFAULT, type ProviderId } from "../provider-order.js";
import { providerGlyph } from "./cli-glyphs.js";
import { getT, type QuotaMessageKey } from "./i18n/index.js";
import { getQuotaSummarySnapshot, holdQuotaPanel, publishQuotaSummary } from "./summary-store.js";
import { getQuotaToolbarSetting, subscribeQuotaToolbarSetting, toggleQuotaToolbarProvider } from "./toolbar-setting.js";

type T = Translate<QuotaMessageKey>;
/** Providers whose credential read is gated behind an explicit connect. */
type ConnectableProviderId = "claude" | "cursor";

export const PROVIDER_NAME: Readonly<Record<ProviderId, string>> = {
  antigravity: "Antigravity",
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  "muse-code": "Muse Code",
  opencode: "OpenCode Go",
  xai: "xAI",
};

/**
 * Upstream plan 라벨에서 카드 헤더가 이미 말하는 공급자명을 걷어낸 표시명.
 * 게이트웨이는 upstream 원문을 그대로 실어 오므로("Muse Code High Usage"),
 * 헤더의 "Muse Code"와 칩이 겹쳐 읽힌다. 공급자명 접두사(대소문자 무시)와 뒤따르는
 * 구분자를 함께 걷으며, 남는 것이 없으면 원문을 그대로 둔다.
 */
export function displayPlanName(id: ProviderId, plan: string): string {
  const name = PROVIDER_NAME[id];
  if (!plan.toLowerCase().startsWith(name.toLowerCase())) return plan;
  const afterPrefix = plan.slice(name.length);
  // 접두사와 구분자 없이 이어지는 낱말(예: "Codexian Pro")은 공급자명이 아니다.
  if (afterPrefix.length > 0 && !/^[\s\-–—:·|/()[\]{}]/.test(afterPrefix)) return plan;
  const removedLead = /^[\s\-–—:·|/()[\]{}]+/.exec(afterPrefix)?.[0] ?? "";
  let stripped = afterPrefix.slice(removedLead.length);
  // 앞에서 연 괄호를 걷어냈을 때만 짝이 맞는 닫는 괄호를 함께 걷는다.
  // "High Usage (5x)"처럼 본문에 딸린 괄호는 손대지 않는다.
  if (/[(\[{]$/.test(removedLead)) {
    const open = removedLead.charAt(removedLead.length - 1);
    const close = open === "(" ? ")" : open === "[" ? "]" : "}";
    if (stripped.endsWith(close)) stripped = stripped.slice(0, -close.length);
  }
  stripped = stripped.replace(/[\s\-–—:·|/]+$/, "").trim();
  return stripped.length > 0 ? stripped : plan;
}

export const SIGNED_OUT_KEY: Readonly<Record<ProviderId, QuotaMessageKey>> = {
  antigravity: "quota.antigravity.signedOut",
  claude: "quota.claude.signedOut",
  codex: "quota.codex.signedOut",
  cursor: "quota.cursor.signedOut",
  "muse-code": "quota.museCode.signedOut",
  opencode: "quota.opencode.signedOut",
  xai: "quota.xai.signedOut",
};

export const EXPIRED_KEY: Readonly<Record<ProviderId, QuotaMessageKey>> = {
  antigravity: "quota.expired.antigravity",
  claude: "quota.expired.claude",
  codex: "quota.expired.codex",
  cursor: "quota.expired.cursor",
  "muse-code": "quota.expired.museCode",
  opencode: "quota.expired.opencode",
  xai: "quota.expired.xai",
};

// Cursor·OpenCode만 이 상태에 도달하지만(claude·codex 파서는 반환하지 않는다),
// 프로바이더별 안내를 공용 문구로 대신하면 다른 공급자의 지시를 보여주게 되므로 나머지도 명시한다.
export const NO_SUBSCRIPTION_KEY: Readonly<Record<ProviderId, QuotaMessageKey>> = {
  antigravity: "quota.noSubscription",
  claude: "quota.noSubscription",
  codex: "quota.noSubscription",
  cursor: "quota.cursor.noSubscription",
  "muse-code": "quota.noSubscription",
  opencode: "quota.opencode.noSubscription",
  xai: "quota.noSubscription",
};

const CREDENTIAL_UNAVAILABLE_KEY: Readonly<Record<string, QuotaMessageKey>> = {
  keychain_denied: "quota.error.credentials.denied",
  keychain_timeout: "quota.error.credentials.timeout",
  malformed: "quota.error.credentials.malformed",
};

/** Gateway가 자격 증명 저장소를 읽지 못했을 때 보내는 고정 문구를 안내 키로 옮긴다. */
export function credentialUnavailableKey(message: string | undefined): QuotaMessageKey | undefined {
  const reason = message?.match(/^Credential store unavailable \(([a-z_]+)\)$/)?.[1];
  return reason === undefined ? undefined : CREDENTIAL_UNAVAILABLE_KEY[reason];
}

/** 이 Gateway가 아직 보고하지 않는 공급자 — 카드를 빼지 않고 읽을 수 없음으로 둔다. */
export const UNREPORTED_PROVIDER: ProviderDto = { status: "error" };

export function isConnectable(id: ProviderId): id is ConnectableProviderId {
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

export function elapsed(at: number | undefined, now: number): string {
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

const DAY_MS = 86_400_000;

function isFiniteTimestamp(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((entry) => entry.type === type)?.value ?? "";
}

/**
 * Calendar instant of a reset, complementary to the remaining-time countdown.
 * More than a day out names the date and local hour; a day or less names the clock.
 */
export function formatResetInstant(
  target: number | undefined,
  now: number,
  locale: ConsoleLocale,
): string | null {
  if (!isFiniteTimestamp(target)) return null;
  const instant = new Date(target);
  if (Number.isNaN(instant.getTime())) return null;
  const remaining = Math.max(0, target - now);
  const clock = new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
  if (remaining <= DAY_MS) return clock;
  const intlLocale = locale === "ko" ? "ko-KR" : "en-US";
  const parts = new Intl.DateTimeFormat(intlLocale, {
    month: locale === "ko" ? "numeric" : "short",
    day: "numeric",
    weekday: "short",
  }).formatToParts(instant);
  const month = part(parts, "month");
  const day = part(parts, "day");
  const weekday = part(parts, "weekday");
  const hour = String(instant.getHours()).padStart(2, "0");
  return locale === "ko"
    ? `${month}월 ${day}일 (${weekday}) ${hour}시`
    : `${month} ${day} (${weekday}) ${clock}`;
}

function resetCaption(resetsAt: number, now: number, locale: ConsoleLocale, t: T): string {
  const countdown = formatCountdown(resetsAt, now);
  const at = formatResetInstant(resetsAt, now, locale);
  return at === null
    ? t("quota.meter.resets", { t: countdown })
    : t("quota.meter.resets.at", { t: countdown, at });
}

/**
 * Codex는 보유량이 0이어도 크레딧 응답을 준다. 0은 알릴 것이 없는 상태이지 알려야 할
 * 사실이 아니므로, 이 자리에서 통째로 걷어 카드가 "0회 사용 가능" 한 줄을 상시로
 * 차지하지 않게 한다. 공급자가 크레딧을 아예 보고하지 않는 경우와 같은 취급이다.
 */
export function visibleCredits(credits: ResetCredits | undefined): ResetCredits | null {
  return credits !== undefined && credits.available > 0 ? credits : null;
}

const SEVERITY_RANK: Readonly<Record<"normal" | "warning" | "critical", number>> = {
  critical: 2,
  normal: 0,
  warning: 1,
};

/**
 * The gateway's own verdict decides the meter's severity. Re-deriving one from
 * `usedPercent` alone is what let a window read calm here while the roster a
 * model reads called it critical: a pool 44% spent one fifth of the way into
 * its cycle is in trouble, and no percentage band can see that. The local bands
 * survive only as a fallback for a reading that arrived without a verdict.
 */
export function meterSeverity(window: QuotaWindow): "normal" | "warning" | "critical" {
  switch (window.risk?.pressure) {
    case "critical": return "critical";
    case "elevated": return "warning";
    case "ok": return "normal";
    default: return window.usedPercent >= 90 ? "critical" : window.usedPercent >= 70 ? "warning" : "normal";
  }
}

/**
 * 공급자를 대변할 가장 급한 창 하나(도구모음 요약의 긴 창 줄).
 *
 * 집계 창(isAggregate)은 형제 풀의 합이라 개별 풀이 말라도 평온하게 읽힌다 —
 * 실제 풀이 하나라도 있으면 후보에서 뺀다. 그다음 순위는 퍼센트가 아니라 게이트웨이의
 * 압력 판정이 먼저다. 회차의 5분의 1 지점에서 44%를 쓴 창은 조용한
 * 60% 창보다 급하고, 퍼센트만 보는 비교로는 그 사실을 볼 수 없다.
 */
export function mostUrgentWindow(windows: readonly QuotaWindow[] | undefined): QuotaWindow | null {
  if (windows === undefined || windows.length === 0) return null;
  const pools = windows.filter((window) => window.isAggregate !== true);
  return (pools.length > 0 ? pools : windows).reduce((worst, window) => {
    const rank = SEVERITY_RANK[meterSeverity(window)] - SEVERITY_RANK[meterSeverity(worst)];
    if (rank !== 0) return rank > 0 ? window : worst;
    return window.usedPercent > worst.usedPercent ? window : worst;
  });
}

/**
 * 구독은 살아 있지만 지금 진행 중인 사용 창이 없다(Muse Code는 이때 사용량을 싣지 않는다).
 * 수치가 없는 성공을 따로 말하지 않으면 아직 읽지 못한 카드와 구분되지 않는다.
 */
export function isIdle(id: ProviderId, provider: ProviderDto): boolean {
  return id === "muse-code"
    && provider.status === "ok"
    && (provider.windows === undefined || provider.windows.length === 0);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * The gateway's projection, but only while it is still a forecast. A reading
 * outlives it: the summary is cached for five minutes and served stale for
 * thirty, so the target can pass before the next one lands. Both the hatching
 * and the note read the projection through here so a lapsed one cannot survive
 * in one channel after being suppressed in the other.
 */
function liveProjectionAt(window: QuotaWindow, now: number): number | undefined {
  const projectedExhaustionAt = window.risk?.projectedExhaustionAt;
  return projectedExhaustionAt !== undefined && projectedExhaustionAt > now ? projectedExhaustionAt : undefined;
}

/**
 * The stretch of the bar the current burn rate is on track to consume before
 * the window resets. The gateway carries a projection only when it lands short
 * of the reset, so an absent span states "this lasts to reset" rather than
 * "unknown".
 */
export function projectedSpan(window: QuotaWindow, now: number): { readonly left: number; readonly width: number } | null {
  if (liveProjectionAt(window, now) === undefined) return null;
  const left = clampPercent(window.usedPercent);
  return left >= 100 ? null : { left, width: 100 - left };
}

/** Where the window's clock stands, which is what makes the fill's position mean anything. */
export function elapsedMarkPercent(window: QuotaWindow): number | null {
  const elapsed = window.risk?.elapsedFraction;
  return elapsed === undefined ? null : clampPercent(Math.round(elapsed * 100));
}

export function formatPace(paceRatio: number): string {
  return `${Math.round(paceRatio * 10) / 10}`;
}

function exhaustNote(window: QuotaWindow, now: number, t: T): string | null {
  const projectedExhaustionAt = liveProjectionAt(window, now);
  return projectedExhaustionAt === undefined
    ? null
    : t("quota.meter.exhausts", { t: formatCountdown(projectedExhaustionAt, now) });
}

export function riskNote(window: QuotaWindow, now: number, t: T): string | null {
  const risk = window.risk;
  if (!risk) return null;
  const exhaust = exhaustNote(window, now, t);
  if (exhaust !== null) return exhaust;
  // Below the gateway's own elevated threshold a ratio is just noise on a bar.
  if (risk.paceRatio !== undefined && risk.pressure !== "ok") {
    return t("quota.meter.pace", { n: formatPace(risk.paceRatio) });
  }
  return null;
}

export function windowLabel(window: QuotaWindow, t: T): string {
  return window.label ?? t(
    window.id === "session"
      ? "quota.meter.session"
      : window.id === "cycle" ? "quota.meter.cycle" : "quota.meter.weekly",
  );
}

/** 창의 주기 표식(5h·7d·Nd). 같은 라벨을 쓰는 창들(예: Antigravity의 두 "Gemini")은 이것으로만 갈린다. */
function windowChip(window: QuotaWindow, cycleDays?: number): string | undefined {
  return window.id === "session"
    ? "5h"
    : window.id === "weekly"
      ? "7d"
      : window.id === "cycle" && cycleDays !== undefined ? `${cycleDays}d` : undefined;
}

function Meter({
  window,
  cycleDays,
  now,
  locale,
  t,
}: {
  readonly window: QuotaWindow;
  readonly cycleDays?: number;
  readonly now: number;
  readonly locale: ConsoleLocale;
  readonly t: T;
}) {
  const severity = meterSeverity(window);
  const label = windowLabel(window, t);
  const chip = windowChip(window, cycleDays);
  const usedText = t("quota.meter.used", { pct: window.usedPercent });
  const note = riskNote(window, now, t);
  const projection = projectedSpan(window, now);
  const elapsedMark = elapsedMarkPercent(window);
  return (
    <div className={`quota-meter quota-meter--${severity}`}>
      <div className="quota-meter__top">
        <span className="quota-meter__label">{label}{chip ? <span className="quota-meter__window">{chip}</span> : null}</span>
        {note !== null ? <span className="quota-meter__forecast">{note}</span> : null}
      </div>
      <div
        className="quota-meter__bar"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.usedPercent}
        {...(note !== null ? { "aria-valuetext": `${usedText} · ${note}` } : {})}
      >
        {projection ? (
          <span
            className="quota-meter__projection"
            title={t("quota.meter.projected")}
            style={{ left: `${projection.left}%`, width: `${projection.width}%` }}
          />
        ) : null}
        <span className="quota-meter__fill" style={{ width: `${clampPercent(window.usedPercent)}%` }} />
        {elapsedMark !== null ? (
          <span
            className="quota-meter__elapsed"
            title={t("quota.meter.elapsed", { pct: elapsedMark })}
            style={{ left: `${elapsedMark}%` }}
          />
        ) : null}
      </div>
      <div className="quota-meter__foot">
        <span className="quota-meter__percent">{usedText}</span>
        {window.resetsAt !== undefined ? (
          <span className="quota-meter__reset">{resetCaption(window.resetsAt, now, locale, t)}</span>
        ) : null}
      </div>
    </div>
  );
}

function StatusStrip({ kind, children }: { readonly kind: "expired" | "stale" | "error"; readonly children: React.ReactNode }) {
  return <div className={`quota-strip quota-strip--${kind}`}>{children}</div>;
}

/**
 * 막대의 채움·눈금·빗금이 각각 무엇인지, 그리고 이 수치가 어디서 오는지 설명한다.
 * 미터마다 두지 않고 패널에 하나만 두는 이유는 한 번 읽으면 끝나는 설명이기 때문이다 —
 * 최대 11개까지 뜨는 미터마다 붙이면 같은 문장을 열한 번 물어보게 된다.
 *
 * 팝업 머리에 사는 만큼 아래로 열린다. hover는 마우스용이고, 포인터가 없는 기기와
 * 키보드는 버튼을 눌러 고정한다. 두 경로를 모두 두지 않으면 터치에서는 영영 열리지 않는다.
 * 포커스만으로는 열지 않는다 — 그러면 Escape가 상태를 내려도 화면에는 남는다.
 */
function BarLegend({ t }: { readonly t: T }) {
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!pinned) return;
    // 고정된 말풍선의 Escape는 말풍선만 닫는다 — 포획 단계에서 먼저 받아 defaultPrevented로 표시하면,
    // 팝업의 Escape(버블 단계)는 그것을 보고 팝업째 닫지 않는다.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setPinned(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target) === true) return;
      setPinned(false);
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [pinned]);

  return (
    <div className={`quota-legend${pinned ? " quota-legend--pinned" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="quota-legend__toggle"
        aria-expanded={pinned}
        aria-label={t("quota.legend.action")}
        onClick={() => setPinned((value) => !value)}
      >
        ?
      </button>
      <div className="quota-legend__bubble" role="note">
        <p className="quota-legend__row">
          <span className="quota-legend__swatch" aria-hidden="true"><i className="quota-legend__swatch-fill" /></span>
          {t("quota.legend.fill")}
        </p>
        <p className="quota-legend__row">
          <span className="quota-legend__swatch" aria-hidden="true"><i className="quota-legend__swatch-elapsed" /></span>
          {t("quota.legend.elapsed")}
        </p>
        <p className="quota-legend__row">
          <span className="quota-legend__swatch" aria-hidden="true"><i className="quota-legend__swatch-projection" /></span>
          {t("quota.legend.projection")}
        </p>
        <p className="quota-legend__note">{t("quota.privacy")}</p>
      </div>
    </div>
  );
}

/** 크레딧 칩의 표식. 미터의 리셋 카운트다운과 달리 "내가 당길 수 있는 리셋"이라 회전 화살표를 쓴다. */
function ResetGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.5 6a4.5 4.5 0 1 1-4.5-4.5c1.26 0 2.47.53 3.35 1.41L10.5 4" />
      <path d="M10.5 1.5V4H8" />
    </svg>
  );
}

function ProviderCard({
  id,
  provider,
  now,
  locale,
  t,
  connect,
}: {
  readonly id: ProviderId;
  readonly provider: ProviderDto;
  readonly now: number;
  readonly locale: ConsoleLocale;
  readonly t: T;
  readonly connect: (provider: ConnectableProviderId, connected: boolean) => void;
}) {
  const name = PROVIDER_NAME[id];
  if (isConnectable(id) && provider.status === "not_connected") {
    return (
      <section className="quota-connect-card" data-provider={id}>
        <header className="quota-provider__header">
          <span className={`quota-provider__mark quota-provider__mark--${id}`}>{providerGlyph(id)}</span>
          <h3>{t(id === "claude" ? "quota.connect.title" : "quota.connect.title.cursor")}</h3>
        </header>
        <p>{t(id === "claude" ? "quota.connect.body" : "quota.connect.body.cursor")}</p>
        {provider.method === "keychain" ? <p className="quota-connect-card__hint">{t("quota.connect.keychain")}</p> : null}
        <button type="button" className="quota-button quota-button--primary" onClick={() => connect(id, true)}>{t(id === "claude" ? "quota.connect.action" : "quota.connect.action.cursor")}</button>
      </section>
    );
  }
  return (
    <section className="quota-provider" data-provider={id}>
      <header className="quota-provider__header">
        <span className={`quota-provider__mark quota-provider__mark--${id}`}>{providerGlyph(id)}</span>
        <h3>{name}</h3>
        {isConnectable(id) ? <button type="button" className="quota-disconnect" onClick={() => connect(id, false)}>{t("quota.disconnect.action")}</button> : null}
        {provider.plan ? <span className="quota-plan" title={provider.plan}>{displayPlanName(id, provider.plan)}</span> : null}
      </header>
      {provider.status === "signed_out" ? <div className="quota-signed-out">{t(SIGNED_OUT_KEY[id])}</div> : null}
      {provider.status === "no_subscription" ? <div className="quota-signed-out">{t(NO_SUBSCRIPTION_KEY[id])}</div> : null}
      {isIdle(id, provider) ? <div className="quota-signed-out">{t("quota.museCode.idle")}</div> : null}
      {provider.status === "expired" ? <StatusStrip kind="expired">{t(EXPIRED_KEY[id])}</StatusStrip> : null}
      {provider.status === "stale" ? <StatusStrip kind="stale">{t("quota.stale", { provider: name, t: elapsed(provider.fetchedAt, now) })}</StatusStrip> : null}
      {provider.status === "stale" ? (() => {
        // 이전 값을 보여 주더라도 사용자가 고칠 수 있는 원인(키체인 권한 등)은 가리지 않는다.
        const credentialKey = credentialUnavailableKey(provider.message);
        return credentialKey ? <StatusStrip kind="error">{t(credentialKey, { provider: name })}</StatusStrip> : null;
      })() : null}
      {provider.status === "error" ? (() => {
        const match = provider.message?.match(/^Certificate verification failed \(([A-Za-z0-9_]+)\)$/);
        if (match?.[1] !== undefined) {
          return <StatusStrip kind="error">{t("quota.error.tls", { provider: name, code: match[1] })}</StatusStrip>;
        }
        // 로그인이 없는 것과 저장소를 읽지 못한 것은 다른 조치를 부른다 — 로그인하라고 하면 틀린 지시가 된다.
        const credentialKey = credentialUnavailableKey(provider.message);
        return credentialKey
          ? <StatusStrip kind="error">{t(credentialKey, { provider: name })}</StatusStrip>
          : <div className="quota-error">{t("quota.error", { provider: name })}</div>;
      })() : null}
      {(provider.status === "ok" || provider.status === "stale") ? provider.windows?.map((window, index) => (
        <Meter key={`${window.id}-${window.label ?? index}`} window={window} cycleDays={provider.cycleDays} now={now} locale={locale} t={t} />
      )) : null}
      {(provider.status === "ok" || provider.status === "stale") ? (() => {
        const credits = visibleCredits(provider.credits);
        if (!credits) return null;
        return (
          <div className="quota-credits">
            <span className="quota-credits__chip">
              <ResetGlyph />
              {t("quota.credits", { n: credits.available })}
            </span>
            {credits.nextExpiresAt !== undefined ? <small>{t("quota.credits.expiry", { t: formatCountdown(credits.nextExpiresAt, now) })}</small> : null}
          </div>
        );
      })() : null}
    </section>
  );
}

/**
 * `revalidating`은 `stale=1` 요청이 만료된 캐시를 먼저 받았고 Gateway가 뒤에서 다시 읽는
 * 중이라는 뜻이다 — 공유 DTO가 아니라 이 플러그인 응답에만 있다.
 */
type SummaryResponse = QuotaSummaryDto & { readonly revalidating?: boolean };

interface RememberedPanel {
  readonly data: QuotaSummaryDto;
  readonly checkedAt: number;
}

/* 팝업을 닫으면 패널은 언마운트된다. 다시 열 때 이미 읽은 요약을 두고 "불러오는 중"부터
   보이지 않도록, 마지막으로 그린 것을 이 번들 안에 남겨 첫 렌더에 쓴다. 마운트가 곧바로 새
   요청을 보내 도착하면 갈아 끼우고, 오래된 정도는 머리의 "갱신 N분 전"이 말한다.
   preferences(localStorage)가 아닌 이유: 새로고침을 넘어 며칠 전 수치를 되살릴 이유가 없고,
   폴링마다 쓰기를 남길 설정 채널도 아니다. */
let rememberedPanel: RememberedPanel | null = null;

/**
 * 사용 한도 요약의 읽기 상태 — 팝업 패널(데스크톱)과 폰의 설정 상세가 같은 원천·같은 폴링·같은 연결 동작을 쓴다.
 * 마운트되어 있는 동안 폴링은 이 훅의 소유자 몫이다(holdQuotaPanel).
 */
export function useQuotaData(api: ClientApiCapability) {
  const [restored] = useState(() => rememberedPanel);
  // 처음 여는 순간에도 도구모음 요약이 이미 읽어 둔 값이 있으면 그것부터 그린다(같은 원천).
  const [shared] = useState(() => getQuotaSummarySnapshot());
  const [data, setData] = useState<QuotaSummaryDto | null>(restored?.data ?? shared.data);
  const [checkedAt, setCheckedAt] = useState(restored?.checkedAt ?? shared.checkedAt);
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
    api.fetch("quota", "connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, connected }),
    })
      .then((response) => {
        if (!response.ok) throw new Error("connect_failed");
        return response.json() as Promise<SummaryResponse>;
      })
      .then((result) => {
        if (isLatestRequestGeneration(requestGenerationRef, generation)) {
          setData(result);
          setRequestError(false);
          const adoptedAt = Date.now();
          setNow(adoptedAt);
          setCheckedAt(adoptedAt);
        }
      })
      .catch(() => {
        if (isLatestRequestGeneration(requestGenerationRef, generation)) setRequestError(true);
      });
  }, [api]);

  useEffect(() => {
    const generation = beginRequestGeneration(requestGenerationRef);
    if (isLatestRequestGeneration(requestGenerationRef, generation)) setRequestError(false);
    const force = forceRef.current;
    forceRef.current = false;
    // 그릴 것이 하나도 없을 때만 만료된 캐시라도 먼저 받는다. 이미 그린 화면이 있으면
    // 기다림이 보이지 않으므로 평소대로 새 값을 기다린다.
    const path = force ? "summary?force=1" : data === null ? "summary?stale=1" : "summary";
    api.fetch("quota", path)
      .then((response) => {
        if (!response.ok) throw new Error("summary_failed");
        return response.json() as Promise<SummaryResponse>;
      })
      .then((result) => {
        if (isLatestRequestGeneration(requestGenerationRef, generation)) {
          setData(result);
          setRequestError(false);
          const adoptedAt = Date.now();
          setNow(adoptedAt);
          if (result.revalidating !== true) setCheckedAt(adoptedAt);
          // 뒤에서 도는 갱신에 일반 요청으로 합류한다 — Gateway가 single-flight로 묶어 upstream을
          // 다시 부르지 않고, 그 갱신이 끝나는 순간 답이 온다.
          if (result.revalidating === true) refresh(false);
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
  }, [api, refresh, refreshNonce]);

  useEffect(() => () => {
    beginRequestGeneration(requestGenerationRef);
  }, []);

  // 화면에 선 그대로를 남긴다. 도구모음 요약도 같은 값을 읽는다.
  useEffect(() => {
    if (data === null) return;
    rememberedPanel = { data, checkedAt };
    publishQuotaSummary(data, checkedAt);
  }, [data, checkedAt]);

  // 팝업이 서 있는 동안은 폴링이 패널 몫이다 — 도구모음 요약은 그동안 따로 묻지 않는다.
  useEffect(() => holdQuotaPanel(), []);

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

  return { data, checkedAt, now, requestError, refresh, connect };
}

/**
 * 사용 한도 팝업의 내용 — 머리(제목·갱신 시각·범례·새로고침), 공급자 카드(고정 순서), 바닥의
 * 「도구모음에 표시」 글리프 줄. 열려 있는 동안 폴링은 이 패널 몫이다(holdQuotaPanel).
 */
export function QuotaPanel({ api, locale, labelId }: {
  readonly api: ClientApiCapability;
  readonly locale: ConsoleLocale;
  readonly labelId: string;
}) {
  const t = useMemo(() => getT(locale), [locale]);
  const { data, checkedAt, now, requestError, refresh, connect } = useQuotaData(api);
  const fetchedAt = Math.max(0, ...PROVIDER_ORDER_DEFAULT.map((id) => data?.providers[id]?.fetchedAt ?? 0));
  const updatedMinutes = Math.max(0, Math.floor((now - fetchedAt) / 60_000));
  const checkedMinutes = Math.max(0, Math.floor((now - checkedAt) / 60_000));
  return (
    <div className="quota-root">
      <header className="quota-head">
        <h2 className="quota-head__title" id={labelId}>{t("quota.panel.title")}</h2>
        <span className="quota-head__when">
          {fetchedAt > 0
            ? (updatedMinutes < 1 ? t("quota.updated.now") : t("quota.updated.ago", { m: updatedMinutes }))
            : checkedAt > 0
              ? (checkedMinutes < 1 ? t("quota.checked.now") : t("quota.checked.ago", { m: checkedMinutes }))
              : null}
        </span>
        <BarLegend t={t} />
        <button type="button" className="quota-refresh" onClick={() => refresh(true)}>{t("quota.refresh")}</button>
      </header>
      <div className="quota-body">
        {requestError ? <div className="quota-error">{t("quota.error.summary")}</div> : null}
        {!data && !requestError ? (
          <div className="quota-state" role="status">
            <span className="quota-state__mark" aria-hidden="true" />
            <strong>{t("quota.loading.title")}</strong>
            <p>{t("quota.loading.body")}</p>
          </div>
        ) : null}
        {data ? PROVIDER_ORDER_DEFAULT.map((id) => (
          <ProviderCard
            key={id}
            id={id}
            provider={data.providers[id] ?? UNREPORTED_PROVIDER}
            now={now}
            locale={locale}
            t={t}
            connect={connect}
          />
        )) : null}
      </div>
      <footer className="quota-footer">
        <ToolbarProviderPicker t={t} />
      </footer>
    </div>
  );
}

/**
 * 팝업 바닥의 「도구모음에 표시」 줄 — 공급자마다 글리프 하나로 도구모음 요약에 세울지를 고른다.
 * 순서는 고정 순서다. 모두 끄면 도구모음에는 막대 글리프 하나만 남아 이 팝업을 다시 연다.
 */
function ToolbarProviderPicker({ t }: { readonly t: T }) {
  const { toolbarProviders } = useStoreSnapshot(subscribeQuotaToolbarSetting, getQuotaToolbarSetting);
  return (
    <div className="quota-footer__row quota-footer__toolbar" role="group" aria-label={t("quota.toolbar.toggle")}>
      <span className="quota-footer__toolbar-label" aria-hidden="true">{t("quota.toolbar.toggle")}</span>
      <span className="quota-toolbar-picks">
        {PROVIDER_ORDER_DEFAULT.map((id) => {
          const shown = toolbarProviders.includes(id);
          const label = t("quota.toolbar.switch", { provider: PROVIDER_NAME[id] });
          return (
            <button
              key={id}
              type="button"
              className="quota-toolbar-pick"
              aria-pressed={shown}
              aria-label={label}
              title={label}
              onClick={() => { toggleQuotaToolbarProvider(id, !shown).catch(() => undefined); }}
            >
              <span className={`quota-provider__mark quota-provider__mark--${id}`} aria-hidden="true">{providerGlyph(id)}</span>
            </button>
          );
        })}
      </span>
    </div>
  );
}

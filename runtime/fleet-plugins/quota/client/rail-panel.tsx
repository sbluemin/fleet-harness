import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { ProviderDto, ProviderStatus, QuotaSummaryDto, QuotaWindow, ResetCredits } from "@dotobokuri/core-ai-gateway";
import {
  isProviderId,
  PROVIDER_ORDER_DEFAULT,
  sanitizeFoldedProviders,
  sanitizeProviderOrder,
  toggledFoldedProviders,
  type ProviderId,
} from "../provider-order.js";
import { providerGlyph } from "./cli-glyphs.js";
import { getT, type QuotaMessageKey } from "./i18n/index.js";
import "./quota.css";

export { PROVIDER_ORDER_DEFAULT, sanitizeFoldedProviders, sanitizeProviderOrder, toggledFoldedProviders };
export type { ProviderId };

type T = Translate<QuotaMessageKey>;
/** Providers whose credential read is gated behind an explicit connect. */
type ConnectableProviderId = "claude" | "cursor";

const PROVIDER_NAME: Readonly<Record<ProviderId, string>> = {
  antigravity: "Antigravity",
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  kimi: "Kimi",
  opencode: "OpenCode Go",
  xai: "xAI",
};

export const SIGNED_OUT_KEY: Readonly<Record<ProviderId, QuotaMessageKey>> = {
  antigravity: "quota.antigravity.signedOut",
  claude: "quota.claude.signedOut",
  codex: "quota.codex.signedOut",
  cursor: "quota.cursor.signedOut",
  kimi: "quota.kimi.signedOut",
  opencode: "quota.opencode.signedOut",
  xai: "quota.xai.signedOut",
};

export const EXPIRED_KEY: Readonly<Record<ProviderId, QuotaMessageKey>> = {
  antigravity: "quota.expired.antigravity",
  claude: "quota.expired.claude",
  codex: "quota.expired.codex",
  cursor: "quota.expired.cursor",
  kimi: "quota.expired.kimi",
  opencode: "quota.expired.opencode",
  xai: "quota.expired.xai",
};

// Cursor·Kimi·OpenCode만 이 상태에 도달하지만(claude·codex 파서는 반환하지 않는다),
// 프로바이더별 안내를 공용 문구로 대신하면 다른 공급자의 지시를 보여주게 되므로 나머지도 명시한다.
export const NO_SUBSCRIPTION_KEY: Readonly<Record<ProviderId, QuotaMessageKey>> = {
  antigravity: "quota.noSubscription",
  claude: "quota.noSubscription",
  codex: "quota.noSubscription",
  cursor: "quota.noSubscription",
  kimi: "quota.kimi.noSubscription",
  opencode: "quota.opencode.noSubscription",
  xai: "quota.noSubscription",
};

function isConnectable(id: ProviderId): id is ConnectableProviderId {
  return id === "claude" || id === "cursor";
}

/** 한 칸 이동. 경계 밖이면 null — 호출자가 저장·공지를 건너뛴다. */
export function movedProviderOrder(
  order: readonly ProviderId[],
  id: ProviderId,
  delta: -1 | 1,
): ProviderId[] | null {
  const index = order.indexOf(id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= order.length) return null;
  const next = [...order];
  next.splice(index, 1);
  next.splice(target, 0, id);
  return next;
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

/**
 * 응답이 실어온 접힘을 채택해도 되는가. 두 조건의 논리곱이며, 둘 중 하나만으로는
 * 실측된 두 결함이 각각 남는다.
 *
 * - `revision === persisted` — 요청이 떠날 때 서버가 이미 우리가 든 것과 같은 집합을
 *   들고 있었는가. 저장이 아직 도달하지 않은 채로 나간 요청은 그 이전 집합을 실어 온다.
 * - `current === revision` — 떠난 뒤로 사용자가 카드를 접지 않았는가. 그 사이의 조작은
 *   이 답보다 새롭다.
 *
 * 둘 다 아닐 때 채택하면 화면과 서버가 갈리고, 다음 토글이 그 옛 집합 위에서 계산되어
 * 이미 저장된 접힘을 지운다.
 */
export function adoptsFoldedProviders(
  captured: { readonly revision: number; readonly persisted: number },
  current: number,
): boolean {
  return captured.revision === captured.persisted && current === captured.revision;
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
 * 접힌 행이 대변할 창 하나.
 *
 * 집계 창(isAggregate)은 형제 창들의 합이라 개별 풀이 말라도 평온하게 읽힌다 —
 * 실제 풀이 하나라도 있으면 집계는 후보에서 뺀다. 그다음 순위는 퍼센트가 아니라
 * 게이트웨이의 압력 판정이 먼저다. 회차의 5분의 1 지점에서 44%를 쓴 창은 조용한
 * 60% 창보다 급하고, 퍼센트만 보는 비교로는 그 사실을 볼 수 없다.
 */
export function foldedWindow(windows: readonly QuotaWindow[] | undefined): QuotaWindow | null {
  if (windows === undefined || windows.length === 0) return null;
  const pools = windows.filter((window) => window.isAggregate !== true);
  const candidates = pools.length > 0 ? pools : windows;
  return candidates.reduce((worst, window) => {
    const rank = SEVERITY_RANK[meterSeverity(window)] - SEVERITY_RANK[meterSeverity(worst)];
    if (rank !== 0) return rank > 0 ? window : worst;
    return window.usedPercent > worst.usedPercent ? window : worst;
  });
}

/**
 * 읽을 수치가 없는 카드가 접혔을 때 그 자리에 남는 한 마디. 카드를 펼쳐야 알 수 있는
 * 긴 안내를 줄이는 것이 아니라, "여기에는 볼 것이 없다"는 사실 자체를 행에 남긴다 —
 * 없으면 접힌 행은 이름만 남아 아직 못 읽은 카드와 구분되지 않는다.
 */
export const FOLDED_STATUS_KEY: Readonly<Partial<Record<ProviderStatus, QuotaMessageKey>>> = {
  error: "quota.fold.unavailable",
  expired: "quota.fold.expired",
  no_subscription: "quota.fold.noSubscription",
  not_connected: "quota.fold.notConnected",
  signed_out: "quota.fold.signedOut",
  stale: "quota.fold.unavailable",
};

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * The gateway's projection, but only while it is still a forecast. A reading
 * outlives it: the summary is cached for two minutes and served stale for
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
  const usedText = t("quota.meter.used", { pct: window.usedPercent });
  const note = riskNote(window, now, t);
  const projection = projectedSpan(window, now);
  const elapsedMark = elapsedMarkPercent(window);
  return (
    <div className={`quota-meter quota-meter--${severity}`}>
      <div className="quota-meter__top">
        <span className="quota-meter__label">{label}{windowChip ? <span className="quota-meter__window">{windowChip}</span> : null}</span>
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
 * 상주 푸터에 사는 만큼 위로 열린다. hover는 마우스용이고, 포인터가 없는 기기와
 * 키보드는 버튼을 눌러 고정한다. 두 경로를 모두 두지 않으면 터치에서는 영영 열리지 않는다.
 * 포커스만으로는 열지 않는다 — 그러면 Escape가 상태를 내려도 화면에는 남는다.
 */
function BarLegend({ t }: { readonly t: T }) {
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!pinned) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPinned(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target) === true) return;
      setPinned(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
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

/* 드래그와 키보드 이동이 같은 자리에서 시작한다. 실제 조작은 패널이 위임으로 받고,
   버튼인 이유는 키보드 포커스가 앉을 실재하는 자리가 필요해서다. */
function GripButton({ name, t }: { readonly name: string; readonly t: T }) {
  return (
    <button type="button" className="quota-grip" aria-label={t("quota.reorder.handle", { provider: name })}>
      <svg width="8" height="13" viewBox="0 0 8 13" aria-hidden="true">
        <g fill="currentColor">
          <circle cx="1.5" cy="1.5" r="1.3" /><circle cx="6.5" cy="1.5" r="1.3" />
          <circle cx="1.5" cy="6.5" r="1.3" /><circle cx="6.5" cy="6.5" r="1.3" />
          <circle cx="1.5" cy="11.5" r="1.3" /><circle cx="6.5" cy="11.5" r="1.3" />
        </g>
      </svg>
    </button>
  );
}

/* 카드 하나를 헤더 한 줄로 접었다 펴는 조작. 그립·연결 해제와 나란한 형제 버튼인
   이유는 버튼이 버튼을 품을 수 없어서다 — 헤더 전체를 하나의 disclosure 버튼으로
   만들면 이미 그 안에 사는 두 컨트롤이 접근성 트리에서 사라진다. */
function FoldButton({
  folded,
  name,
  regionId,
  onToggle,
  t,
}: {
  readonly folded: boolean;
  readonly name: string;
  readonly regionId: string;
  readonly onToggle: () => void;
  readonly t: T;
}) {
  return (
    <button
      type="button"
      className="quota-fold"
      aria-expanded={!folded}
      aria-controls={regionId}
      aria-label={t(folded ? "quota.unfold.action" : "quota.fold.action", { provider: name })}
      onClick={onToggle}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M1.5 3.5 L5 7 L8.5 3.5" />
      </svg>
    </button>
  );
}

/**
 * 접힌 행에 남는 요약. 접기가 "치워두기"가 아니라 "밀도 바꾸기"가 되는 지점이다 —
 * 이 자리가 비면 90%를 넘긴 공급자를 접어둔 사용자는 그 사실을 어디서도 듣지 못한다.
 * 패널 밖에 쿼터 신호가 하나도 없어 이 행이 유일한 통로이기 때문이다.
 *
 * 막대는 미터와 같은 채널을 탄다(--meter-accent/--meter-weight). 심각도가 두 문법으로
 * 갈리면 같은 공급자가 접힘/펼침에서 서로 다른 판정을 말하게 된다.
 */
function FoldSpine({
  provider,
  now,
  t,
}: {
  readonly provider: ProviderDto;
  readonly now: number;
  readonly t: T;
}) {
  const window = (provider.status === "ok" || provider.status === "stale")
    ? foldedWindow(provider.windows)
    : null;
  if (window === null) {
    const statusKey = FOLDED_STATUS_KEY[provider.status];
    return statusKey === undefined
      ? null
      : <span className="quota-fold-spine quota-fold-spine--quiet">{t(statusKey)}</span>;
  }
  const severity = meterSeverity(window);
  const countdown = window.resetsAt === undefined ? null : formatCountdown(window.resetsAt, now);
  const used = t("quota.meter.used", { pct: window.usedPercent });
  return (
    <span
      className={`quota-fold-spine quota-fold-spine--${severity}`}
      role="img"
      aria-label={countdown === null ? used : t("quota.fold.summary", { pct: window.usedPercent, t: countdown })}
    >
      <span className="quota-fold-spine__percent">{window.usedPercent}%</span>
      <span className="quota-fold-spine__bar">
        <span className="quota-fold-spine__fill" style={{ width: `${clampPercent(window.usedPercent)}%` }} />
      </span>
      {countdown === null ? null : <span className="quota-fold-spine__reset">{countdown}</span>}
    </span>
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
  dragging,
  folded,
  toggleFold,
}: {
  readonly id: ProviderId;
  readonly provider: ProviderDto;
  readonly now: number;
  readonly locale: ConsoleLocale;
  readonly t: T;
  readonly connect: (provider: ConnectableProviderId, connected: boolean) => void;
  readonly dragging: boolean;
  readonly folded: boolean;
  readonly toggleFold: (provider: ProviderId) => void;
}) {
  const name = PROVIDER_NAME[id];
  const regionId = `quota-card-${id}`;
  // 접힌 카드가 위험을 말하고 있으면 테두리도 그 판정을 입는다. 40px 행 일곱 줄을
  // 훑을 때 한 줄만 읽게 만드는 것은 스파인의 숫자가 아니라 이 테두리다.
  const summary = folded && (provider.status === "ok" || provider.status === "stale")
    ? foldedWindow(provider.windows)
    : null;
  const alarm = summary !== null && meterSeverity(summary) === "critical";
  const modifiers = `${dragging ? " quota-card--dragging" : ""}${folded ? " quota-card--folded" : ""}${alarm ? " quota-card--alarm" : ""}`;
  const foldButton = (
    <FoldButton folded={folded} name={name} regionId={regionId} onToggle={() => toggleFold(id)} t={t} />
  );
  if (isConnectable(id) && provider.status === "not_connected") {
    const titleKey = id === "claude" ? "quota.connect.title" : "quota.connect.title.cursor";
    const bodyKey = id === "claude" ? "quota.connect.body" : "quota.connect.body.cursor";
    const actionKey = id === "claude" ? "quota.connect.action" : "quota.connect.action.cursor";
    return (
      <section className={`quota-connect-card${modifiers}`} data-provider={id}>
        <header className="quota-provider__header">
          <GripButton name={name} t={t} />
          <span className={`quota-provider__mark quota-provider__mark--${id}`}>{providerGlyph(id)}</span>
          {/* 접힌 행은 목록의 한 줄이지 권유가 아니다 — 버튼이 사라진 자리에 "연결하세요"만
              남으면 누를 곳 없는 지시가 된다. 그 자리에는 공급자 이름을 둔다. */}
          <h3>{folded ? name : t(titleKey)}</h3>
          {folded ? <FoldSpine provider={provider} now={now} t={t} /> : null}
          {foldButton}
        </header>
        <div className="quota-card__collapse" id={regionId}>
          <div className="quota-card__rest">
            <p>{t(bodyKey)}</p>
            {provider.method === "keychain" ? <p className="quota-connect-card__hint">{t("quota.connect.keychain")}</p> : null}
            <button type="button" className="quota-button quota-button--primary" onClick={() => connect(id, true)}>{t(actionKey)}</button>
          </div>
        </div>
      </section>
    );
  }
  return (
    <section className={`quota-provider${modifiers}`} data-provider={id}>
      <header className="quota-provider__header">
        <GripButton name={name} t={t} />
        <span className={`quota-provider__mark quota-provider__mark--${id}`}>{providerGlyph(id)}</span>
        <h3>{name}</h3>
        {folded ? <FoldSpine provider={provider} now={now} t={t} /> : null}
        {isConnectable(id) ? <button type="button" className="quota-disconnect" onClick={() => connect(id, false)}>{t("quota.disconnect.action")}</button> : null}
        {provider.plan ? <span className="quota-plan">{provider.plan}</span> : null}
        {foldButton}
      </header>
      <div className="quota-card__collapse" id={regionId}>
      <div className="quota-card__rest">
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
      </div>
      </div>
    </section>
  );
}

/** summary 계열 응답은 코어 DTO에 플러그인 소유의 패널 설정을 얹어 온다. */
type SummaryResponse = QuotaSummaryDto & {
  readonly providerOrder?: unknown;
  readonly foldedProviders?: unknown;
};

function QuotaPanel({ ctx }: { readonly ctx: RailPanelContext }) {
  const t = useMemo(() => getT(ctx.language), [ctx.language]);
  const [data, setData] = useState<QuotaSummaryDto | null>(null);
  const [requestError, setRequestError] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [order, setOrder] = useState<readonly ProviderId[]>(PROVIDER_ORDER_DEFAULT);
  const [folded, setFolded] = useState<readonly ProviderId[]>([]);
  const [draggingId, setDraggingId] = useState<ProviderId | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const forceRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const dropLineRef = useRef<HTMLSpanElement | null>(null);
  const dragRef = useRef<{ id: ProviderId; pointerY: number; startY: number; moved: boolean; raf: number } | null>(null);
  // 저장 요청 체인. 연속 이동의 POST가 서로를 추월하면 서버는 도착순으로 기록해
  // 옛 순열이 최종본이 될 수 있다 — 앞 요청이 끝난 뒤에만 다음을 보낸다.
  const orderSaveRef = useRef<Promise<void>>(Promise.resolve());
  // 접힘도 같은 이유로 직렬화한다. 두 번 빠르게 누르면 두 POST가 서로를 추월해
  // 화면은 펼쳐진 채 서버는 접힘으로 남을 수 있다.
  const foldSaveRef = useRef<Promise<void>>(Promise.resolve());
  /* 토글이 읽는 진실은 상태가 아니라 이 ref다. 같은 틱에 두 카드를 접으면 두 핸들러가
     모두 렌더 전의 옛 집합을 읽어, 나중 것이 앞의 접힘을 지운 채로 저장된다. */
  const foldedRef = useRef<readonly ProviderId[]>([]);
  /* 응답이 실어온 접힘을 채택해도 되는지는 "지금 저장이 날아가는 중인가"로 판정할 수 없다.
     서버는 요청을 받은 시점의 설정을 읽고, 그 답이 오는 사이에 사용자가 접은 카드의 저장은
     이미 끝나 있을 수 있다 — 그 순간 카운터는 0이라 옛 집합이 통과한다. 실측에서 화면은
     펼쳐졌는데 서버는 접힘이었고, 다음 토글이 그 옛 집합 위에서 계산되어 앞의 접힘을
     지웠다. 그래서 요청이 출발한 시점의 리비전을 들고 있다가 그때 그대로일 때만 채택한다. */
  const foldRevisionRef = useRef(0);
  /* 서버가 들고 있다고 확인된 리비전. 토글은 리비전을 올리지만 저장은 foldSaveRef 뒤에
     줄을 서므로, 둘이 어긋난 동안 떠난 요청은 아직 저장되지 않은 집합을 실어 온다. */
  const foldPersistedRef = useRef(0);

  const adoptFolded = useCallback((next: readonly ProviderId[]) => {
    foldedRef.current = next;
    setFolded(next);
  }, []);

  const refresh = useCallback((forceRequest = false) => {
    forceRef.current = forceRequest;
    setRefreshNonce((value) => value + 1);
  }, []);

  const connect = useCallback((provider: ConnectableProviderId, connected: boolean) => {
    const generation = beginRequestGeneration(requestGenerationRef);
    const foldCapture = { persisted: foldPersistedRef.current, revision: foldRevisionRef.current };
    if (isLatestRequestGeneration(requestGenerationRef, generation)) setRequestError(false);
    ctx.api.fetch("quota", "connect", {
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
          setOrder(sanitizeProviderOrder(result.providerOrder));
          if (adoptsFoldedProviders(foldCapture, foldRevisionRef.current)) {
            adoptFolded(sanitizeFoldedProviders(result.foldedProviders));
          }
          setRequestError(false);
          setNow(Date.now());
        }
      })
      .catch(() => {
        if (isLatestRequestGeneration(requestGenerationRef, generation)) setRequestError(true);
      });
  }, [ctx.api]);

  const persistOrder = useCallback((next: readonly ProviderId[], movedId: ProviderId) => {
    setOrder(next);
    setAnnouncement(t("quota.reorder.moved", { provider: PROVIDER_NAME[movedId], n: next.indexOf(movedId) + 1 }));
    const save = () => ctx.api.fetch("quota", "order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: next }),
    })
      .then((response) => {
        if (!response.ok) throw new Error("order_failed");
      })
      .catch(() => {
        // 낙관 반영을 손으로 되돌리지 않는다 — summary가 실어 오는 서버 진실로 재동기화한다.
        setAnnouncement(t("quota.reorder.error"));
        refresh(false);
      });
    orderSaveRef.current = orderSaveRef.current.then(save, save);
  }, [ctx.api, t, refresh]);

  const toggleFold = useCallback((id: ProviderId) => {
    const next = toggledFoldedProviders(foldedRef.current, id);
    adoptFolded(next);
    setAnnouncement(t(
      next.includes(id) ? "quota.fold.announced" : "quota.unfold.announced",
      { provider: PROVIDER_NAME[id] },
    ));
    const revision = beginRequestGeneration(foldRevisionRef);
    const save = () => ctx.api.fetch("quota", "fold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folded: next }),
    })
      .then((response) => {
        if (!response.ok) throw new Error("fold_failed");
      })
      .then(
        () => {
          // 저장은 직렬화되어 순서대로 끝나지만, 이 값은 앞으로만 간다는 것이 계약이다.
          foldPersistedRef.current = Math.max(foldPersistedRef.current, revision);
        },
        () => {
          // 순서 저장과 같은 규칙 — 낙관 반영을 손으로 되돌리지 않고 서버 진실로 재동기화한다.
          // 미저장 의도를 여기서 함께 접어야 그 재동기화 응답이 자기 검사에 걸리지 않는다.
          foldPersistedRef.current = foldRevisionRef.current;
          setAnnouncement(t("quota.fold.saveError"));
          refresh(false);
        },
      );
    foldSaveRef.current = foldSaveRef.current.then(save, save);
  }, [ctx.api, adoptFolded, t, refresh]);

  /* 드롭 판정은 상태가 아니라 DOM에서 읽는다. 카드가 order 상태를 그대로 그리는 동안은
     둘이 같지만, 드래그 중 도착한 connect 응답이 순서를 바꿔도 화면에 보이던 그대로가
     판정 기준으로 남는다. */
  const endDrag = useCallback((commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    cancelAnimationFrame(drag.raf);
    dragRef.current = null;
    setDraggingId(null);
    const body = bodyRef.current;
    if (!commit || !body || !drag.moved) return;
    const cards = [...body.querySelectorAll<HTMLElement>("[data-provider]")];
    const domOrder = cards.map((card) => card.dataset.provider).filter(isProviderId);
    const rest = cards.filter((card) => card.dataset.provider !== drag.id);
    let index = rest.length;
    for (const [position, card] of rest.entries()) {
      const rect = card.getBoundingClientRect();
      if (drag.pointerY < rect.top + rect.height / 2) {
        index = position;
        break;
      }
    }
    const restIds = rest.map((card) => card.dataset.provider).filter(isProviderId);
    const next = [...restIds.slice(0, index), drag.id, ...restIds.slice(index)];
    if (next.some((id, position) => id !== domOrder[position])) persistOrder(next, drag.id);
  }, [persistOrder]);

  const onBodyPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    // 그립을 누르면 타깃은 대개 내부 <svg>/<circle>(SVGElement)다 — Element로 받아야
    // 보이는 글리프 자체에서 드래그가 시작된다.
    const target = event.target instanceof Element ? event.target : null;
    const grip = target?.closest(".quota-grip");
    const body = bodyRef.current;
    if (!grip || !body || dragRef.current) return;
    // 보조 버튼(우클릭·미들클릭)과 비주 포인터는 드래그가 아니다 — 컨텍스트 메뉴를
    // 여는 동작이 재배열을 저장해 버리면 안 된다.
    if (event.button !== 0 || !event.isPrimary) return;
    const id = grip.closest<HTMLElement>("[data-provider]")?.dataset.provider;
    if (!isProviderId(id)) return;
    event.preventDefault();
    /* moved 전에는 커밋·인디케이터·오토스크롤을 모두 보류한다. 누르는 순간 카드가
       접히며 눌렀던 좌표가 접힌 레이아웃의 몇 행 아래를 가리키게 되므로, 이동 없이
       놓았을 때 그 스테일 좌표를 드롭으로 해석하면 의도 없는 재배열이 저장된다. */
    const drag = { id, pointerY: event.clientY, startY: event.clientY, moved: false, raf: 0 };
    dragRef.current = drag;
    setDraggingId(id);
    const onMove = (moveEvent: PointerEvent) => {
      drag.pointerY = moveEvent.clientY;
      if (!drag.moved && Math.abs(moveEvent.clientY - drag.startY) > 4) drag.moved = true;
    };
    const detach = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onDrop);
      document.removeEventListener("pointercancel", onCancel);
    };
    const onDrop = () => {
      detach();
      endDrag(true);
    };
    const onCancel = () => {
      detach();
      endDrag(false);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onDrop);
    document.addEventListener("pointercancel", onCancel);
    /* 인디케이터는 매 프레임 DOM 좌표로 다시 놓는다. 레이아웃에 참여시키면 삽입 지점이
       흔들릴 때마다 카드가 밀려 판정 자체가 떨리기 때문에 absolute 오버레이로만 그린다. */
    const tick = () => {
      if (dragRef.current !== drag) return;
      if (!drag.moved) {
        const idleLine = dropLineRef.current;
        if (idleLine) idleLine.style.visibility = "hidden";
        drag.raf = requestAnimationFrame(tick);
        return;
      }
      const bodyRect = body.getBoundingClientRect();
      if (drag.pointerY < bodyRect.top + 48) body.scrollTop -= 9;
      else if (drag.pointerY > bodyRect.bottom - 48) body.scrollTop += 9;
      const line = dropLineRef.current;
      if (line) {
        line.style.visibility = "visible";
        const rest = [...body.querySelectorAll<HTMLElement>("[data-provider]")]
          .filter((card) => card.dataset.provider !== drag.id);
        let top: number | null = null;
        for (const card of rest) {
          const rect = card.getBoundingClientRect();
          if (drag.pointerY < rect.top + rect.height / 2) {
            top = card.offsetTop - 8;
            break;
          }
        }
        if (top === null) {
          const last = rest[rest.length - 1];
          top = last ? last.offsetTop + last.offsetHeight + 6 : 0;
        }
        line.style.top = `${top}px`;
      }
      drag.raf = requestAnimationFrame(tick);
    };
    drag.raf = requestAnimationFrame(tick);
  }, [endDrag]);

  const onBodyKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const target = event.target instanceof Element ? event.target : null;
    const id = target?.closest(".quota-grip")?.closest<HTMLElement>("[data-provider]")?.dataset.provider;
    if (!isProviderId(id)) return;
    event.preventDefault();
    const next = movedProviderOrder(order, id, event.key === "ArrowUp" ? -1 : 1);
    if (next) persistOrder(next, id);
  }, [order, persistOrder]);

  useEffect(() => {
    const generation = beginRequestGeneration(requestGenerationRef);
    const foldCapture = { persisted: foldPersistedRef.current, revision: foldRevisionRef.current };
    if (isLatestRequestGeneration(requestGenerationRef, generation)) setRequestError(false);
    const force = forceRef.current;
    forceRef.current = false;
    ctx.api.fetch("quota", force ? "summary?force=1" : "summary")
      .then((response) => {
        if (!response.ok) throw new Error("summary_failed");
        return response.json() as Promise<SummaryResponse>;
      })
      .then((result) => {
        if (isLatestRequestGeneration(requestGenerationRef, generation)) {
          setData(result);
          setOrder(sanitizeProviderOrder(result.providerOrder));
          if (adoptsFoldedProviders(foldCapture, foldRevisionRef.current)) {
            adoptFolded(sanitizeFoldedProviders(result.foldedProviders));
          }
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
    data?.providers.antigravity.fetchedAt ?? 0,
    data?.providers.claude.fetchedAt ?? 0,
    data?.providers.codex.fetchedAt ?? 0,
    data?.providers.cursor.fetchedAt ?? 0,
    data?.providers.kimi.fetchedAt ?? 0,
    data?.providers.opencode.fetchedAt ?? 0,
    data?.providers.xai.fetchedAt ?? 0,
  );
  const updatedMinutes = Math.max(0, Math.floor((now - fetchedAt) / 60_000));
  return (
    <div className="quota-root">
      <div
        className={`quota-body${draggingId !== null ? " quota-body--compact" : ""}`}
        ref={bodyRef}
        onPointerDown={onBodyPointerDown}
        onKeyDown={onBodyKeyDown}
      >
        {requestError ? <div className="quota-error">{t("quota.error.summary")}</div> : null}
        {!data && !requestError ? (
          <div className="quota-state" role="status">
            <span className="quota-state__mark" aria-hidden="true" />
            <strong>{t("quota.loading.title")}</strong>
            <p>{t("quota.loading.body")}</p>
          </div>
        ) : null}
        {data ? order.map((id) => (
          <ProviderCard
            key={id}
            id={id}
            provider={data.providers[id]}
            now={now}
            locale={ctx.language ?? "en"}
            t={t}
            connect={connect}
            dragging={draggingId === id}
            folded={folded.includes(id)}
            toggleFold={toggleFold}
          />
        )) : null}
        {draggingId !== null ? <span className="quota-drop-line" ref={dropLineRef} aria-hidden="true" /> : null}
      </div>
      <footer className="quota-footer">
        <div className="quota-footer__row">
          <span className="quota-live" aria-live="polite">{announcement}</span>
          {fetchedAt > 0 ? <span>{updatedMinutes < 1 ? t("quota.updated.now") : t("quota.updated.ago", { m: updatedMinutes })}</span> : null}
          <BarLegend t={t} />
          <button type="button" className="quota-refresh" onClick={() => refresh(true)}>{t("quota.refresh")}</button>
        </div>
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

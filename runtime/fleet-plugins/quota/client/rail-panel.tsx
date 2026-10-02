import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import { LiveLine } from "@fleet-console/sdk/components/live-line";
import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import type { PaneContext, PaneDescriptor } from "@fleet-console/sdk/pane";
import type { RailEntryDescriptor } from "@fleet-console/sdk/rail";

import type { ProviderDto, ProviderStatus, QuotaSummaryDto, QuotaWindow, ResetCredits } from "@fleet-console/ai-gateway";
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

type T = Translate<QuotaMessageKey>;
/** Providers whose credential read is gated behind an explicit connect. */
type ConnectableProviderId = "claude";

const PROVIDER_NAME: Readonly<Record<ProviderId, string>> = {
  antigravity: "Antigravity",
  claude: "Claude Code",
  codex: "Codex",
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
  "muse-code": "quota.museCode.signedOut",
  opencode: "quota.opencode.signedOut",
  xai: "quota.xai.signedOut",
};

export const EXPIRED_KEY: Readonly<Record<ProviderId, QuotaMessageKey>> = {
  antigravity: "quota.expired.antigravity",
  claude: "quota.expired.claude",
  codex: "quota.expired.codex",
  "muse-code": "quota.expired.museCode",
  opencode: "quota.expired.opencode",
  xai: "quota.expired.xai",
};

// OpenCode만 이 상태에 도달하지만(claude·codex 파서는 반환하지 않는다),
// 프로바이더별 안내를 공용 문구로 대신하면 다른 공급자의 지시를 보여주게 되므로 나머지도 명시한다.
export const NO_SUBSCRIPTION_KEY: Readonly<Record<ProviderId, QuotaMessageKey>> = {
  antigravity: "quota.noSubscription",
  claude: "quota.noSubscription",
  codex: "quota.noSubscription",
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
const UNREPORTED_PROVIDER: ProviderDto = { status: "error" };

function isConnectable(id: ProviderId): id is ConnectableProviderId {
  return id === "claude";
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
 * 순위는 퍼센트가 아니라 게이트웨이의 압력 판정이 먼저다.
 * 회차의 5분의 1 지점에서 44%를 쓴 창은 조용한
 * 60% 창보다 급하고, 퍼센트만 보는 비교로는 그 사실을 볼 수 없다.
 */
export function foldedWindow(windows: readonly QuotaWindow[] | undefined): QuotaWindow | null {
  if (windows === undefined || windows.length === 0) return null;
  return windows.reduce((worst, window) => {
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

/**
 * 구독은 살아 있지만 지금 진행 중인 사용 창이 없다(Muse Code는 이때 사용량을 싣지 않는다).
 * 수치가 없는 성공을 따로 말하지 않으면 아직 읽지 못한 카드와 구분되지 않는다.
 */
function isIdle(id: ProviderId, provider: ProviderDto): boolean {
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

/**
 * 한 창의 트랙 — 채움·예측 빗금·경과 눈금 세 겹. 펼친 미터와 줄의 미니 막대가 같은 부품을
 * 쓴다: 둘이 다른 그림을 그리면 한 공급자가 접힘과 펼침에서 서로 다른 판정을 말하게 된다.
 * 심각도 채널은 감싸는 `.quota-meter--*`가 싣는다.
 */
function MeterTrack({
  window,
  now,
  t,
  label,
  note,
}: {
  readonly window: QuotaWindow;
  readonly now: number;
  readonly t: T;
  /** 있으면 보조기술이 읽는 막대다. 없으면 줄의 장식 — 요약은 줄 버튼의 이름이 말한다. */
  readonly label?: string;
  readonly note?: string | null;
}) {
  const projection = projectedSpan(window, now);
  const elapsedMark = elapsedMarkPercent(window);
  const usedText = t("quota.meter.used", { pct: window.usedPercent });
  const semantics = label === undefined
    ? { "aria-hidden": true as const }
    : {
        role: "progressbar",
        "aria-label": label,
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        "aria-valuenow": window.usedPercent,
        ...(note ? { "aria-valuetext": `${usedText} · ${note}` } : {}),
      };
  return (
    <span className="quota-meter__bar" {...semantics}>
      {projection ? (
        <span
          className="quota-meter__projection"
          title={label === undefined ? undefined : t("quota.meter.projected")}
          style={{ left: `${projection.left}%`, width: `${projection.width}%` }}
        />
      ) : null}
      <span className="quota-meter__fill" style={{ width: `${clampPercent(window.usedPercent)}%` }} />
      {elapsedMark !== null ? (
        <span
          className="quota-meter__elapsed"
          title={label === undefined ? undefined : t("quota.meter.elapsed", { pct: elapsedMark })}
          style={{ left: `${elapsedMark}%` }}
        />
      ) : null}
    </span>
  );
}

/** 응답이 바꾼 숫자를 고르는 열쇠. 줄의 대표 퍼센트와 펼친 미터가 같은 열쇠를 써서 함께 숨 쉰다. */
export function usageKey(id: ProviderId, window: QuotaWindow): string {
  return `${id}:${window.id}:${window.label ?? ""}`;
}

/**
 * 새 응답에서 사용률이 달라진 창. 처음 받는 공급자·창은 고르지 않는다 — 비교할 이전 값이
 * 없으면 "바뀌었다"가 아니라 "처음 보인다"이고, 그것까지 빛나면 첫 화면 전체가 깜박인다.
 */
export function changedUsageKeys(previous: QuotaSummaryDto | null, next: QuotaSummaryDto): ReadonlySet<string> {
  const changed = new Set<string>();
  if (previous === null) return changed;
  for (const [id, provider] of Object.entries(next.providers)) {
    if (!isProviderId(id)) continue;
    const before = new Map((previous.providers[id]?.windows ?? []).map((window) => [usageKey(id, window), window.usedPercent]));
    for (const window of provider?.windows ?? []) {
      const key = usageKey(id, window);
      const was = before.get(key);
      if (was !== undefined && was !== window.usedPercent) changed.add(key);
    }
  }
  return changed;
}

function Meter({
  id,
  window,
  cycleDays,
  now,
  locale,
  t,
  changed,
}: {
  readonly id: ProviderId;
  readonly window: QuotaWindow;
  readonly cycleDays?: number;
  readonly now: number;
  readonly locale: ConsoleLocale;
  readonly t: T;
  readonly changed: ReadonlySet<string>;
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
  const note = riskNote(window, now, t);
  const pulse = changed.has(usageKey(id, window)) ? " quota-changed" : "";
  return (
    <div className={`quota-meter quota-meter--${severity}`}>
      <div className="quota-meter__top">
        <span className="quota-meter__label">{label}</span>
        {windowChip ? <span className="quota-meter__window">{windowChip}</span> : null}
        <span className={`quota-meter__percent${pulse}`}>{window.usedPercent}%</span>
      </div>
      <MeterTrack window={window} now={now} t={t} label={label} note={note} />
      {note !== null || window.resetsAt !== undefined ? (
        <div className="quota-meter__foot">
          {note !== null ? <span className="quota-meter__forecast">{note}</span> : null}
          {window.resetsAt !== undefined ? (
            <span className="quota-meter__reset">{resetCaption(window.resetsAt, now, locale, t)}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 펼친 상세의 상태 한 줄. 신호는 6px 점 하나가 지고 문장은 본문 잉크로 남는다 — 틴트 면과
 * 좌측 띠를 함께 쓰던 스트립은 목록의 한 행 안에 상자를 하나 더 세웠다.
 */
function StatusLine({ tone, children }: { readonly tone: "quiet" | "warn" | "error"; readonly children: React.ReactNode }) {
  return <p className={`quota-status quota-status--${tone}`}>{children}</p>;
}

function ProviderStatusLines({ id, provider, name, now, t }: {
  readonly id: ProviderId;
  readonly provider: ProviderDto;
  readonly name: string;
  readonly now: number;
  readonly t: T;
}) {
  switch (provider.status) {
    case "signed_out":
      return <StatusLine tone="quiet">{t(SIGNED_OUT_KEY[id])}</StatusLine>;
    case "no_subscription":
      return <StatusLine tone="quiet">{t(NO_SUBSCRIPTION_KEY[id])}</StatusLine>;
    case "expired":
      return <StatusLine tone="error">{t(EXPIRED_KEY[id])}</StatusLine>;
    case "stale": {
      // 이전 값을 보여 주더라도 사용자가 고칠 수 있는 원인(키체인 권한 등)은 가리지 않는다.
      const credentialKey = credentialUnavailableKey(provider.message);
      return (
        <>
          <StatusLine tone="warn">{t("quota.stale", { provider: name, t: elapsed(provider.fetchedAt, now) })}</StatusLine>
          {credentialKey ? <StatusLine tone="error">{t(credentialKey, { provider: name })}</StatusLine> : null}
        </>
      );
    }
    case "error": {
      const match = provider.message?.match(/^Certificate verification failed \(([A-Za-z0-9_]+)\)$/);
      if (match?.[1] !== undefined) {
        return <StatusLine tone="error">{t("quota.error.tls", { provider: name, code: match[1] })}</StatusLine>;
      }
      // 로그인이 없는 것과 저장소를 읽지 못한 것은 다른 조치를 부른다 — 로그인하라고 하면 틀린 지시가 된다.
      const credentialKey = credentialUnavailableKey(provider.message);
      return <StatusLine tone="error">{t(credentialKey ?? "quota.error", { provider: name })}</StatusLine>;
    }
    default:
      return isIdle(id, provider) ? <StatusLine tone="quiet">{t("quota.museCode.idle")}</StatusLine> : null;
  }
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

/** 줄의 미니 막대가 대변할 창 — 가장 급한 셋을 원래 순서대로. 열한 창을 모두 세우면 막대가 선이 된다. */
export function lineWindows(windows: readonly QuotaWindow[] | undefined, limit = 3): readonly QuotaWindow[] {
  if (windows === undefined || windows.length <= limit) return windows ?? [];
  const ranked = [...windows].sort((a, b) =>
    (SEVERITY_RANK[meterSeverity(b)] - SEVERITY_RANK[meterSeverity(a)]) || (b.usedPercent - a.usedPercent));
  const kept = new Set(ranked.slice(0, limit));
  return windows.filter((window) => kept.has(window));
}

/**
 * 줄의 요약 — 창별 미니 막대와 가장 급한 창의 퍼센트. 접기가 "치워두기"가 아니라
 * "밀도 바꾸기"가 되는 지점이다: 쿼터는 이 패널 밖에 신호가 없어, 접힌 줄이 그 공급자의
 * 유일한 통로다. 읽을 수치가 없으면 "여기에는 볼 것이 없다"는 한 마디를 남긴다.
 */
function LineSummary({
  id,
  provider,
  summary,
  now,
  t,
  changed,
}: {
  readonly id: ProviderId;
  readonly provider: ProviderDto;
  readonly summary: QuotaWindow | null;
  readonly now: number;
  readonly t: T;
  readonly changed: ReadonlySet<string>;
}) {
  if (summary === null) {
    const statusKey = isIdle(id, provider) ? "quota.fold.idle" : FOLDED_STATUS_KEY[provider.status];
    return statusKey === undefined ? null : <span className="quota-fold__quiet">{t(statusKey)}</span>;
  }
  const severity = meterSeverity(summary);
  const pulse = changed.has(usageKey(id, summary)) ? " quota-changed" : "";
  return (
    <>
      <span className="quota-fold__twin" aria-hidden="true">
        {lineWindows(provider.windows).map((window, index) => (
          <span key={`${window.id}-${window.label ?? index}`} className={`quota-meter quota-meter--${meterSeverity(window)}`}>
            <MeterTrack window={window} now={now} t={t} />
          </span>
        ))}
      </span>
      <span className={`quota-fold__percent quota-fold__percent--${severity}${pulse}`}>{summary.usedPercent}%</span>
    </>
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

function ChevronGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 3.5 L5 7 L8.5 3.5" />
    </svg>
  );
}

/**
 * 공급자 한 줄. 줄 전체가 펼침 버튼이고 그립은 그 형제다 — 버튼은 버튼을 품지 못하므로,
 * 재배열·연결 해제 같은 다른 조작은 이 버튼 바깥(그립은 앞, 나머지는 상세 안)에 산다.
 * 버튼을 제목이 감싸는 것은 아코디언 문법이다: 제목 탐색으로 공급자를 건너다닐 수 있다.
 */
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
  changed,
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
  readonly changed: ReadonlySet<string>;
}) {
  const name = PROVIDER_NAME[id];
  const regionId = `quota-card-${id}`;
  const readable = provider.status === "ok" || provider.status === "stale";
  const summary = readable ? foldedWindow(provider.windows) : null;
  // 위험한 공급자는 이름 잉크가 그 판정을 입는다. 일곱 줄을 훑을 때 한 줄만 읽게 만드는 것은
  // 퍼센트가 아니라 이 이름이다. 접힘과 무관하게 같은 줄이므로 판정도 같다.
  const alarm = summary !== null && meterSeverity(summary) === "critical";
  const staleTag = provider.status === "stale" ? t("quota.row.staleTag", { t: elapsed(provider.fetchedAt, now) }) : null;
  const summaryText = summary !== null
    ? summary.resetsAt === undefined
      ? t("quota.meter.used", { pct: summary.usedPercent })
      : t("quota.fold.summary", { pct: summary.usedPercent, t: formatCountdown(summary.resetsAt, now) })
    : (() => {
        const statusKey = isIdle(id, provider) ? "quota.fold.idle" : FOLDED_STATUS_KEY[provider.status];
        return statusKey === undefined ? null : t(statusKey);
      })();
  const modifiers = `${dragging ? " quota-card--dragging" : ""}${folded ? " quota-card--folded" : ""}${alarm ? " quota-card--alarm" : ""}`;
  const credits = readable ? visibleCredits(provider.credits) : null;
  return (
    <section className={`quota-provider${modifiers}`} data-provider={id}>
      <header className="quota-provider__header">
        <GripButton name={name} t={t} />
        <h3 className="quota-provider__title">
          <button
            type="button"
            className="quota-fold"
            aria-expanded={!folded}
            aria-controls={regionId}
            aria-label={[name, staleTag, summaryText].filter((part) => part !== null).join(", ")}
            onClick={() => toggleFold(id)}
          >
            <span className={`quota-provider__mark quota-provider__mark--${id}`}>{providerGlyph(id)}</span>
            <span className="quota-fold__name">
              <span className="quota-fold__label">{name}</span>
              {staleTag !== null ? <span className="quota-fold__stale">{staleTag}</span> : null}
            </span>
            <LineSummary id={id} provider={provider} summary={summary} now={now} t={t} changed={changed} />
            <span className="quota-fold__chev"><ChevronGlyph /></span>
          </button>
        </h3>
      </header>
      <div className="quota-card__collapse" id={regionId}>
        <div className="quota-card__rest">
          <div className="quota-detail">
            {provider.plan ? <p className="quota-plan" title={provider.plan}>{displayPlanName(id, provider.plan)}</p> : null}
            {isConnectable(id) && provider.status === "not_connected" ? (
              <div className="quota-connect">
                <p>{t("quota.connect.body")}</p>
                {provider.method === "keychain" ? <p className="quota-connect__hint">{t("quota.connect.keychain")}</p> : null}
                <button type="button" className="quota-button quota-button--primary" onClick={() => connect(id, true)}>{t("quota.connect.action")}</button>
              </div>
            ) : (
              <>
                <ProviderStatusLines id={id} provider={provider} name={name} now={now} t={t} />
                {readable && provider.windows?.length ? (
                  <div className="quota-meters">
                    {provider.windows.map((window, index) => (
                      <Meter key={`${window.id}-${window.label ?? index}`} id={id} window={window} cycleDays={provider.cycleDays} now={now} locale={locale} t={t} changed={changed} />
                    ))}
                  </div>
                ) : null}
                {credits ? (
                  <p className="quota-credits">
                    <ResetGlyph />
                    <span>{t("quota.credits", { n: credits.available })}</span>
                    {credits.nextExpiresAt !== undefined ? <span className="quota-credits__expiry">{t("quota.credits.expiry", { t: formatCountdown(credits.nextExpiresAt, now) })}</span> : null}
                  </p>
                ) : null}
                {isConnectable(id) ? (
                  <div className="quota-detail__actions">
                    <button type="button" className="quota-disconnect" onClick={() => connect(id, false)}>{t("quota.disconnect.action")}</button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
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

/**
 * summary 계열 응답은 코어 DTO에 플러그인 소유의 패널 설정을 얹어 온다. `revalidating`은
 * `stale=1` 요청이 만료된 캐시를 먼저 받았고 Gateway가 뒤에서 다시 읽는 중이라는 뜻이다.
 */
type SummaryResponse = QuotaSummaryDto & {
  readonly providerOrder?: unknown;
  readonly foldedProviders?: unknown;
  readonly revalidating?: boolean;
};

interface RememberedPanel {
  readonly data: QuotaSummaryDto;
  readonly order: readonly ProviderId[];
  readonly folded: readonly ProviderId[];
}

/* 레일을 닫으면 패널은 언마운트된다(keepAlive 없음). 다시 열 때 이미 읽은 요약을 두고
   "불러오는 중"부터 보이지 않도록, 마지막으로 그린 것을 이 번들 안에 남겨 첫 렌더에 쓴다.
   마운트가 곧바로 새 요청을 보내 도착하면 갈아 끼우고, 오래된 정도는 푸터의 "갱신 N분 전"이
   말한다. 순서·접힘도 함께 남겨야 도착 순간 카드가 기본 순서에서 제자리로 뛰지 않는다.
   preferences(localStorage)가 아닌 이유: 새로고침을 넘어 며칠 전 수치를 되살릴 이유가 없고,
   폴링마다 쓰기를 남길 설정 채널도 아니다. */
let rememberedPanel: RememberedPanel | null = null;

const NO_CHANGES: ReadonlySet<string> = new Set();

/* "갱신 중"을 세우기 전의 유예. 캐시가 살아 있는 폴링은 수 ms에 끝나는데, 그때마다 링이
   켜졌다 꺼지면 1분마다 푸터가 깜박인다 — 기다림이 실제로 보일 만큼일 때만 말한다. */
const REFRESHING_GRACE_MS = 300;

function QuotaPanel({ ctx }: { readonly ctx: PaneContext }) {
  const t = useMemo(() => getT(ctx.language), [ctx.language]);
  const [restored] = useState(() => rememberedPanel);
  const [data, setData] = useState<QuotaSummaryDto | null>(restored?.data ?? null);
  const [requestError, setRequestError] = useState(false);
  /** 최신 요청이 아직 답하지 않았다. 만료 캐시를 받은 뒤의 후속 요청도 여기에 든다. */
  const [requestPending, setRequestPending] = useState(false);
  const [refreshingShown, setRefreshingShown] = useState(false);
  /** 마지막 응답이 바꾼 사용률. 그 숫자만 한 번 숨 쉬고 비워진다. */
  const [changed, setChanged] = useState<ReadonlySet<string>>(NO_CHANGES);
  /** 화면에 선 요약 — 바뀐 숫자를 고르는 비교 기준. 상태는 콜백 클로저에서 낡는다. */
  const shownRef = useRef<QuotaSummaryDto | null>(restored?.data ?? null);
  const [now, setNow] = useState(Date.now());
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [order, setOrder] = useState<readonly ProviderId[]>(restored?.order ?? PROVIDER_ORDER_DEFAULT);
  const [folded, setFolded] = useState<readonly ProviderId[]>(restored?.folded ?? []);
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
  const foldedRef = useRef<readonly ProviderId[]>(restored?.folded ?? []);
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

  // summary와 connect의 응답이 같은 문으로 들어온다.
  const adoptSummary = useCallback((
    result: SummaryResponse,
    foldCapture: { readonly revision: number; readonly persisted: number },
  ) => {
    const changedKeys = changedUsageKeys(shownRef.current, result);
    shownRef.current = result;
    setData(result);
    setOrder(sanitizeProviderOrder(result.providerOrder));
    if (adoptsFoldedProviders(foldCapture, foldRevisionRef.current)) {
      adoptFolded(sanitizeFoldedProviders(result.foldedProviders));
    }
    setRequestError(false);
    setNow(Date.now());
    if (changedKeys.size > 0) setChanged(changedKeys);
  }, [adoptFolded]);

  const refresh = useCallback((forceRequest = false) => {
    forceRef.current = forceRequest;
    setRefreshNonce((value) => value + 1);
  }, []);

  const connect = useCallback((provider: ConnectableProviderId, connected: boolean) => {
    const generation = beginRequestGeneration(requestGenerationRef);
    const foldCapture = { persisted: foldPersistedRef.current, revision: foldRevisionRef.current };
    if (isLatestRequestGeneration(requestGenerationRef, generation)) setRequestError(false);
    setRequestPending(true);
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
          adoptSummary(result, foldCapture);
          setRequestPending(false);
        }
      })
      .catch(() => {
        if (isLatestRequestGeneration(requestGenerationRef, generation)) {
          setRequestError(true);
          setRequestPending(false);
        }
      });
  }, [ctx.api, adoptSummary]);

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
    setRequestPending(true);
    // 그릴 것이 하나도 없을 때만 만료된 캐시라도 먼저 받는다. 이미 그린 화면이 있으면
    // 기다림이 보이지 않으므로 평소대로 새 값을 기다린다.
    const path = force ? "summary?force=1" : data === null ? "summary?stale=1" : "summary";
    ctx.api.fetch("quota", path)
      .then((response) => {
        if (!response.ok) throw new Error("summary_failed");
        return response.json() as Promise<SummaryResponse>;
      })
      .then((result) => {
        if (isLatestRequestGeneration(requestGenerationRef, generation)) {
          adoptSummary(result, foldCapture);
          // 뒤에서 도는 갱신에 일반 요청으로 합류한다 — Gateway가 single-flight로 묶어 upstream을
          // 다시 부르지 않고, 그 갱신이 끝나는 순간 답이 온다. 그동안 갱신 중 상태를 끊지 않는다.
          setRequestPending(result.revalidating === true);
          if (result.revalidating === true) refresh(false);
        }
      })
      .catch(() => {
        if (isLatestRequestGeneration(requestGenerationRef, generation)) {
          setRequestError(true);
          setRequestPending(false);
        }
      });
    return () => {
      if (isLatestRequestGeneration(requestGenerationRef, generation)) {
        beginRequestGeneration(requestGenerationRef);
      }
    };
  }, [ctx.api, adoptSummary, refresh, refreshNonce]);

  useEffect(() => () => {
    beginRequestGeneration(requestGenerationRef);
  }, []);

  // 응답 채택과 낙관 반영(순서 이동·접기)을 가리지 않고 화면에 선 그대로를 남긴다.
  useEffect(() => {
    if (data !== null) rememberedPanel = { data, order, folded };
  }, [data, order, folded]);

  useEffect(() => {
    if (changed.size === 0) return;
    const timer = setTimeout(() => setChanged(NO_CHANGES), 1_000);
    return () => clearTimeout(timer);
  }, [changed]);

  /* 보이는 값이 있고 그보다 새 값을 기다리는 중이다. 아무것도 없을 때의 기다림은 로딩 상태가
     말하므로 여기 들지 않는다. */
  const refreshing = requestPending && data !== null;
  useEffect(() => {
    if (!refreshing) {
      setRefreshingShown(false);
      return;
    }
    const timer = setTimeout(() => setRefreshingShown(true), REFRESHING_GRACE_MS);
    return () => clearTimeout(timer);
  }, [refreshing]);

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
    data?.providers["muse-code"]?.fetchedAt ?? 0,
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
            provider={data.providers[id] ?? UNREPORTED_PROVIDER}
            now={now}
            locale={ctx.language ?? "en"}
            t={t}
            connect={connect}
            dragging={draggingId === id}
            folded={folded.includes(id)}
            toggleFold={toggleFold}
            changed={changed}
          />
        )) : null}
        {draggingId !== null ? <span className="quota-drop-line" ref={dropLineRef} aria-hidden="true" /> : null}
      </div>
      <footer className="quota-footer">
        <div className="quota-footer__row">
          <span className="quota-live" aria-live="polite">{announcement}</span>
          {/* 기다리는 동안에도 지금 보이는 값의 나이는 말한다 — 링만 돌면 이 화면이 몇 분 전 것인지 모른다. */}
          {refreshingShown ? (
            <LiveLine
              className="quota-footer__live"
              label={t("quota.refreshing")}
              {...(fetchedAt > 0 && updatedMinutes >= 1 ? { meta: t("quota.refreshing.age", { m: updatedMinutes }) } : {})}
            />
          ) : fetchedAt > 0 ? (
            <span className="quota-footer__stamp">{updatedMinutes < 1 ? t("quota.updated.now") : t("quota.updated.ago", { m: updatedMinutes })}</span>
          ) : null}
          <BarLegend t={t} />
          <button
            type="button"
            className="quota-refresh"
            disabled={refreshingShown || (data === null && requestPending)}
            onClick={() => refresh(true)}
          >
            {t("quota.refresh")}
          </button>
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

export const quotaEntry: RailEntryDescriptor = {
  id: "quota",
  title: (locale) => getT(locale)("quota.panel.title"),
  icon: QuotaIcon,
  panes: ["quota"],
  scope: "fleet",
};

/**
 * 계기판 한 열. 카드 순서와 접힘은 서버에 남으므로 닫혀도 잃을 것이 없다.
 * 닫았다 다시 열 때의 첫 화면은 `rememberedPanel`이 채운다.
 */
export const quotaPane: PaneDescriptor = {
  id: "quota",
  role: "primary",
  mounts: ["rail"],
  title: (ctx) => getT(ctx.language ?? "en")("quota.panel.title"),
  render: (ctx) => <QuotaPanel ctx={ctx} />,
  defaultWidth: 392,
};

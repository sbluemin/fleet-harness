import type { ConsoleLocale, Translate } from "@fleet-console/i18n";

import type { ProviderRateLimit, ProviderRateLimitWindow } from "@fleet-console/ai-gateway";
import type { QuotaMessageKey } from "./i18n/index.js";

type T = Translate<QuotaMessageKey>;

/**
 * 마지막 상류 응답의 `anthropic-ratelimit-*` 헤더가 알려 준 세 갈래. 창(`QuotaWindow`)이 아니라
 * API 키의 분당 한도라서 라우팅 압박도 계산에 쓰이지 않고, 그래서 미터 대신 표로 그린다.
 * 없는 묶음은 그리지 않는다 — 헤더가 일부만 와도 있는 것만 말한다.
 */
const WINDOWS = [
  { key: "requests", label: "quota.anthropic.rateLimit.requests" },
  { key: "inputTokens", label: "quota.anthropic.rateLimit.inputTokens" },
  { key: "outputTokens", label: "quota.anthropic.rateLimit.outputTokens" },
] as const satisfies readonly { readonly key: "requests" | "inputTokens" | "outputTokens"; readonly label: QuotaMessageKey }[];

type RateLimitWindowKey = typeof WINDOWS[number]["key"];

interface RateLimitRow {
  readonly key: RateLimitWindowKey;
  readonly label: QuotaMessageKey;
  readonly window: ProviderRateLimitWindow;
}

function windowsOf(rateLimit: ProviderRateLimit): readonly RateLimitRow[] {
  const rows: RateLimitRow[] = [];
  for (const entry of WINDOWS) {
    const window = rateLimit[entry.key];
    if (window !== undefined) rows.push({ key: entry.key, label: entry.label, window });
  }
  return rows;
}

function formatCount(locale: ConsoleLocale, value: number): string {
  return new Intl.NumberFormat(locale === "ko" ? "ko-KR" : "en-US", { maximumFractionDigits: 0 }).format(value);
}

/**
 * 리셋까지의 남은 시간. 이 한도는 분 단위로 돌아오므로 기존 `formatCountdown`(분 미만을 "0m"으로
 * 접는다) 대신 초를 남긴다 — "0m"은 곧 초기화된다는 사실을 지운다.
 */
export function formatShortCountdown(target: number, now: number): string {
  const delta = Math.max(0, target - now);
  const seconds = Math.ceil(delta / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** 헤더를 읽은 지 얼마나 지났는지 — 값이 마지막 응답의 사실임을 말한다. */
function observedText(locale: ConsoleLocale, observedAt: number, now: number): string {
  const delta = Math.max(0, now - observedAt);
  if (delta < 60_000) return locale === "ko" ? "방금" : "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return locale === "ko" ? `${minutes}분 전` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return locale === "ko" ? `${hours}시간 전` : `${hours}h ago`;
}

export interface RateLimitProps {
  readonly rateLimit: ProviderRateLimit;
  readonly now: number;
  readonly locale: ConsoleLocale;
  readonly t: T;
}

function windowSummary(locale: ConsoleLocale, window: ProviderRateLimitWindow, now: number, t: T): string {
  // `resetsAt`은 한도가 다 채워지는 시각이다. 지난 뒤의 잔량은 낡은 값이라 한도 전체로 말한다.
  if (window.resetsAt <= now) {
    const limit = formatCount(locale, window.limit);
    return t("quota.anthropic.rateLimit.left", { remaining: limit, limit });
  }
  return `${t("quota.anthropic.rateLimit.left", {
    remaining: formatCount(locale, window.remaining),
    limit: formatCount(locale, window.limit),
  })} · ${t("quota.anthropic.rateLimit.resets", { t: formatShortCountdown(window.resetsAt, now) })}`;
}

/** 데스크톱 카드의 API 키 한도 구역 — 요청·입력 토큰·출력 토큰의 한도/남은 양/초기화 시각. */
export function RateLimitSection(props: RateLimitProps) {
  const { rateLimit, now, locale, t } = props;
  const rows = windowsOf(rateLimit);
  if (rows.length === 0) return null;
  return (
    <div className="quota-ratelimit">
      <div className="quota-ratelimit__head">
        <span className="quota-ratelimit__label">{t("quota.anthropic.rateLimit.title")}</span>
        <small className="quota-ratelimit__observed">
          {t("quota.anthropic.rateLimit.observed", { t: observedText(locale, rateLimit.observedAt, now) })}
        </small>
      </div>
      <dl className="quota-ratelimit__rows">
        {rows.map((row) => (
          <div className="quota-ratelimit__row" key={row.key}>
            <dt className="quota-ratelimit__name">{t(row.label)}</dt>
            <dd className="quota-ratelimit__value">{windowSummary(locale, row.window, now, t)}</dd>
          </div>
        ))}
      </dl>
      <p className="quota-ratelimit__note">{t("quota.anthropic.rateLimit.note")}</p>
    </div>
  );
}

/** 폰의 행 문법 — 같은 값·같은 출처를 묶음 카드의 행으로 그린다. */
export function RateLimitRows(props: RateLimitProps) {
  const { rateLimit, now, locale, t } = props;
  const rows = windowsOf(rateLimit);
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map((row) => (
        <div className="quota-m-row" key={row.key}>
          <span className="quota-m-copy">
            {t(row.label)}
            <small>{windowSummary(locale, row.window, now, t)}</small>
          </span>
        </div>
      ))}
      <div className="quota-m-row">
        <span className="quota-m-copy">
          <small>{t("quota.anthropic.rateLimit.observed", { t: observedText(locale, rateLimit.observedAt, now) })}</small>
        </span>
      </div>
    </>
  );
}

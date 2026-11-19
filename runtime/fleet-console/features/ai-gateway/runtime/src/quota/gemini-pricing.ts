/**
 * Gemini 4 단가표와 지출 계산. 이 파일이 플릿이 아는 단가의 원본이다.
 *
 * 출처: https://ai.google.dev/gemini-api/docs/pricing — **2026-11-18 확인, 2026-11-19 Neon 추가 재확인**.
 * 아래 표의 모든 값은 그 문서의 Paid tier 표(USD / 1M tokens)에서 읽었다. 문서는 API가
 * 단가를 주지 않으므로 플릿이 직접 싣는다. thinking 토큰은 "Output price (including thinking
 * tokens)"라 출력 단가로 센다. 네 모델 모두 프롬프트 길이 구간별 단가가 없다(표에 구간 행 없음).
 *
 * 값의 단위는 **토큰당 pico-USD** 정수다(= USD/1M 단가 × 1e6). 예: $2.00 / 1M tokens
 * → 2_000_000 pico-USD/token. 지출은 이 정수로만 누적하고, 저장·표시 경계에서 십진 문자열로
 * 바꾼다 — 부동소수 누적은 센트 아래에서 조용히 틀어진다.
 *
 * Argon·Carbon은 "through November 30, 2026 / starting December 1, 2026"으로 2026-12-01부터
 * 정확히 2배가 된다. 전환 시각의 시간대는 문서에 없어 **America/Los_Angeles 자정**을 쓴다 —
 * 주 경계(`spendWeekBounds`)와 같은 시간대이고, Google이 유일하게 시간대를 명시한 리셋 기준
 * (rate-limits의 RPD "midnight Pacific time")과도 같다.
 *
 * Contributor(초대제 private preview) 단가는 초대받은 계정에만 적용되어 플릿이 티어를 알 수
 * 없으므로 표에 넣지 않는다(Neon은 Contributor 표가 없다). Hydrogen은 Free tier가 있지만
 * 무료 프로젝트인지 알 수 없어 Paid 단가로 센다 — 플릿 측정값은 Paid 단가 기준 추정임을
 * DTO의 `basis`가 밝힌다(Argon·Carbon·Neon은 Free tier 미제공).
 */

import type { GeminiModelId } from "../upstream/gemini/coordinates.js";

import type { GeminiUsageObservation } from "./gemini-usage.js";

export const GEMINI_PRICING_SOURCE = {
  /** 위 주석의 공식 가격 문서. 표의 모든 값의 출처다. */
  url: "https://ai.google.dev/gemini-api/docs/pricing",
  /** 표를 직접 읽어 확인한 날짜. */
  checkedAt: "2026-11-19",
} as const;

export const GEMINI_PRICING_TIME_ZONE = "America/Los_Angeles";

/** 서비스 티어. `batch`는 `flex`와 같은 단가라 함께 묶는다(출처 표의 "Batch / Flex" 행). */
export type GeminiPriceTier = "standard" | "flex" | "priority";

/** 한 토큰의 단가(pico-USD). */
export interface GeminiTokenPrice {
  /** 캐시에 걸리지 않은 입력 토큰. */
  readonly input: bigint;
  /** 출력 토큰 — candidates + thoughts. */
  readonly output: bigint;
  /** 프롬프트 캐시 적중 토큰(context caching). */
  readonly cached: bigint;
}

const PICO_USD_SCALE = 10n ** 12n;
const MAX_BUDGET_PICO_USD = 10n ** 21n; // $1,000,000,000 — 입력 상한(사람이 넣는 주 예산)

/**
 * serviceTier 원문 → 단가 tier. 없거나 모르는 값은 standard로 센다(가장 흔한 경로이고,
 * 실측 2026-11-18의 serviceTier도 "standard"였다). 이 관용은 주석으로만 밝히고 보고하지 않는다.
 */
export function geminiPriceTier(serviceTier: string | undefined): GeminiPriceTier {
  const tier = serviceTier?.trim().toLowerCase();
  if (tier === "flex" || tier === "batch") return "flex";
  if (tier === "priority") return "priority";
  return "standard";
}

interface GeminiPriceSchedule {
  readonly throughNovember2026: GeminiTokenPrice;
  readonly fromDecember2026: GeminiTokenPrice;
}

const doubled = (price: GeminiTokenPrice): GeminiTokenPrice => ({
  input: price.input * 2n,
  output: price.output * 2n,
  cached: price.cached * 2n,
});

/** Argon·Carbon은 같은 표를 쓴다(Standard·Flex·Priority 세 행이 두 모델에 동일하다). */
const ARGON_CARBON_PRICES: Readonly<Record<GeminiPriceTier, GeminiPriceSchedule>> = {
  standard: {
    throughNovember2026: { input: 2_000_000n, output: 10_000_000n, cached: 100_000n },
    fromDecember2026: { input: 4_000_000n, output: 20_000_000n, cached: 200_000n },
  },
  flex: {
    throughNovember2026: { input: 1_000_000n, output: 5_000_000n, cached: 50_000n },
    fromDecember2026: { input: 2_000_000n, output: 10_000_000n, cached: 100_000n },
  },
  priority: {
    throughNovember2026: { input: 3_600_000n, output: 18_000_000n, cached: 180_000n },
    fromDecember2026: { input: 7_200_000n, output: 36_000_000n, cached: 360_000n },
  },
};

/** Hydrogen은 날짜별 변동이 없다. */
const HYDROGEN_PRICES: Readonly<Record<GeminiPriceTier, GeminiTokenPrice>> = {
  standard: { input: 1_500_000n, output: 7_500_000n, cached: 75_000n },
  flex: { input: 750_000n, output: 3_750_000n, cached: 37_500n },
  priority: { input: 2_700_000n, output: 13_500_000n, cached: 135_000n },
};

/** Neon도 날짜별 변동이 없다(2026-11-19 공식 가격 문서 확인). */
const NEON_PRICES: Readonly<Record<GeminiPriceTier, GeminiTokenPrice>> = {
  standard: { input: 3_000_000n, output: 15_000_000n, cached: 150_000n },
  flex: { input: 1_500_000n, output: 7_500_000n, cached: 75_000n },
  priority: { input: 5_400_000n, output: 27_000_000n, cached: 270_000n },
};

/**
 * (model, serviceTier, 요청 시각)으로 고른 단가. 전환일 시각은 태평양시 2026-12-01 00:00이다.
 * Argon·Carbon만 날짜에 따라 오르고, Hydrogen·Neon은 표에 기간이 없어 고정이다.
 */
export function geminiTokenPrice(model: GeminiModelId, serviceTier: string | undefined, at: number): GeminiTokenPrice {
  const tier = geminiPriceTier(serviceTier);
  switch (model) {
    case "gemini-4-hydrogen":
      return HYDROGEN_PRICES[tier];
    case "gemini-4-neon":
      return NEON_PRICES[tier];
    case "gemini-4-argon":
    case "gemini-4-carbon": {
      const schedule = ARGON_CARBON_PRICES[tier];
      return at >= GEMINI_PRICE_DOUBLING_AT ? schedule.fromDecember2026 : schedule.throughNovember2026;
    }
  }
}

/**
 * 한 턴의 지출(pico-USD).
 *
 * - 출력 = `candidatesTokens + thoughtsTokens` (thinking은 출력 단가).
 * - 입력 = `(promptTokens − cachedTokens) × input` + `cachedTokens × cached`
 *   (`cachedContentTokenCount`는 promptTokens의 부분집합이다).
 */
export function geminiTurnCostPicoUsd(observation: GeminiUsageObservation, at: number): bigint {
  const price = geminiTokenPrice(observation.model, observation.serviceTier, at);
  const prompt = tokenCount(observation.promptTokens);
  const cached = Math.min(tokenCount(observation.cachedTokens), prompt);
  const output = tokenCount(observation.candidatesTokens) + tokenCount(observation.thoughtsTokens);
  return BigInt(prompt - cached) * price.input
    + BigInt(cached) * price.cached
    + BigInt(output) * price.output;
}

/** 음수·NaN·소수는 0으로 접는다. 게이트웨이가 이상한 수를 실어도 원장이 음수 지출을 만들지 않게. */
function tokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** pico-USD 정수 → USD 십진 문자열. 후행 0은 지우되 정수부는 그대로 둔다("20", "0.0000035"). */
export function usdFromPicoUsd(pico: bigint): string {
  const negative = pico < 0n;
  const absolute = negative ? -pico : pico;
  const whole = absolute / PICO_USD_SCALE;
  const fraction = (absolute % PICO_USD_SCALE).toString().padStart(12, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction.length > 0 ? `.${fraction}` : ""}`;
}

/** USD 십진 문자열 → pico-USD 정수. 최대 12자리 소수. 형식이 다르면 undefined. */
export function picoUsdFromUsd(value: string): bigint | undefined {
  const match = /^(\d{1,15})(?:\.(\d{1,12}))?$/.exec(value.trim());
  if (!match) return undefined;
  const whole = BigInt(match[1] ?? "0");
  const fraction = (match[2] ?? "").padEnd(12, "0");
  return whole * PICO_USD_SCALE + BigInt(fraction.length > 0 ? fraction : "0");
}

/**
 * 사람이 넣은 주 예산 → 저장 형식(USD 십진 문자열). 0 이하·숫자 아님·상한 초과는 undefined다.
 * 예산은 주마다 반복되는 하나의 값이라 주 키와 함께 저장하지 않는다.
 */
export function normalizeBudgetUsd(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const pico = picoUsdFromUsd(String(value).trim().replace(/^\$/, ""));
  if (pico === undefined || pico <= 0n || pico > MAX_BUDGET_PICO_USD) return undefined;
  return usdFromPicoUsd(pico);
}

/** `spent / budget` 백분율(소수 한 자리). 예산이 0이면 0으로 나누지 않는다. */
export function budgetUsedPercent(spentPicoUsd: bigint, budgetPicoUsd: bigint): number | undefined {
  if (budgetPicoUsd <= 0n) return undefined;
  // 반올림 나눗셈 — 부동소수를 거치지 않는다.
  const tenths = (spentPicoUsd * 1_000n + budgetPicoUsd / 2n) / budgetPicoUsd;
  return Number(tenths) / 10;
}

/**
 * America/Los_Angeles 기준 주 경계 — 월요일 00:00에 시작해 다음 월요일 00:00에 리셋한다.
 *
 * 사람 결정(A1): 주 경계는 월요일 00:00 America/Los_Angeles이며, 기존 월 경계와 같은 시간대다.
 * 키는 그 주 월요일의 달력 날짜("2026-11-16")라 달 키("2026-11")와 구별되고, 사전순이 곧 시간순이다.
 * 로케일별 주 시작 요일(Intl의 firstDay)은 쓰지 않는다 — 이 값은 표시 형식이 아니라 제품 계약이다.
 */
export function spendWeekBounds(at: number): { readonly key: string; readonly periodStart: number; readonly resetsAt: number } {
  const parts = LA_DATE_FORMAT.formatToParts(new Date(at));
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  // 태평양시 달력 날짜의 요일은 그 날짜를 UTC 자정으로 세운 순간의 요일과 같다.
  const localDay = Date.UTC(year, month - 1, day);
  const sinceMonday = (new Date(localDay).getUTCDay() + 6) % 7;
  const monday = new Date(localDay - sinceMonday * DAY_MS);
  const nextMonday = new Date(localDay + (7 - sinceMonday) * DAY_MS);
  const startYear = monday.getUTCFullYear();
  const startMonth = monday.getUTCMonth() + 1;
  const startDay = monday.getUTCDate();
  const nextYear = nextMonday.getUTCFullYear();
  const nextMonth = nextMonday.getUTCMonth() + 1;
  const nextDay = nextMonday.getUTCDate();
  return {
    key: `${startYear}-${twoDigits(startMonth)}-${twoDigits(startDay)}`,
    periodStart: zonedMidnightEpoch(startYear, startMonth - 1, startDay),
    resetsAt: zonedMidnightEpoch(nextYear, nextMonth - 1, nextDay),
  };
}

const DAY_MS = 86_400_000;

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** 태평양시 2026-12-01 00:00 — Argon·Carbon 단가가 2배가 되는 순간. */
const GEMINI_PRICE_DOUBLING_AT = zonedMidnightEpoch(2026, 11);

const LA_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: GEMINI_PRICING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * 태평양시 달력 날짜(기본 1일)의 자정 epoch ms. UTC 벽시계로 자정을 잡은 뒤 그 순간의 오프셋만큼
 * 밀고, 오프셋이 바뀔 수 있는 경계를 대비해 한 번 더 수렴시킨다(DST 전환은 3월·11월의 일요일이라
 * 대개 월요일 경계와 겹치지 않지만, 계산이 그 사실에 기대지 않게 한다).
 */
function zonedMidnightEpoch(year: number, monthIndex: number, day = 1): number {
  const utcMidnight = Date.UTC(year, monthIndex, day);
  let instant = utcMidnight;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    instant = utcMidnight - timeZoneOffsetMs(instant);
  }
  return instant;
}

/** 그 순간의 태평양시 오프셋(ms). 예: PST = -8h → -28_800_000. */
function timeZoneOffsetMs(instant: number): number {
  try {
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone: GEMINI_PRICING_TIME_ZONE,
      timeZoneName: "longOffset",
    }).formatToParts(new Date(instant)).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
    const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
    if (!match) return 0;
    const sign = match[1] === "-" ? -1 : 1;
    return sign * (Number(match[2] ?? "0") * 3_600_000 + Number(match[3] ?? "0") * 60_000);
  } catch {
    // 시간대 데이터가 없는 런타임은 UTC로 접는다 — 지출을 지어내기보다 한 경계만 어긋나게 둔다.
    return 0;
  }
}

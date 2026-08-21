const UNITS = ["", "k", "M", "B", "T"] as const;
const DECIMALS = [0, 0, 1, 2, 2] as const;

export type ValueTier = "primary" | "secondary" | "tertiary";

export interface FormattedValueParts {
  readonly number: string;
  readonly prefix: string;
  readonly suffix: string;
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  let unit = 0;
  let scaled = value;
  while (scaled >= 1000 && unit < UNITS.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  let rounded = Number(scaled.toFixed(DECIMALS[unit]));
  if (rounded >= 1000 && unit < UNITS.length - 1) {
    rounded /= 1000;
    unit += 1;
  }
  return `${rounded.toFixed(DECIMALS[unit])}${UNITS[unit]}`;
}

export function formatCost(value: number): string {
  return `$${(Number.isFinite(value) ? Math.max(0, value) : 0).toFixed(2)}`;
}

export function formatTokenParts(value: number): FormattedValueParts {
  const formatted = formatTokens(value);
  const suffix = formatted.match(/[a-zA-Z]+$/)?.[0] ?? "";
  return { number: suffix ? formatted.slice(0, -suffix.length) : formatted, prefix: "", suffix };
}

export function formatCostParts(value: number): FormattedValueParts {
  return { number: formatCost(value).slice(1), prefix: "$", suffix: "" };
}

export function costValueTier(value: number): ValueTier {
  if (value >= 100) return "primary";
  if (value >= 1) return "secondary";
  return "tertiary";
}

export function tokenValueTier(value: number): ValueTier {
  if (value >= 100_000_000) return "primary";
  if (value >= 1_000_000) return "secondary";
  return "tertiary";
}

export function lowerValueTier(tier: ValueTier): ValueTier {
  return tier === "primary" ? "secondary" : "tertiary";
}

export function safePercent(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return (numerator / denominator) * 100;
}

/**
 * 비율 표기는 반올림이 사실을 뒤집지 않아야 한다 — 0이 아닌 몫이 `0%`로, 전부가 아닌 몫이
 * `100%`로 읽히면 백엔드 분해가 합계와 모순된다. 양 끝은 부등호 표기로 단락한다.
 */
export function formatShare(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return "0%";
  if (percent >= 100) return "100%";
  if (percent < 0.1) return "<0.1%";
  if (percent > 99.9) return ">99.9%";
  // 정수 반올림은 99.5~99.9를 100%로 올려 전부가 아닌 몫을 전부로 만든다 — 양 끝은 소수 한 자리를 남긴다.
  return `${percent.toFixed(percent < 10 || percent > 99 ? 1 : 0)}%`;
}

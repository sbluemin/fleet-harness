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

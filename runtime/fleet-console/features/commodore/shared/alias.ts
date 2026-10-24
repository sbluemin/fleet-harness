/** 사령관 별칭은 UTF-16 단위가 아닌 코드포인트로 제한한다. */
export const COMMODORE_ALIAS_MAX_LENGTH = 40;

/** 빈 입력은 해제, 제어 문자·양방향 제어 문자·초과 길이는 거부한다. */
export function normalizeCommodoreAlias(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(trimmed)) return undefined;
  if ([...trimmed].length > COMMODORE_ALIAS_MAX_LENGTH) return undefined;
  return trimmed;
}

export function clampCommodoreAlias(value: string): string {
  return [...value].slice(0, COMMODORE_ALIAS_MAX_LENGTH).join("");
}

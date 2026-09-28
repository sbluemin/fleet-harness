/**
 * 본문 속 http(s) 주소만 링크로 가른다.
 *
 * javascript: 같은 다른 스킴과 깨진 주소는 평문으로 남긴다. 후보는 ASCII URL 문자만
 * 먹어서, 뒤에 공백 없이 붙은 한글은 주소 밖에 남는다. 그때 남는 닫는 괄호와
 * 문장 끝의 구두점은 trim이 걷어 낸다.
 */

export interface LinkPart {
  readonly kind: "text" | "link";
  readonly text: string;
  readonly href?: string;
}

/** RFC 3986의 ASCII 문자. 따옴표는 문장 경계라 빼 둔다. */
const CANDIDATE = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&()*+,;=%]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?。、，！？]+$/u;

const closerOpen = (char: string): "(" | "[" | "{" | null =>
  char === ")" ? "(" : char === "]" ? "[" : char === "}" ? "{" : null;

/** 문장 부호와 짝 없는 닫는 괄호를 주소 끝에서 걷어 낸다. */
function trimCandidate(raw: string): string {
  let value = raw;
  for (;;) {
    const punctuation = TRAILING_PUNCTUATION.exec(value);
    if (punctuation && punctuation[0].length < value.length) {
      value = value.slice(0, -punctuation[0].length);
      continue;
    }
    const last = value.at(-1);
    const open = last ? closerOpen(last) : null;
    if (!last || !open) break;
    let opens = 0;
    let closes = 0;
    for (const char of value) {
      if (char === open) opens += 1;
      else if (char === last) closes += 1;
    }
    if (closes <= opens) break;
    value = value.slice(0, -1);
  }
  return value;
}

function httpHref(text: string): string | null {
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return text;
  } catch {
    return null;
  }
}

export function linkParts(text: string): readonly LinkPart[] {
  const parts: LinkPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const trimmed = trimCandidate(raw);
    const href = httpHref(trimmed);
    if (!href) continue;
    if (index > cursor) parts.push({ kind: "text", text: text.slice(cursor, index) });
    parts.push({ kind: "link", text: trimmed, href });
    const rest = raw.slice(trimmed.length);
    if (rest) parts.push({ kind: "text", text: rest });
    cursor = index + raw.length;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  return parts.length > 0 ? parts : [{ kind: "text", text }];
}

import type { CommodoreLastMessage } from "./contracts/theaters.js";
import type { CommodoreTranscriptEntry } from "./contracts/types.js";
import { splitQuotedPrompt } from "../../execution/client/composer-primitives/quotes.js";

/** 미리보기 한 줄의 상한 — 행이 말줄임으로 자르므로 넉넉하면 된다. */
const PREVIEW_CHARS = 160;

/**
 * 인라인 코드 조각을 임시 치환해 안쪽의 `*`·`_`가 강조 문법으로 벗겨지지 않게 보호한다.
 */
function stripInlineCodeSpans(input: string): { readonly text: string; readonly spans: readonly string[]; readonly sentinel: string } {
  let sentinel = "";
  while (input.includes(sentinel)) sentinel += "";
  const spans: string[] = [];
  let out = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] !== "`") {
      out += input[i];
      i += 1;
      continue;
    }
    let backslashes = 0;
    while (i - 1 - backslashes >= 0 && input[i - 1 - backslashes] === "\\") backslashes += 1;
    if (backslashes % 2 === 1) {
      out += input[i];
      i += 1;
      continue;
    }
    let ticks = 0;
    while (i + ticks < input.length && input[i + ticks] === "`") ticks += 1;
    let cursor = i + ticks;
    let closeStart = -1;
    while (cursor < input.length) {
      if (input[cursor] !== "`") {
        cursor += 1;
        continue;
      }
      let run = 0;
      while (cursor + run < input.length && input[cursor + run] === "`") run += 1;
      if (run === ticks) {
        closeStart = cursor;
        break;
      }
      cursor += run;
    }
    if (closeStart === -1) {
      out += input.slice(i, i + ticks);
      i += ticks;
      continue;
    }
    const inner = input.slice(i + ticks, closeStart).trim();
    const index = spans.length;
    spans.push(inner);
    out += `${sentinel}${index}${sentinel}`;
    i = closeStart + ticks;
  }
  return { text: out, spans, sentinel };
}

function stripPreviewMarkdown(raw: string): string {
  const withoutFences = raw.replace(/```[\s\S]*?(```|$)/g, " ");
  const withoutBlockPrefixes = withoutFences
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]{0,3}[*+-][ \t]+/gm, "");
  const { text: withoutCode, spans, sentinel } = stripInlineCodeSpans(withoutBlockPrefixes);
  let stripped = withoutCode
    .replace(/!\[([^\]]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, "$1");
  for (let pass = 0; pass < 2; pass += 1) {
    stripped = stripped
      .replace(/~~(?=\S)([^\n]+?)(?<=\S)~~/g, "$1")
      .replace(/\*\*\*(?=\S)([^\n]+?)(?<=\S)\*\*\*/g, "$1")
      .replace(/(?<![\p{L}\p{N}_])___(?=\S)([^\n]+?)(?<=\S)___(?![\p{L}\p{N}_])/gu, "$1")
      .replace(/\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/g, "$1")
      .replace(/(?<![\p{L}\p{N}_])__(?=\S)([^\n]+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, "$1")
      .replace(/(?<!\*)\*(?![\s*])([^\n]+?)(?<![\s*])\*(?!\*)/g, "$1")
      .replace(/(?<![\p{L}\p{N}_])_(?![\s_])([^\n]+?)(?<![\s_])_(?![\p{L}\p{N}_])/gu, "$1");
  }
  const restored = spans.length === 0
    ? stripped
    : stripped.replace(new RegExp(`${sentinel}(\\d+)${sentinel}`, "g"), (_match, index) => spans[Number(index)] ?? "");
  return restored.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);
}

/**
 * 사람의 말 끝에 합성된 인용 줄(`[Fleet quote] {json}`)은 말풍선처럼 문면에서 걷는다. 본문 없이 인용만 보냈으면
 * 첫 인용에 붙인 한 줄(note), 없으면 고른 문장(excerpt)을 그대로 보인다 — 새 문구를 짓지 않는다.
 */
function personPreviewWords(text: string): string {
  const split = splitQuotedPrompt(text);
  if (split.quotes.length === 0 || split.text.trim()) return split.text;
  const first = split.quotes[0]!;
  return first.note ?? first.excerpt;
}

/**
 * 기록 한 줄이 대화의 마지막 말이 되는가 — 사람의 메시지(`message`)와 사령관의 답(`text`)만 그렇다.
 * 도구·깨움·세션 같은 운영 줄은 미리보기가 되지 않는다. 코드 울타리(OpenUI 블록 포함)와 인라인 마크다운 기호는 빼고 글자는 유지한 채 공백을 한 칸으로 접는다.
 */
export function commodoreLastMessage(entry: CommodoreTranscriptEntry): CommodoreLastMessage | null {
  if (entry.kind !== "message" && entry.kind !== "text") return null;
  const text = stripPreviewMarkdown(entry.kind === "message" ? personPreviewWords(entry.text) : entry.text);
  if (!text) return null;
  return { at: entry.at, text, from: entry.kind === "message" ? "person" : "commodore" };
}

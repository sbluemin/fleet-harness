/**
 * OpenUI 되먹임 — 화자(사령관·지휘관)의 응답 원문에서 최종 그림이 빼낸 부분을 찾아 다음 턴 입력용 메모로 만든다.
 * 순수·동기이며 React·DOM 에 기대지 않는다. 판정은 렌더러와 같은 정제(openui-prune)다. 호스트가 턴 끝의 응답 원문으로 부르고,
 * 결과는 모델에게만 건넨다 — 채팅 화면(원장·말풍선·알림)에 이 메모나 항목을 그리지 않는다. 경고(warning)는 빼낸 것이 아니므로 싣지 않는다.
 */

import { Marked, type Token } from "marked";

import { OPENUI_LANGUAGES } from "./openui-actions.js";
import { prune } from "./openui-prune.js";

/** 한 응답 안 openui-lang 블록에서 그리지 못하고 뺀 부분 하나. */
export interface OpenUIDropped {
  /** 응답 안 openui-lang(별칭 openui) 펜스 순서, 1부터. */
  readonly block: number;
  /** 빠진 요소의 컴포넌트 이름. 블록 전체를 숨겼거나 요소에 묶이지 않는 문장이면 null. */
  readonly element: string | null;
  /** 모델이 다음 응답에서 고칠 수 있게 쓴 영어 한 문장. */
  readonly reason: string;
}

const MAX_NOTE_ITEMS = 8;
const lexer = new Marked({ gfm: true });

/** 응답 원문(마크다운 전체) 안 openui-lang 펜스의 원문들. 순서는 응답 순서. 언어 판정은 렌더링(core)과 같다. */
export function openUIBlocks(reply: string): readonly string[] {
  const found: string[] = [];
  const walk = (tokens: readonly Token[]) => {
    for (const token of tokens) {
      if (token.type === "code" && OPENUI_LANGUAGES.has(String(token.lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "")) found.push(token.text);
      const nested = (token as { tokens?: Token[] }).tokens;
      if (nested) walk(nested);
      for (const item of (token as { items?: { tokens?: Token[] }[] }).items ?? []) if (item.tokens) walk(item.tokens);
    }
  };
  walk(lexer.lexer(reply));
  return found;
}

/** 최종 그림 기준으로 빠진 것들. 빠진 것이 없으면 빈 배열. */
export function openUIDropped(reply: string): readonly OpenUIDropped[] {
  return openUIBlocks(reply).flatMap((source, index) => {
    const { verdict, dropped } = prune(source, true);
    const items = dropped.map((part) => ({ block: index + 1, element: part.element, reason: part.reason }));
    return verdict.kind === "hide" ? [{ block: index + 1, element: null, reason: "nothing could be drawn, so the whole block was hidden" }, ...items] : items;
  });
}

/** 다음 턴 입력에 붙일 모델용 영어 메모. 빠진 것이 없으면 null. 채팅에 표시하지 않는다. */
export function openUIFeedbackNote(reply: string): string | null {
  const dropped = openUIDropped(reply);
  if (!dropped.length) return null;
  const lines = dropped.slice(0, MAX_NOTE_ITEMS).map((item) => `- block ${item.block}${item.element ? ` · ${item.element}` : ""}: ${item.reason}`);
  if (dropped.length > MAX_NOTE_ITEMS) lines.push(`- … and ${dropped.length - MAX_NOTE_ITEMS} more`);
  return ["In your previous reply, the Console left out parts of an openui-lang block it could not draw; the person did not see them. Follow the block rules next time:", ...lines].join("\n");
}

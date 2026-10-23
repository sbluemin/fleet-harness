import * as React from "react";

import { AgentGlyph } from "../agent-glyphs.js";
import { getT } from "../i18n/index.js";
import type { AgentChatOrigin } from "./chat-events.js";

export type AgentChatPluginOrigin = Extract<AgentChatOrigin, { kind: "plugin" }>;

/**
 * 플러그인이 대신 보낸 말의 출처 표식 — 글리프와 이름. 원장의 출처 줄과 컴포저 큐 칩이 같은 표식을 쓴다:
 * 같은 말이 기다리는 동안과 도착한 뒤에 다른 이름으로 불리면 사람이 둘을 잇지 못한다.
 */
export function OriginMark({ by, language, className }: {
  readonly by: AgentChatPluginOrigin;
  readonly language: "en" | "ko";
  readonly className: string;
}) {
  const known = pluginOriginIdentity(by.pluginId, language);
  return (
    <span className={className}>
      <span className="agent-chat-tally-glyph" aria-hidden="true"><AgentGlyph name={known?.glyph ?? "other"} /></span>
      <span>{by.label ?? known?.name ?? by.pluginId}</span>
    </span>
  );
}

/**
 * 알려진 플러그인 출처의 지역화 이름과 글리프 — 단일 채팅의 출처 줄과 그룹 대화의 알림 줄이 같은 이름·표식을 쓴다.
 * 모르는 플러그인은 null 이다: 대체어는 부르는 표면이 고른다.
 */
export function pluginOriginIdentity(pluginId: string, language: "en" | "ko"): { readonly name: string; readonly glyph: string } | null {
  return pluginId === "objectives" ? { name: getT(language)("terminal.chat.originObjectives"), glyph: "plan" } : null;
}

/**
 * 한 줄을 평문으로 — 인용·제목·목록 표식과 강조·코드·링크 장식을 걷는다. 조각은 렌더하지 않으므로 기호가
 * 남으면 사람이 쓴 적 없는 `**` 가 읽힌다. `_` 는 식별자(snake_case)를 깨므로 걷지 않는다.
 */
const plainLine = (line: string): string => line
  .replace(/^(?:>\s?)+/, "")
  .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/\*\*|~~|[*`]/g, "")
  .trim();

/** 출처 문면의 한 줄 조각. 목표의 문면은 인용이라 인용 표식을 걷고 말만 평문으로 읽는다. 코드 울타리 줄은 말이 아니다. */
export function originExcerpt(text: string, max = 160): string {
  const lines = text.split(/\r?\n/).filter((line) => !/^\s*(?:>\s?)*(?:```|~~~)/.test(line)).map(plainLine).filter((line) => line.length > 0);
  const first = lines[0]?.replace(/\s+/g, " ") ?? "";
  return `${first.slice(0, max)}${first.length > max || lines.length > 1 ? "…" : ""}`;
}

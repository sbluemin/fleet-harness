import { React } from "@fleet-console/sdk/plugin/browser";

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
  const objectives = by.pluginId === "objectives";
  return (
    <span className={className}>
      <span className="agent-chat-tally-glyph" aria-hidden="true"><AgentGlyph name={objectives ? "plan" : "other"} /></span>
      <span>{objectives ? getT(language)("terminal.chat.originObjectives") : by.pluginId}</span>
    </span>
  );
}

const unquote = (line: string): string => line.replace(/^(?:>\s?)+/, "").trim();

/** 출처 문면의 한 줄 조각. 목표의 문면은 인용이라 인용 표식을 걷고 말만 읽는다. */
export function originExcerpt(text: string, max = 160): string {
  const lines = text.split(/\r?\n/).map(unquote).filter((line) => line.length > 0);
  const first = lines[0]?.replace(/\s+/g, " ") ?? "";
  return `${first.slice(0, max)}${first.length > max || lines.length > 1 ? "…" : ""}`;
}

import { ComposerDeck, ComposerDeckEmpty, ComposerDeckGroup, ComposerDeckRow } from "../../composer-primitives/deck.js";
import type { ConsoleLocale } from "@fleet-console/i18n";
import * as React from "react";

import { getT } from "../i18n/index.js";
import type { AgentChatCatalogEntry } from "./chat-events.js";
import type { ChatDeckSection, ChatDeckToken } from "./composer-deck.js";

/**
 * 컴포저 위에 서는 능력 덱 — '/'(명령·스킬)와 '@'(에이전트).
 *
 * 덱의 상자·묶음 머리(글자 + 구분선)·행·키 문법은 네 컴포저가 같이 쓰는 SDK 덱(`Execution composer primitives` `ComposerDeck`)이 소유한다.
 * 여기는 이 표면에만 있는 내용을 싣는다: 섹션 아이콘, 플러그인 네임스페이스를 흐린 이름, 설명, 메타(Console 표식·에이전트 모델·인자
 * 문법), 묶음 머리의 개수, 로딩 뼈대와 「일치 없음」 블록. 행·메타의 `agent-chat-deck-*` 클래스는 그 내용의 외형만 진다.
 */

const SECTION_LABEL_KEY = {
  commands: "terminal.chat.deckCommands",
  skills: "terminal.chat.deckSkills",
  agents: "terminal.chat.deckAgents",
} as const;

/** 15px 획 아이콘. 컴포저의 첨부·전송 아이콘과 같은 규격이다 — 폰트 글리프는 글꼴마다 광학 크기가 달랐다. */
const SECTION_ICON: Record<ChatDeckSection["id"], React.ReactElement> = {
  commands: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.35} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="m5 6.5 2 1.75L5 10M8.5 10.5H11" />
    </svg>
  ),
  skills: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.35} strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.2c.4 2.6 1.5 3.7 4.1 4.1-2.6.4-3.7 1.5-4.1 4.1-.4-2.6-1.5-3.7-4.1-4.1C6.5 5.9 7.6 4.8 8 2.2Z" />
      <path d="M12.2 10.3c.2 1.1.6 1.5 1.6 1.7-1 .2-1.4.6-1.6 1.7-.2-1.1-.6-1.5-1.6-1.7 1-.2 1.4-.6 1.6-1.7Z" />
    </svg>
  ),
  agents: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.35} strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="5.6" r="2.6" />
      <path d="M3 13.6c.7-2.4 2.7-3.8 5-3.8s4.3 1.4 5 3.8" />
    </svg>
  ),
};

const CONSOLE_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="12" height="10" rx="1.6" />
    <path d="M2 6h12M5.2 9.4h3" />
  </svg>
);

const SEARCH_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true">
    <circle cx="7" cy="7" r="4.2" />
    <path d="m10.2 10.2 3.3 3.3" />
  </svg>
);

/** 로딩 뼈대 행 수. 카탈로그가 도착했을 때 덱 높이가 한 줄짜리 상자에서 목록으로 튀지 않게 한다. */
const SKELETON_ROWS = 5;
/**
 * 플러그인 네임스페이스(`frontend-design:frontend-design`)를 떼어 낸다. 마지막 `:`까지가 접두다 —
 * 접두는 흐리게, 나머지가 이름으로 읽힌다. 삽입되는 문면은 바꾸지 않으므로 표시만의 일이다.
 */
function splitNamespace(name: string): { readonly namespace: string; readonly base: string } {
  const at = name.lastIndexOf(":");
  return at < 0 ? { namespace: "", base: name } : { namespace: name.slice(0, at + 1), base: name.slice(at + 1) };
}

/** 벤더가 네임스페이스 항목의 설명 앞에 다시 붙이는 `(ns) `를 걷는다 — 이름 열이 이미 그것을 말한다. */
function readDescription(entry: AgentChatCatalogEntry): string {
  return splitNamespace(entry.name).namespace.length > 0
    ? entry.description.replace(/^\([^)]*\)\s*/, "")
    : entry.description;
}

/** 질의와 처음 일치하는 구간을 굵게 세운다. 순위 규칙(composer-deck.ts rank)과 같은 대소문자 무시 포함 일치다. */
function renderMatch(text: string, query: string): React.ReactNode {
  if (query.length === 0) return text;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

/**
 * 인자 힌트를 CLI 문법으로 그린다. 필수 인자(`<…>`)는 한 단 밝게, 선택지 구분자 `|`는 띄워서 —
 * 비례폭 본문 글꼴에서 `|`가 `l`처럼 읽혀 `create|remove`가 `createlremove`로 보였다.
 */
function renderArgumentHint(hint: string): React.ReactNode {
  return hint
    .split(/(<[^>]+>|\[[^\]]+\])/)
    .filter((part) => part.length > 0)
    .map((part, index) => {
      const pieces = part.split("|").flatMap((piece, at) =>
        at === 0 ? [piece] : [<span key={`sep-${at}`} className="agent-chat-deck-meta-sep">|</span>, piece],
      );
      return part.startsWith("<")
        ? <span key={index} className="agent-chat-deck-meta-required">{pieces}</span>
        : <React.Fragment key={index}>{pieces}</React.Fragment>;
    });
}

export interface ChatComposerDeckProps {
  readonly deckId: string;
  readonly token: ChatDeckToken;
  readonly sections: readonly ChatDeckSection[];
  readonly rows: readonly AgentChatCatalogEntry[];
  readonly activeIndex: number;
  /** 카탈로그를 아직 못 읽었다. 빈 목록과 다른 상태다. */
  readonly pending: boolean;
  readonly language: ConsoleLocale;
  readonly optionId: (index: number) => string;
  readonly onPick: (index: number) => void;
  readonly onHover: (index: number) => void;
}

export function ChatComposerDeck({
  deckId,
  token,
  sections,
  rows,
  activeIndex,
  pending,
  language,
  optionId,
  onPick,
  onHover,
}: ChatComposerDeckProps): React.ReactElement {
  const t = getT(language);
  const listbox = !pending && rows.length > 0;
  const query = token.query;
  const prefix = token.kind === "agent" ? "@" : "/";
  let index = -1;
  return (
    <ComposerDeck
      id={deckId}
      label={t("terminal.chat.deckAria")}
      listbox={listbox}
      contentKey={pending ? "pending" : `${token.kind}:${rows.length}`}
      className="agent-chat-deck"
    >
      {pending ? (
        // 로딩은 뼈대 행으로 선다 — 문구 한 줄이면 "읽는 중"과 "없음"이 같은 상자로 보였다.
        <ComposerDeckEmpty>
          {t("terminal.chat.deckPending")}
          {Array.from({ length: SKELETON_ROWS }, (_, at) => (
            <div key={at} className="agent-chat-deck-skeleton" aria-hidden="true"><i /><i /><i /></div>
          ))}
        </ComposerDeckEmpty>
      ) : rows.length === 0 ? (
        // 매치 0에서도 Enter는 막히지 않는다 — 쓴 문장이 그대로 나간다는 것이 컴포저 공통 계약이다.
        <ComposerDeckEmpty>
          <span className="agent-chat-deck-state-title">{SEARCH_ICON}{t("terminal.chat.deckNoMatch")}</span>
          <span className="agent-chat-deck-state-hint">{t("terminal.chat.deckNoMatchHint")}</span>
        </ComposerDeckEmpty>
      ) : sections.map((section) => (
        // 개수는 묶음 머리의 보조 문구 자리(구분선 앞)에 선다.
        <ComposerDeckGroup key={section.id} label={t(SECTION_LABEL_KEY[section.id])} note={String(section.entries.length)}>
          {section.entries.map((entry) => {
            index += 1;
            const rowIndex = index;
            const description = readDescription(entry);
            const descriptionId = description.length > 0 ? `${optionId(rowIndex)}-desc` : undefined;
            const { namespace, base } = splitNamespace(entry.name);
            // 굵게 세우는 쪽이 이 행이 왜 떴는지를 말한다. 이름이 맞았으면 이름을, 설명으로만 맞았으면 설명을.
            const nameHit = query.length > 0 && entry.name.toLowerCase().includes(query.toLowerCase());
            return (
              <ComposerDeckRow
                // 인덱스를 키에 넣는다 — 같은 이름이 두 번 올 수 있다(플러그인 스킬).
                key={`${section.id}:${rowIndex}:${entry.name}`}
                id={optionId(rowIndex)}
                active={rowIndex === activeIndex}
                className={`agent-chat-deck-row${entry.console ? " is-console" : ""}`}
                {...(descriptionId ? { "aria-describedby": descriptionId } : {})}
                lead={SECTION_ICON[section.id]}
                // 이름은 삽입되는 문면 그대로다 — '@' 행도 `@이름`이 들어가므로 `@`를 보인다.
                name={(
                  <span className="agent-chat-deck-name">
                    <span className="agent-chat-deck-name-prefix">{`${prefix}${namespace}`}</span>
                    {nameHit ? renderMatch(base, query) : base}
                  </span>
                )}
                value={<span id={descriptionId}>{nameHit ? description : renderMatch(description, query)}</span>}
                meta={entry.console ? (
                  // 행선지가 인자보다 먼저 알아야 할 사실이다 — 이 행의 Enter는 자식이 아니라 Console로 간다.
                  <span className="agent-chat-deck-meta is-console" title={t("terminal.chat.deckConsoleHint")}>
                    {CONSOLE_ICON}
                    <span className="agent-chat-deck-meta-label">{t("terminal.chat.deckConsoleHint")}</span>
                  </span>
                ) : entry.model !== null ? (
                  // 에이전트가 고정한 모델. 벤더 값 그대로 쓴다 — 말줄임될 수 있어 전문은 title이 진다.
                  <span className="agent-chat-deck-meta is-model" title={t("terminal.chat.deckAgentModel", { model: entry.model })}>
                    {entry.model}
                  </span>
                ) : entry.argumentHint.length > 0 ? (
                  <span className="agent-chat-deck-meta">{renderArgumentHint(entry.argumentHint)}</span>
                ) : null}
                onPick={() => onPick(rowIndex)}
                onHover={() => onHover(rowIndex)}
              />
            );
          })}
        </ComposerDeckGroup>
      ))}
    </ComposerDeck>
  );
}

/**
 * 미러 층의 문면. `renderUltracodeHighlight`와 같은 일을 하되 구간마다 **다른 클래스**를 싣는다 —
 * 무장 표식과 해석된 좌표는 뜻이 다르므로 색도 달라야 하고, SDK 쪽 렌더러는 클래스를 하나만 받는다.
 *
 * 문면은 한 글자도 바꾸지 않는다. 미러는 읽히는 표면이 아니라 textarea 위에 정확히 겹치는
 * 그림이라, 길이가 달라지면 그 자리부터 두 층이 어긋난다. 끝의 zero-width space도 같은 이유다.
 */
export function renderComposerSpans(
  value: string,
  spans: readonly { readonly start: number; readonly end: number; readonly className: string }[],
): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let at = 0;
  spans.forEach((span, index) => {
    if (span.start < at) return;
    if (span.start > at) parts.push(value.slice(at, span.start));
    parts.push(<span key={`span-${index}`} className={span.className}>{value.slice(span.start, span.end)}</span>);
    at = span.end;
  });
  parts.push(`${value.slice(at)}\u200b`);
  return parts;
}

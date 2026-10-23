import type { AgentChatReferenceHost } from "../../../shared/chat-renderer.js";
import { MentionChip } from "../../composer-primitives/mention-chip.js";
import { splitReferenceText, type ConversationReference } from "../../../shared/conversation/references.js";
import * as React from "react";

/**
 * 사람이 문면 속에 둔 참조를 그 자리의 토큰으로 — 플러그인 기록(SDK `ctx.chat.Transcript`·`Conversation`)의 평문 말풍선만 쓴다.
 *
 * 무엇을 여는지와 어떤 표식을 다는지는 그 기록을 가진 플러그인이 `references` prop 으로 준다. 토큰은 문장 안에 서는 낮은 면이다 —
 * 테두리는 헤어라인, 색은 중립이고 brass 는 hover·초점에만 선다. 여는 손이 없으면 단추가 아니라 글자 조각이다.
 */
export const ChatReferenceContext = React.createContext<AgentChatReferenceHost | null>(null);

export function ChatReferenceText({ text, references }: { readonly text: string; readonly references: readonly ConversationReference[] | undefined }) {
  const host = React.useContext(ChatReferenceContext);
  const parts = splitReferenceText(text, references);
  return (
    <>
      {parts.map((part, index) => {
        if (typeof part === "string") return <React.Fragment key={index}>{part}</React.Fragment>;
        const name = host?.describe?.(part) ?? part.label;
        const open = host?.open;
        return (
          <MentionChip
            key={index}
            label={part.label}
            mark={host?.mark ? host.mark(part.id) : undefined}
            ariaLabel={name}
            {...(open ? { onActivate: () => open(part.id) } : {})}
          />
        );
      })}
    </>
  );
}

/**
 * 도구 줄 속 참조 — 그 자리에 이름만 선다. 한 줄 단계라 토큰 면·표식은 두지 않고, 여는 손이 있으면 그 이름이 글자 단추다.
 * 단계 줄이 접힘 요약일 수 있으므로 누름은 접힘을 건드리지 않는다.
 */
export function ChatReferenceLinks({ text, references }: { readonly text: string; readonly references: readonly ConversationReference[] }) {
  const host = React.useContext(ChatReferenceContext);
  const open = host?.open;
  return (
    <>
      {splitReferenceText(text, references).map((part, index) => {
        if (typeof part === "string") return <React.Fragment key={index}>{part}</React.Fragment>;
        if (!open) return <React.Fragment key={index}>{part.label}</React.Fragment>;
        return (
          <button
            key={index}
            type="button"
            className="agent-chat-step-ref"
            aria-label={host?.describe?.(part) ?? part.label}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); open(part.id); }}
          >
            {part.label}
          </button>
        );
      })}
    </>
  );
}

/** 참조를 이름으로 푼 한 줄 — 단계 줄의 title 처럼 글자만 설 수 있는 자리가 쓴다. */
export function referenceLabelText(text: string, references: readonly ConversationReference[]): string {
  return splitReferenceText(text, references).map((part) => (typeof part === "string" ? part : part.label)).join("");
}

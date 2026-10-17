import type { AgentChatReferenceHost } from "@fleet-console/sdk/components/agent-chat-transcript";
import { MentionChip } from "@fleet-console/sdk/composer";
import { splitReferenceText, type ConversationReference } from "@fleet-console/sdk/conversation";
import { React } from "@fleet-console/sdk/plugin/browser";

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

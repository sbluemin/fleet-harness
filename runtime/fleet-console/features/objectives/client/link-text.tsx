import { gestureFromEvent } from "@fleet-console/sdk/link/browser";

import { linkParts } from "./http-links.js";
import { useObjectiveLinkOpen } from "./link-open-context.js";

/**
 * 평문 안의 http(s) 주소만 새 탭 앵커로 그린다.
 *
 * 클릭은 부모의 선택·펼침·열기로 올라가지 않는다. 호스트가 링크 열기 길을 채워
 * 주면 그 자리에서 명시 호출해 전역 브라우저로 잇고, 모르면 앵커 기본 동작
 * (Desktop 창 정책이 OS 기본 브라우저로 넘긴다)으로 떨어진다.
 */
export function LinkText({ text }: { readonly text: string }) {
  const openLink = useObjectiveLinkOpen();
  const parts = linkParts(text);
  if (parts.every((part) => part.kind === "text")) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) => part.kind === "link" ? (
        <a
          key={index}
          className="objectives-link"
          href={part.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            event.stopPropagation();
            if (!openLink || !part.href) return;
            const handled = openLink(part.href, { gesture: gestureFromEvent(event) });
            // 호스트 구현은 동기다. Promise면 이미 막은 것으로 본다.
            if (handled instanceof Promise) { event.preventDefault(); void handled; return; }
            if (handled) event.preventDefault();
          }}
        >{part.text}</a>
      ) : (
        <span key={index}>{part.text}</span>
      ))}
    </>
  );
}

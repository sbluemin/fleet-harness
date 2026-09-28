import { linkParts } from "./http-links.js";

/**
 * 평문 안의 http(s) 주소만 새 탭 앵커로 그린다.
 *
 * Desktop 은 창 정책이 이 앵커를 기본 브라우저로 넘기고, 브라우저 탭으로 연 Console 은
 * 새 탭으로 연다. 클릭은 부모의 선택·펼침·열기로 올라가지 않는다.
 */
export function LinkText({ text }: { readonly text: string }) {
  const parts = linkParts(text);
  if (parts.every((part) => part.kind === "text")) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) => part.kind === "link" ? (
        <a key={index} className="objectives-link" href={part.href} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}>{part.text}</a>
      ) : (
        <span key={index}>{part.text}</span>
      ))}
    </>
  );
}

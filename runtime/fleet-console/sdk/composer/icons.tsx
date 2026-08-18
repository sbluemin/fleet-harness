/**
 * 컴포저 공용 아이콘 — 16 viewBox·1.4~1.7px stroke의 커맨드 아이콘 문법.
 * Quick Launch와 채팅 컴포저가 같은 그림을 쓴다: 한 제품에서 "첨부"와 "실행"을 가리키는
 * 그림은 하나여야 한다(ChatBubbleIcon이 회신 버튼과 형상을 공유하는 것과 같은 계약).
 */

export function AttachImageIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6" cy="6.6" r="1.1" fill="currentColor" />
      <path d="M3.2 11.6 6.8 8.4l2.4 2.1 1.9-1.7 1.7 1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SubmitArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 12.75V4.25M4.5 7.75 8 4.25l3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

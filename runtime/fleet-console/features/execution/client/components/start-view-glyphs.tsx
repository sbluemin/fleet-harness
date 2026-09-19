/**
 * Operation이 태어날 표면을 가리키는 두 그림.
 *
 * 한 모듈에 사는 이유는 그림 하나가 두 벌 생기지 않게 하기 위해서다 — 같은 뜻을 두 표면이
 * 조금씩 다른 선으로 그리면, 사용자는 Quick Launch에서 배운 말풍선을 런치 메뉴에서 다시
 * 배워야 한다. 실행 종류 어휘를 `agent-cli-launch-kinds.ts` 하나가 소유하는 것과 같은 규율이다.
 *
 * 둘은 같은 16 격자·같은 1.4 굵기 위에 마주 선다. 한쪽만 고치면 나란히 섰을 때 무게가
 * 어긋나므로, 굵기와 격자는 언제나 함께 움직인다.
 */

/** 채팅 시작. 꼬리는 왼쪽 아래로, 몸통은 둥근 모서리 하나로 읽히게 그린다. */
export function ChatBubbleIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M5.1 12.5h-.3a2.4 2.4 0 0 1-2.4-2.4V6.1a2.4 2.4 0 0 1 2.4-2.4h6.4a2.4 2.4 0 0 1 2.4 2.4v4a2.4 2.4 0 0 1-2.4 2.4H7.7l-2.6 2.1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 터미널 시작. 셸 프롬프트의 갈매기 하나 — 채팅 말풍선과 같은 격자·같은 굵기로 마주 세운다. */
export function TerminalViewIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4 5.2 7 8l-3 2.8M8.6 11.2h3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

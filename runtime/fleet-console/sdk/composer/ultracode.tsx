import type { ReactNode } from "react";

/**
 * `ultracode` 인식 문법 — 컴포저 블록의 순수 부품. Quick Launch(core client)와 채팅 컴포저
 * (터미널 플러그인)가 같은 규칙을 조립한다. 단어를 어떻게 잡고, 해제가 언제 만료하며, 미러를
 * 어떻게 겹치는지는 블록이 한 벌로 소유하고, 무장·해제 **상태**는 언제나 조립이 가진다.
 */

/** 프롬프트 안에서 인식된 `ultracode` 한 건의 문면 구간. */
export interface UltracodeToken {
  readonly start: number;
  readonly end: number;
}

/**
 * 대소문자를 가리지 않고, 단어 경계로만 잡는다 — `ULTRACODE`·`UltraCode`는 인식하고
 * `ultracoder`·`my-ultracode-notes`의 일부는 인식하지 않는다. `-`는 경계로 친다(식별자 문자만
 * 붙임으로 본다): 하이픈으로 이어 붙인 파일명 안의 단어까지 잡으면 프롬프트에 경로 하나만 실어도
 * 컴포저가 무장한다.
 *
 * 이 단어는 실행 좌표가 아니라 **프롬프트 원문의 일부**다. Console은 인식만 하고 문면은 손대지
 * 않는다 — 하네스가 그 단어를 어떻게 읽을지는 하네스가 정한다.
 */
export function readUltracodeTokens(value: string): readonly UltracodeToken[] {
  const pattern = /(?<![A-Za-z0-9_])ultracode(?![A-Za-z0-9_])/gi;
  const tokens: UltracodeToken[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    tokens.push({ start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/**
 * 해제(무시)는 **이 초안**에 붙는 상태다. 문면에서 단어가 전부 사라지면 해제도 함께 만료한다 —
 * 그래야 지웠다 다시 친 단어가 새 의사표시로 읽힌다. 남아 있는 동안은 문장을 계속 고쳐도
 * 다시 켜지지 않는다(한 번 껐다는 사실이 편집마다 뒤집히면 그 스위치는 못 믿는다).
 */
export function nextUltracodeIgnored(value: string, ignored: boolean): boolean {
  return ignored && readUltracodeTokens(value).length > 0;
}

/**
 * Backspace가 삭제 대신 해제를 맡는 자리: 선택이 접혀 있고 caret이 인식된 토큰의 **바로 뒤**일 때다.
 * 그 밖의 모든 Backspace는 평소대로 글자를 지운다 — 이 키의 기본 뜻을 넓게 빼앗으면 컴포저가
 * 지워지지 않는 입력이 된다.
 */
export function isUltracodeDisarmCaret(value: string, selectionStart: number, selectionEnd: number): boolean {
  if (selectionStart !== selectionEnd) return false;
  return readUltracodeTokens(value).some((token) => token.end === selectionStart);
}

/**
 * 미러 레이어의 문면. 인식된 구간만 토큰으로 감싸고 나머지는 원문 그대로 둔다 — 미러는 읽히는
 * 표면이 아니라 textarea 위에 정확히 겹치는 그림이라, 문면이 한 글자라도 달라지면 어긋난다.
 * 끝에 zero-width space를 한 칸 붙이는 것은 마지막 줄이 개행으로 끝날 때 미러만 한 줄 짧아지는
 * 것을 막기 위해서다. 토큰 클래스는 호출부가 싣는다(controlled, host-styled).
 */
export function renderUltracodeHighlight(
  value: string,
  tokens: readonly UltracodeToken[],
  tokenClassName: string,
): ReactNode {
  const parts: ReactNode[] = [];
  let at = 0;
  tokens.forEach((token, index) => {
    if (token.start > at) parts.push(value.slice(at, token.start));
    parts.push(
      <span key={`ultracode-${index}`} className={tokenClassName}>{value.slice(token.start, token.end)}</span>,
    );
    at = token.end;
  });
  parts.push(`${value.slice(at)}\u200b`);
  return parts;
}

/**
 * 미러를 textarea의 **client** 박스에 맞춘다. 테두리 박스로 맞추면 스크롤바가 서는 순간
 * textarea만 줄바꿈 폭을 잃어 두 층이 다른 곳에서 접힌다. 스크롤 위치도 같은 값으로 끌고 간다.
 * 조립은 문면·자동 높이가 바뀐 프레임(useLayoutEffect)과 textarea 리사이즈(ResizeObserver)에서
 * 이 함수를 부른다.
 */
export function syncComposerHighlight(
  input: HTMLTextAreaElement | null,
  highlight: HTMLElement | null,
): void {
  if (!input || !highlight) return;
  highlight.style.width = `${input.clientWidth}px`;
  highlight.style.height = `${input.clientHeight}px`;
  highlight.scrollTop = input.scrollTop;
}

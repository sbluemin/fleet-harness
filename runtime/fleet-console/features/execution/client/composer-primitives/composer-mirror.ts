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

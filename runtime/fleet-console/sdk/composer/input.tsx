import { forwardRef, useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

export interface ComposerInputProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly value: string;
}

/**
 * 컴포저 입력 — 자동 높이 textarea. 문면이 바뀐 프레임에서 scrollHeight만큼 자라고,
 * 줄 상한은 CSS max-height가 소유한다(Quick Launch·Analyst 컴포저와 같은 clamp 정책).
 * 그 밖의 모든 동작(키·붙여넣기·aria)은 호출부 소유라 그대로 통과시킨다 — 블록은
 * 동작 문법을 공유하고 상태·정책은 조립이 가진다.
 */
export const ComposerInput = forwardRef<HTMLTextAreaElement, ComposerInputProps>(function ComposerInput(
  { value, ...rest },
  ref,
) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);

  // 제어 컴포넌트라 값이 DOM에 반영된 뒤에야 높이를 잴 수 있다 — 렌더와 같은 프레임에서 맞춘다
  // (그려진 뒤 맞추면 한 프레임 어긋난 채 보인다). 프로그램 쓰기(초안 복원·커맨드 확정)도 같은
  // 경로를 지나므로 호출부가 따로 높이를 만질 필요가 없다.
  useLayoutEffect(() => {
    const element = innerRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={(node) => {
        innerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      value={value}
      {...rest}
    />
  );
});

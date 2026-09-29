import { forwardRef, useLayoutEffect, useRef, type RefObject, type TextareaHTMLAttributes } from "react";

/**
 * textarea의 값을 React 제어 대신 DOM에 직접 맞춘다 — 호출부는 `value`/`defaultValue` prop 없이 ref와 함께 쓴다.
 *
 * React 19은 입력 이벤트마다(그리고 다시 그릴 때마다) textarea의 defaultValue를 value 또는 defaultValue prop으로 다시
 * 쓴다. 문구가 든 defaultValue 쓰기는 값이 같아도 자식 텍스트 노드를 갈아 끼우고, 그 변경이 문서의 :has() 규칙
 * 무효화를 불러 맵의 캡션·패널 제목줄까지 글자마다 스타일을 다시 계산한다(패널 12개 맵에서 글자당 약 4ms). 두 prop이
 * 없으면 React는 빈 defaultValue만 써서 비용이 없다. 값은 DOM과 다를 때만 쓰므로 캐럿·IME 조합을 건드리지 않는다.
 */
export function useTextareaValue(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && element.value !== value) element.value = value;
  }, [ref, value]);
}

export interface SyncedTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "defaultValue"> {
  readonly value: string;
}

/** 제어 textarea의 대체 — `value`는 받되 DOM에 직접 맞춘다(useTextareaValue). 나머지 prop은 그대로 통과한다. */
export const SyncedTextarea = forwardRef<HTMLTextAreaElement, SyncedTextareaProps>(function SyncedTextarea({ value, ...rest }, ref) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  useTextareaValue(innerRef, value);
  return (
    <textarea
      ref={(node) => {
        innerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      {...rest}
    />
  );
});

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
  useTextareaValue(innerRef, value);

  // 값이 DOM에 반영된 뒤에야(위 동기화) 높이를 잴 수 있다 — 렌더와 같은 프레임에서 맞춘다
  // (그려진 뒤 맞추면 한 프레임 어긋난 채 보인다). 프로그램 쓰기(초안 복원·커맨드 확정)도 같은
  // 경로를 지나므로 호출부가 따로 높이를 만질 필요가 없다.
  useLayoutEffect(() => {
    const element = innerRef.current;
    if (!element) return;
    element.style.height = "auto";
    // 숨은 채 마운트되면(패널 전환 중) scrollHeight가 0이다 — 0px를 박아 두면 다음 값 변경까지 CSS
    // 하한만으로 서므로, 잴 수 없는 프레임은 건너뛴다.
    if (element.scrollHeight === 0) return;
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={(node) => {
        innerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      {...rest}
    />
  );
});

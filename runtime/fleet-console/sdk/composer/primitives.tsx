import { forwardRef, useRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";

import { AttachImageIcon, SubmitArrowIcon } from "./icons.js";

/**
 * 컴포저 빌딩블록 — 구조와 동작 문법만 소유하는 순수 프롭스 구동 조각들.
 *
 * 클래스는 전부 호출부가 넘긴다: Quick Launch는 기존 `quick-launch-*` 클래스를 그대로 실어
 * 재조립 전후 DOM이 달라지지 않고(외형 불변이 합격선), 다른 조립(채팅 컴포저)은 자기 CSS의
 * 클래스를 싣는다. 호스트와 플러그인 번들은 이 모듈을 각자 적재하므로 모듈 스코프 상태를
 * 두지 않는다 — 상태(초안·선택·접힘)는 언제나 조립 쪽이 가진다.
 */

/** 입력행(field) — 멘션 칩·입력·첨부 트레이가 앉는 첫 행. 접힘 중 inert는 호출부가 소유한다. */
export const ComposerField = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ComposerField(props, ref) {
    return <div ref={ref} {...props} />;
  },
);

/** 컨트롤 행(bar) — 칩·트랙은 좌측, 액션(첨부·실행)은 우측에 앉는 둘째 행. 배치는 CSS 소유다. */
export const ComposerBar = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ComposerBar(props, ref) {
    return <div ref={ref} {...props} />;
  },
);

export interface ComposerChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly children: ReactNode;
}

/** 메뉴를 여는 pill 칩 — 칩과 메뉴는 한 문법이라 haspopup을 기본으로 진다(끄려면 명시 전달). */
export const ComposerChip = forwardRef<HTMLButtonElement, ComposerChipProps>(
  function ComposerChip({ children, ...rest }, ref) {
    return (
      <button ref={ref} type="button" aria-haspopup="menu" {...rest}>
        {children}
      </button>
    );
  },
);

/**
 * 물러난 컴포저가 남기는 한 줄 — 초안 자취를 싣고, 누르면 조립이 펼친다.
 * 접힌 동안 나머지 컨트롤이 inert일 때 되돌아오는 유일한 통로이므로 언제나 실제 버튼이다.
 */
export const ComposerRestStrip = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function ComposerRestStrip(props, ref) {
    return <button ref={ref} type="button" {...props} />;
  },
);

export interface ComposerAttachControlProps {
  readonly className: string;
  /** 입구 폭은 붙여넣기·드롭과 같게 두는 것이 기본 — 형식의 최종 판정자는 서버 스니퍼다. */
  readonly accept?: string;
  readonly multiple?: boolean;
  readonly label: string;
  readonly onFiles: (files: readonly File[]) => void;
  readonly children?: ReactNode;
}

/** 파일 픽커 입구 — 숨은 input과 아이콘 버튼 한 쌍. 같은 파일 재선택을 위해 값은 즉시 비운다. */
export function ComposerAttachControl({
  className,
  accept = "image/*",
  multiple = true,
  label,
  onFiles,
  children,
}: ComposerAttachControlProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          // 같은 파일을 연달아 고를 수 있게 값을 비운다 — 남기면 change가 다시 안 온다.
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className={className}
        onClick={() => inputRef.current?.click()}
        aria-label={label}
        title={label}
      >
        {children ?? <AttachImageIcon />}
      </button>
    </>
  );
}

export interface ComposerSubmitButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly children?: ReactNode;
}

/** 실행 버튼 — 시각 레이블이 없는 원형 버튼이라 이름(aria-label)은 호출부가 반드시 싣는다. */
export const ComposerSubmitButton = forwardRef<HTMLButtonElement, ComposerSubmitButtonProps>(
  function ComposerSubmitButton({ children, ...rest }, ref) {
    return (
      <button ref={ref} type="button" {...rest}>
        {children ?? <SubmitArrowIcon />}
      </button>
    );
  },
);

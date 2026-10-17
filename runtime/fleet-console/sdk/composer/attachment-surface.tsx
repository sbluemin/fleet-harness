import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";

/**
 * 캡슐 컴포저의 첨부 줄 · 안내 줄 · 「+」 메뉴 — 그룹 대화 입력창과 사령관 입력창이 같은 부품을 쓴다.
 *
 * `primitives.tsx` 의 블록과 달리 이 부품들은 클래스를 호출부에서 받지 않는다: 외형까지 한 벌이어야 하는 자리라 클래스
 * (`fc-composer-*`)를 고정하고 호스트가 그 클래스를 그린다(core `components.css`). 호출부는 자리(메뉴가 뜨는 위치 등)만
 * 덧붙인다. 상태(초안·업로드·열림)는 언제나 조립 쪽이 가진다 — 호스트와 플러그인 번들이 이 모듈을 각자 적재한다.
 */

export interface ComposerAttachmentItem {
  readonly key: string;
  readonly name: string;
  readonly previewUrl: string;
  /** 서버 id 가 서기 전 — 썸네일이 흐려지고, 조립은 보내기를 잠근다. */
  readonly uploading: boolean;
}

export interface ComposerAttachmentTrayProps {
  readonly items: readonly ComposerAttachmentItem[];
  /** 묶음 이름(스크린 리더). */
  readonly label: string;
  readonly removeLabel: (name: string) => string;
  readonly onRemove: (key: string) => void;
  /** 보내는 중처럼 초안을 바꿀 수 없을 때 제거 단추를 잠근다. */
  readonly disabled?: boolean;
}

/** 붙인 이미지 줄 — 캡슐 안 맨 위 줄에 썸네일과 모서리 × 가 선다. 비어 있으면 그리지 않는다. */
export function ComposerAttachmentTray({ items, label, removeLabel, onRemove, disabled = false }: ComposerAttachmentTrayProps) {
  if (items.length === 0) return null;
  return (
    <div className="fc-composer-attachments" role="group" aria-label={label}>
      {items.map((item) => (
        <span key={item.key} className={`fc-composer-attachment${item.uploading ? " is-uploading" : ""}`}>
          <img src={item.previewUrl} alt={item.name} />
          <button
            type="button"
            className="fc-composer-attachment__remove"
            disabled={disabled}
            aria-label={removeLabel(item.name)}
            title={removeLabel(item.name)}
            onClick={() => onRemove(item.key)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

export interface ComposerNoticeProps {
  readonly text: string;
  /** `warn` 은 되돌릴 수 있는 거절(상한·용량·일부 실패), `danger` 는 보내기 실패, `info` 는 중립 안내다. */
  readonly tone?: "info" | "warn" | "danger";
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
}

/** 입력창 바로 위 한 줄 안내 — 끝의 「닫기」로 걷는다. 실패는 alert, 그 밖은 status 로 읽힌다. */
export function ComposerNotice({ text, tone = "info", dismissLabel, onDismiss }: ComposerNoticeProps) {
  return (
    <div className={`fc-composer-notice is-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <span>{text}</span>
      {onDismiss && dismissLabel ? <button type="button" className="fc-composer-notice__dismiss" onClick={onDismiss}>{dismissLabel}</button> : null}
    </div>
  );
}

/** 「+」 원 — 캡슐 왼쪽 끝의 입구. 그림은 늘 같은 더하기다. */
export const ComposerPlusButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function ComposerPlusButton({ className, ...rest }, ref) {
    return (
      <button ref={ref} type="button" aria-haspopup="menu" className={["fc-composer-circle", "fc-composer-plus", className].filter(Boolean).join(" ")} {...rest}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.25v9.5M3.25 8h9.5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" /></svg>
      </button>
    );
  },
);

/** 보내기 원 — 「+」 원과 같은 크기·면이다. 이름(aria-label)은 호출부가 싣는다. `children` 으로 그림(정지 등)을 바꾼다. */
export const ComposerSendButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function ComposerSendButton({ className, children, ...rest }, ref) {
    return (
      <button ref={ref} type="button" className={["fc-composer-circle", "fc-composer-send", className].filter(Boolean).join(" ")} {...rest}>
        {children ?? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </button>
    );
  },
);

/** 「+」 메뉴 상자 — 외형만 가진다. 뜨는 자리(위치)는 호출부의 클래스가 정한다. */
export const ComposerMenu = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ComposerMenu({ className, ...rest }, ref) {
    return <div ref={ref} role="menu" className={["fc-composer-menu", className].filter(Boolean).join(" ")} {...rest} />;
  },
);

export interface ComposerMenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 16px 글리프 — 문자(`@`)면 굵은 글자로 선다. */
  readonly glyph?: ReactNode;
  /** 행 끝의 보조 설명. */
  readonly sub?: ReactNode;
  /** 행 끝의 단축 글자(`@` 처럼 손으로 쳐도 같은 길). `sub` 와 함께 쓰지 않는다. */
  readonly keyHint?: string;
  readonly children: ReactNode;
}

/** 메뉴 행 — 글리프 · 이름 · (보조 설명 | 단축 글자). `is-armed` 클래스는 두 번 눌러 확정하는 행의 첫 누름 상태다. */
export const ComposerMenuItem = forwardRef<HTMLButtonElement, ComposerMenuItemProps>(
  function ComposerMenuItem({ glyph, sub, keyHint, children, className, ...rest }, ref) {
    return (
      <button ref={ref} type="button" role="menuitem" className={["fc-composer-menu__item", className].filter(Boolean).join(" ")} {...rest}>
        {glyph !== undefined ? <span className={`fc-composer-menu__glyph${typeof glyph === "string" ? " is-text" : ""}`} aria-hidden="true">{glyph}</span> : null}
        <span className="fc-composer-menu__name">{children}</span>
        {sub !== undefined ? <span className="fc-composer-menu__sub">{sub}</span> : keyHint ? <kbd className="fc-composer-menu__key" aria-hidden="true">{keyHint}</kbd> : null}
      </button>
    );
  },
);

export function ComposerMenuSeparator() {
  return <div className="fc-composer-menu__sep" role="separator" />;
}

export function ComposerMenuHeading({ children }: { readonly children: ReactNode }) {
  return <div className="fc-composer-menu__heading" role="presentation">{children}</div>;
}

import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import type { Translate } from "@fleet-console/i18n";
import { useComposerAttachmentSnapshot } from "./attachment-input.js";
import type { ComposerAttachments } from "./attachment-store.js";
import type { ComposerMessageKey } from "./messages.js";

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
  readonly store: ComposerAttachments;
  /** 첨부 문구. 썸네일·확대 보기·제거가 이 한 벌을 쓴다. */
  readonly t: Translate<ComposerMessageKey>;
  /** 보내는 중처럼 초안을 바꿀 수 없을 때 제거 단추를 잠근다. */
  readonly disabled?: boolean;
}

export interface ComposerAttachmentViewImage {
  readonly key: string;
  readonly src: string;
  readonly name: string;
}

/**
 * 첨부 한 장 이상을 크게 본다. 스크림 모달이고, ←/→ 로 넘기며 Esc 와 바깥 클릭이 닫는다.
 * 포커스는 열릴 때 닫기 단추로 가고 Tab/Shift+Tab 은 팝업 안에서 순환한다. 닫히면 연 자리로 돌아간다.
 */
export function ComposerAttachmentViewer({
  images,
  index,
  onIndex,
  onClose,
  closeLabel,
  previousLabel,
  nextLabel,
  onImageError,
  returnFocusRef,
}: {
  readonly images: readonly ComposerAttachmentViewImage[];
  readonly index: number;
  readonly onIndex: (index: number) => void;
  readonly onClose: () => void;
  readonly closeLabel: string;
  readonly previousLabel: string;
  readonly nextLabel: string;
  readonly onImageError?: (key: string) => void;
  /** 포인터로 눌러도 포커스를 받지 않는 브라우저를 위해 연 썸네일을 직접 넘긴다. */
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const image = images[index] ?? null;
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const returnTo = returnFocusRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    closeRef.current?.focus({ preventScroll: true });
    return () => { if (returnTo?.isConnected) returnTo.focus({ preventScroll: true }); };
  }, [returnFocusRef]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        const buttons = Array.from(viewerRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
        if (!buttons.length) return;
        event.preventDefault();
        event.stopPropagation();
        const active = buttons.findIndex((button) => button === document.activeElement);
        const next = active < 0 ? (event.shiftKey ? buttons.length - 1 : 0) : (active + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus({ preventScroll: true });
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (images.length < 2) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        const delta = event.key === "ArrowRight" ? 1 : -1;
        onIndex((index + delta + images.length) % images.length);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [images.length, index, onClose, onIndex]);
  if (image === null || typeof document === "undefined") return null;
  return createPortal(
    <div ref={viewerRef} className="fc-composer-viewer" role="dialog" aria-modal="true" aria-label={image.name} onMouseDown={onClose}>
      <div className="fc-composer-viewer__frame" onMouseDown={(event) => event.stopPropagation()}>
        {images.length > 1 ? (
          <button type="button" className="fc-composer-viewer__nav is-prev" aria-label={previousLabel} onClick={() => onIndex((index - 1 + images.length) % images.length)}>‹</button>
        ) : null}
        <img src={image.src} alt={image.name} onError={() => onImageError?.(image.key)} />
        {images.length > 1 ? (
          <button type="button" className="fc-composer-viewer__nav is-next" aria-label={nextLabel} onClick={() => onIndex((index + 1) % images.length)}>›</button>
        ) : null}
        <button ref={closeRef} type="button" className="fc-composer-viewer__close" onClick={onClose} aria-label={closeLabel}>✕</button>
      </div>
    </div>,
    document.body,
  );
}

/** 붙인 이미지 줄 — 썸네일은 단추이고, 누르면 확대 보기가 같이 온다. 비어 있으면 그리지 않는다. */
export function ComposerAttachmentTray({ store, t, disabled = false }: ComposerAttachmentTrayProps) {
  const { items } = useComposerAttachmentSnapshot(store);
  const [index, setIndex] = useState<number | null>(null);
  const originRef = useRef<HTMLButtonElement | null>(null);
  if (items.length === 0) return null;
  const openAt = index !== null && index >= 0 && index < items.length ? index : null;
  return (
    <div className="fc-composer-attachments" role="group" aria-label={t("composer.attach.list")}>
      {items.map((item, at) => (
        <span key={item.key} className={`fc-composer-attachment${item.uploading ? " is-uploading" : ""}`}>
          <button
            type="button"
            className="fc-composer-attachment__open"
            disabled={item.uploading}
            aria-label={t("composer.attach.open", { name: item.name })}
            title={t("composer.attach.open", { name: item.name })}
            onClick={(event) => { originRef.current = event.currentTarget; setIndex(at); }}
          >
            <img src={item.previewUrl} alt="" />
          </button>
          <button
            type="button"
            className="fc-composer-attachment__remove"
            disabled={disabled}
            aria-label={t("composer.attach.remove", { name: item.name })}
            title={t("composer.attach.remove", { name: item.name })}
            onClick={() => store.remove(item.key)}
          >
            ×
          </button>
        </span>
      ))}
      {openAt !== null ? (
        <ComposerAttachmentViewer
          images={items.map((item) => ({ key: item.key, src: item.previewUrl, name: item.name }))}
          index={openAt}
          returnFocusRef={originRef}
          onIndex={setIndex}
          onClose={() => setIndex(null)}
          closeLabel={t("composer.attach.close")}
          previousLabel={t("composer.attach.previous")}
          nextLabel={t("composer.attach.next")}
        />
      ) : null}
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

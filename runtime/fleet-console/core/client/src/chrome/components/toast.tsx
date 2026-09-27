import type { ReactNode } from "react";

import { useT } from "../../i18n/index.js";

export type ToastTone = "info" | "warn" | "error" | "undo";

interface ToastProps {
  readonly open: boolean;
  readonly title: string;
  readonly message?: string;
  readonly tone?: ToastTone;
  readonly onDismiss?: () => void;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  /** 메시지 줄 끝의 보조 동작(예: 「보관함」). 주 동작 단추와 겹치지 않게 글자 링크로 선다. */
  readonly secondaryActionLabel?: string;
  readonly onSecondaryAction?: () => void;
  readonly progress?: number;
}

// 우하단 고정 토스트의 스택 컨테이너. 토스트가 여러 개 동시에 열릴 수 있으므로(undo + 테마 안내 등)
// fixed 호스트는 하나만 두고 아이템이 세로로 쌓이게 한다 — 호스트를 토스트마다 두면 같은 위치에 겹친다.
export function ToastHost({ children }: { readonly children: ReactNode }) {
  return <div className="app-toast-host">{children}</div>;
}

// 우하단 고정 토스트 아이템. 연결 이상 등 어떤 알림에도 재사용할 수 있도록 tone/title/message/onDismiss만 받는다.
export function Toast({ open, title, message, tone = "info", onDismiss, actionLabel, onAction, secondaryActionLabel, onSecondaryAction, progress }: ToastProps) {
  const t = useT();
  if (!open) return null;
  return (
    <div className={`app-toast app-toast--${tone}`} role="status" aria-live="polite">
      <span className="app-toast-dot" aria-hidden="true" />
      <div className="app-toast-body">
        <p className="app-toast-title">{title}</p>
        {message || (secondaryActionLabel && onSecondaryAction) ? (
          <p className="app-toast-message">
            {message}
            {secondaryActionLabel && onSecondaryAction ? (
              <>
                {message ? <span aria-hidden="true"> · </span> : null}
                <button type="button" className="app-toast-link" onClick={onSecondaryAction}>{secondaryActionLabel}</button>
              </>
            ) : null}
          </p>
        ) : null}
        {typeof progress === "number" ? (
          <span className="app-toast-progress" aria-hidden="true">
            <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, progress))})` }} />
          </span>
        ) : null}
      </div>
      {actionLabel && onAction ? (
        <button type="button" className="app-toast-action" onClick={onAction}>{actionLabel}</button>
      ) : null}
      {onDismiss ? (
        <button type="button" className="app-toast-close" onClick={onDismiss} aria-label={t("chrome.toast.dismissNotification")}>
          ×
        </button>
      ) : null}
    </div>
  );
}

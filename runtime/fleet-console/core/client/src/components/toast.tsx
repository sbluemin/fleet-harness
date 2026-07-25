import { useT } from "../i18n/index.js";

export type ToastTone = "info" | "warn" | "error" | "undo";

interface ToastProps {
  readonly open: boolean;
  readonly title: string;
  readonly message?: string;
  readonly tone?: ToastTone;
  readonly onDismiss?: () => void;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly progress?: number;
}

// 우하단 고정 토스트. 연결 이상 등 어떤 알림에도 재사용할 수 있도록 tone/title/message/onDismiss만 받는다.
export function Toast({ open, title, message, tone = "info", onDismiss, actionLabel, onAction, progress }: ToastProps) {
  const t = useT();
  if (!open) return null;
  return (
    <div className="app-toast-host">
      <div className={`app-toast app-toast--${tone}`} role="status" aria-live="polite">
        <span className="app-toast-dot" aria-hidden="true" />
        <div className="app-toast-body">
          <p className="app-toast-title">{title}</p>
          {message ? <p className="app-toast-message">{message}</p> : null}
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
    </div>
  );
}

export type ToastTone = "info" | "warn" | "error";

interface ToastProps {
  readonly open: boolean;
  readonly title: string;
  readonly message?: string;
  readonly tone?: ToastTone;
  readonly onDismiss?: () => void;
}

// 우하단 고정 토스트. 연결 이상 등 어떤 알림에도 재사용할 수 있도록 tone/title/message/onDismiss만 받는다.
export function Toast({ open, title, message, tone = "info", onDismiss }: ToastProps) {
  if (!open) return null;
  return (
    <div className="app-toast-host">
      <div className={`app-toast app-toast--${tone}`} role="status" aria-live="polite">
        <span className="app-toast-dot" aria-hidden="true" />
        <div className="app-toast-body">
          <p className="app-toast-title">{title}</p>
          {message ? <p className="app-toast-message">{message}</p> : null}
        </div>
        {onDismiss ? (
          <button type="button" className="app-toast-close" onClick={onDismiss} aria-label="Dismiss notification">
            ×
          </button>
        ) : null}
      </div>
    </div>
  );
}

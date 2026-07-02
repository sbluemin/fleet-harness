import { useEffect } from "react";

// ─── types ───────────────────────────────────────────────────────────────────

interface ToastProps {
  readonly message: string | null;
  readonly onDismiss: () => void;
}

// ─── constants ───────────────────────────────────────────────────────────────

const TOAST_DURATION_MS = 3200;

// ─── Toast ────────────────────────────────────────────────────────────────────

export function Toast({ message, onDismiss }: ToastProps) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(onDismiss, TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  if (!message) return null;

  return (
    <div className="skills-toast" role="status" aria-live="polite">
      {message}
    </div>
  );
}

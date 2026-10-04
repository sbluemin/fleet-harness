import { useEffect, useSyncExternalStore } from "react";

/**
 * 모바일 토스트(S-33). 문구 하나와 선택적 글자 버튼 하나, 6초 뒤 사라진다. 앱 루트의 토스트 호스트(보관 되돌리기 등
 * 상태가 있는 것)와 같은 문법을 입는다 — 이 스토어는 「이름을 바꿨습니다」 같은 한 줄 알림만 든다.
 */
export interface MobileToast {
  readonly id: number;
  readonly text: string;
  readonly action?: { readonly label: string; readonly run: () => void };
}

const SHOW_MS = 6000;
const listeners = new Set<() => void>();
let current: MobileToast | null = null;
let nextId = 1;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function showMobileToast(text: string, action?: MobileToast["action"]): void {
  current = { id: nextId++, text, ...(action ? { action } : {}) };
  for (const listener of listeners) listener();
}

function dismiss(id: number): void {
  if (current?.id !== id) return;
  current = null;
  for (const listener of listeners) listener();
}

export function MobileToastHost() {
  const toast = useSyncExternalStore(subscribe, () => current);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => dismiss(toast.id), SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  return (
    <div className="mobile-toast-host">
      <div className="app-toast app-toast--info" role="status" aria-live="polite">
        <div className="app-toast-body"><p className="app-toast-title">{toast.text}</p></div>
        {toast.action ? <button type="button" className="app-toast-action" onClick={() => { const action = toast.action; dismiss(toast.id); action?.run(); }}>{toast.action.label}</button> : null}
      </div>
    </div>
  );
}

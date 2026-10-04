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

/**
 * 상태가 앱 루트에 있는 토스트(보관·삭제 되돌리기)의 모바일 모양 — 문구 하나와 오른쪽 글자 버튼 여럿(S-33: 「되돌리기」·「보관함」).
 * 열림·닫힘은 호출한 쪽이 정한다(되돌리기 창이 끝나면 닫힌다).
 */
export function MobileActionToast({ open, text, actions }: { readonly open: boolean; readonly text: string; readonly actions: readonly { readonly label: string; readonly run: () => void }[] }) {
  if (!open) return null;
  return (
    <div className="mobile-toast-host">
      <div className="app-toast app-toast--undo" role="status" aria-live="polite">
        <div className="app-toast-body"><p className="app-toast-title">{text}</p></div>
        {actions.map((action) => <button key={action.label} type="button" className="app-toast-action" onClick={action.run}>{action.label}</button>)}
      </div>
    </div>
  );
}

// 보관한 Operation의 제목 — 보관 뒤에는 목록에서 사라지므로 토스트가 부를 수 있게 보관하는 순간 적어 둔다.
const archivedTitles = new Map<string, string>();
export function rememberArchivedTitle(operationId: string, title: string): void {
  archivedTitles.set(operationId, title);
  if (archivedTitles.size > 20) archivedTitles.delete(archivedTitles.keys().next().value as string);
}
export function recallArchivedTitle(operationId: string): string | undefined {
  return archivedTitles.get(operationId);
}

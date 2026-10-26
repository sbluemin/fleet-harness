import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { CommodoreDeleteFlow, type CommodoreDeleteFrame } from "./commodore-delete-body.js";
import { announceCommodoreDeletion } from "./commodore-delete-events.js";

let target: { readonly id: string; readonly opener: HTMLElement | null } | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of [...listeners]) listener(); };
export function requestCommodoreDelete(id: string, opener?: HTMLElement | null): void {
  target = { id, opener: opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null) }; emit();
}
export function CommodoreDeleteModal() {
  const current = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => target, () => null);
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  if (!current) return null;
  const close = (restore: boolean) => {
    target = null; emit();
    if (restore) requestAnimationFrame(() => { if (current.opener?.isConnected) current.opener.focus({ preventScroll: true }); });
  };
  return <CommodoreDeleteFlow key={current.id} commodoreId={current.id} language={language} onClose={() => close(true)}
    onComplete={(notice) => { close(false); announceCommodoreDeletion(notice); }} renderFrame={(frame) => <DeleteDialog frame={frame} />} />;
}
function DeleteDialog({ frame }: { readonly frame: CommodoreDeleteFrame }) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const focus = (event: FocusEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target)) panel.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")?.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", focus);
    return () => document.removeEventListener("focusin", focus);
  }, []);
  return <div className="commodore-create-scrim commodore-delete-scrim" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget && frame.step === 1) frame.close(); }}>
    <div ref={panel} className="commodore-create commodore-delete" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={frame.questionId} tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!event.nativeEvent.isComposing && event.keyCode !== 229) frame.close(); }
        if (event.key === "Tab") {
          const items = [...(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex='0']") ?? [])];
          const first = items[0], last = items.at(-1);
          if (!first) { event.preventDefault(); panel.current?.focus(); }
          else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <header className="commodore-create-head"><h2 id={titleId}>{frame.title}</h2><button type="button" className="commodore-create-close" disabled={frame.busy} aria-label={frame.closeLabel} onClick={frame.close}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg></button></header>
      <div className="commodore-create-body">{frame.body}</div><footer className="commodore-create-foot">{frame.footer}</footer>
    </div>
  </div>;
}

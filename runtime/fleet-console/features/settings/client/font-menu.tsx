import { FontPicker, type FontPickerProps } from "@fleet-console/font-picker/browser";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface FontMenuProps extends FontPickerProps {
  readonly label: string;
  readonly selectedLabel: string;
}

/** 설정 행의 선택기는 작은 글자 버튼이고, 검색·목록은 열었을 때만 생긴다. */
export function FontMenu({ label, selectedLabel, ...picker }: FontMenuProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 260, maxHeight: 360 });
  const close = (restoreFocus: boolean) => {
    returnFocus.current = restoreFocus;
    setOpen(false);
    if (restoreFocus && !picker.disabled) trigger.current?.focus();
  };
  useEffect(() => {
    // 선택 저장은 버튼을 잠시 비활성화한다. 응답·되돌림이 끝나기 전에 focus()하면 body로 새므로
    // 버튼이 다시 살아난 뒤에도 같은 복귀 요청을 지킨다.
    if (open || picker.disabled || !returnFocus.current) return;
    returnFocus.current = false;
    trigger.current?.focus();
  }, [open, picker.disabled]);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !popup.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const pane = trigger.current.closest(".rail-pane-body, .settings-pane")?.getBoundingClientRect();
    const leftLimit = Math.max(16, (pane?.left ?? 0) + 16);
    const rightLimit = Math.min(innerWidth - 16, (pane?.right ?? innerWidth) - 16);
    const width = Math.min(280, Math.max(160, rightLimit - leftLimit));
    const below = innerHeight - rect.bottom - 22;
    const above = rect.top - 22;
    const down = below >= Math.min(320, above);
    const maxHeight = Math.max(120, Math.min(360, down ? below : above));
    const height = Math.min(popup.current.scrollHeight, maxHeight);
    setPosition({ width, maxHeight, left: Math.max(leftLimit, Math.min(rect.right - width, rightLimit - width)), top: down ? rect.bottom + 6 : Math.max(16, rect.top - height - 6) });
    popup.current.querySelector<HTMLInputElement>("input[type=search]")?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || popup.current?.contains(event.target) || trigger.current?.contains(event.target)) return;
      setOpen(false);
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target)) return;
      setOpen(false);
    };
    const ownerChanged = () => {
      // 포털은 부모의 inert를 상속하지 않는다. 연결 끊김·다른 모달로 부모가 잠기면 목록도 거둔다.
      if (!trigger.current?.isConnected || trigger.current.closest("[inert], [hidden]")) setOpen(false);
    };
    const ownerObserver = new MutationObserver(ownerChanged);
    ownerObserver.observe(document.body, { attributes: true, attributeFilter: ["inert", "hidden"], subtree: true });
    ownerChanged();
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", scroll);
    return () => {
      ownerObserver.disconnect();
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", scroll);
    };
  }, [open]);
  return <>
    <button ref={trigger} type="button" className="settings-font-trigger" aria-label={`${label}: ${selectedLabel}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={picker.disabled} onClick={() => setOpen(!open)}>
      <span>{selectedLabel}</span><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
    </button>
    {open ? createPortal(<div ref={popup} id={id} role="dialog" aria-label={label} className="settings-font-popover" style={position} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
      if (event.key === "Tab") close(true);
    }}>
      <FontPicker {...picker} presentation="choices" onSelectionChange={(next) => { picker.onSelectionChange(next); close(true); }} />
    </div>, document.body) : null}
  </>;
}

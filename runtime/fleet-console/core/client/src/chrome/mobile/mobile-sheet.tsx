import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";

import { useT } from "../../i18n/index.js";
import { MobileIcon } from "./mobile-icons.js";
import { openedByKeyboard } from "./mobile-input-modality.js";

const DRAG_START = 6;
const DRAG_CLOSE = 110;

/**
 * 하단 시트 공통 골격. 스크림·손잡이 끌어내리기·머리(제목 가운데, 오른쪽 닫기)·스크롤 본문·발을 소유하고,
 * 시트 종류마다 본문과 발만 채운다. 시트에서 다른 시트를 열면(`pushMobileSheet`) 쌓이고, 닫기·스크림·끌어내리기는
 * 앞 시트로 돌아간다 — 동작을 끝내는 버튼은 `closeMobileSheets`로 모두 닫는다.
 */
export function MobileSheet({ title, onClose, full = false, footer, children, className }: {
  readonly title: string;
  /** 닫기·스크림·끌어내리기·뒤로가 부른다. 호출자는 보통 `popMobileSheet`를 넘긴다. */
  readonly onClose: () => void;
  readonly full?: boolean;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const t = useT();
  const [leaving, setLeaving] = useState(false);
  const [dragY, setDragY] = useState<number | null>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; moved: boolean } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const panelRef = useRef<HTMLDivElement>(null);

  const finish = () => { setLeaving(true); window.setTimeout(() => closeRef.current(), 220); };

  // 열리면 첫 입력(없으면 첫 버튼)으로, 닫히면 연 손가락이 있던 곳으로 초점을 돌려 준다.
  // (뒤로 가기의 history 항목은 시트 하나하나가 아니라 호스트가 쌓인 시트 전체에 대해 하나만 든다.)
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // 입력칸은 터치로 열어도 포커스를 받는다(글을 쓰러 연 시트). 버튼으로는 키보드로 열었을 때만 옮긴다(PR-0c).
    const target = openedByKeyboard() ? "input, textarea, button:not(.mobile-sheet-close)" : "input, textarea";
    panelRef.current?.querySelector<HTMLElement>(target)?.focus({ preventScroll: true });
    return () => { opener?.focus?.({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); finish(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(delta) < DRAG_START) return;
    drag.moved = true;
    setDragY(Math.max(0, delta));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved && event.clientY - drag.startY > DRAG_CLOSE) { setDragY(null); finish(); return; }
    setDragY(null);
  };

  return (
    <>
      <div className={`mobile-sheet-scrim${leaving ? " is-leaving" : ""}`} onClick={finish} />
      <div
        ref={panelRef}
        className={`mobile-sheet${full ? " is-full" : ""}${leaving ? " is-leaving" : ""}${dragY !== null ? " is-dragging" : ""}${className ? ` ${className}` : ""}`}
        style={dragY !== null ? { transform: `translateY(${dragY}px)` } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mobile-sheet-handle" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}><i /></div>
        <div className="mobile-sheet-title">
          {title}
          <button type="button" className="mobile-sheet-close" onClick={finish} aria-label={t("mobile.sheet.close")}><MobileIcon name="x" size={20} /></button>
        </div>
        <div className="mobile-sheet-body">{children}</div>
        {footer ? <div className="mobile-sheet-foot">{footer}</div> : null}
      </div>
    </>
  );
}

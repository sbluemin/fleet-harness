import { useEffect, type RefObject } from "react";

/** 카드 안에서 Tab이 도는 대상. 비활성 단추·입력은 건너뛴다. */
const FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * 모달 카드의 키 계약 — Escape는 닫고, Tab은 카드 안을 돈다.
 *
 * 키는 document에서 받는다. 카드에 건 리스너는 포커스가 카드 안에 있을 때만 불리는데,
 * 보내는 동안 입력과 버튼이 비활성이 되면 브라우저가 포커스를 body로 옮긴다 — 그때
 * Escape가 죽고 Tab이 덫을 빠져나간다. 모달은 포커스가 어디 있든 닫혀야 한다.
 */
export function useModalCardKeys(cardRef: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const card = cardRef.current;
      if (card === null) return;
      const focusable = [...card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!card.contains(active) || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [cardRef, onClose]);
}

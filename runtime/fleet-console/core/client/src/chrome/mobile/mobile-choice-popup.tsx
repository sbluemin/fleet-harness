import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { pushBackLayer } from "./mobile-back.js";
import { closeMobileChoice, useMobileChoice, type MobileChoiceState } from "./mobile-choice-store.js";
import { MobileIcon } from "./mobile-icons.js";
import { pushOverlayHistory, releaseOverlayHistory } from "./mobile-overlay-history.js";

const EDGE = 12;

/**
 * 설정의 선택 팝업 — 목록 위에 뜨는 작은 판. 하위 화면 없이 현재값을 바로 고친다.
 * 열려 있는 동안 뒤로(하드웨어·브라우저·Esc)가 가장 먼저 이것을 닫는다.
 */
export function MobileChoicePopup() {
  const choice = useMobileChoice();
  return choice ? <ChoicePanel choice={choice} /> : null;
}

function ChoicePanel({ choice }: { readonly choice: MobileChoiceState }) {
  const { spec, anchor } = choice;
  const panelRef = useRef<HTMLDivElement>(null);
  const historyIdRef = useRef<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [top, setTop] = useState<number | null>(null);

  // 뒤로 레지스트리 + history 항목 하나 — 겹침 가운데 맨 위로 선다.
  useEffect(() => {
    const releaseLayer = pushBackLayer(() => closeMobileChoice());
    historyIdRef.current = pushOverlayHistory(() => { historyIdRef.current = null; closeMobileChoice(); });
    return () => {
      releaseLayer();
      if (historyIdRef.current !== null) { releaseOverlayHistory(historyIdRef.current); historyIdRef.current = null; }
    };
  }, []);

  // 연 컨트롤 바로 아래, 모자라면 위로. 컨트롤을 모르면 화면 가운데.
  useLayoutEffect(() => {
    const height = panelRef.current?.offsetHeight ?? 0;
    const limit = window.innerHeight - height - EDGE;
    if (!anchor) { setTop(Math.max(EDGE, Math.round((window.innerHeight - height) / 2))); return; }
    const below = anchor.bottom + 6;
    setTop(below <= limit ? below : Math.max(EDGE, Math.min(limit, anchor.top - height - 6)));
  }, [anchor, spec]);

  useEffect(() => {
    const selected = panelRef.current?.querySelector<HTMLButtonElement>("[aria-selected='true']:not(:disabled)") ?? panelRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    selected?.focus({ preventScroll: true });
  }, []);

  const finish = (after?: () => void) => {
    setLeaving(true);
    window.setTimeout(() => { closeMobileChoice(); after?.(); }, 100);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(); return; }
    const buttons = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (buttons.length === 0) return;
    const index = buttons.findIndex((button) => button === document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : -1;
    if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
  };

  return (
    <>
      <div className="mobile-menu-cover" onClick={() => finish()} />
      <div
        ref={panelRef}
        className={`mobile-choice${leaving ? " is-leaving" : ""}`}
        style={{ top: top ?? -9999 }}
        role="listbox"
        aria-label={spec.title}
        onKeyDown={onKeyDown}
      >
        {spec.options.map((option) => {
          const selected = option.value === spec.value;
          return (
            <button
              type="button"
              role="option"
              key={option.value}
              aria-selected={selected}
              disabled={option.disabled}
              onClick={() => finish(() => { if (!selected) spec.onSelect(option.value); })}
            >
              {option.icon ? <span className="mobile-choice-icon" aria-hidden="true">{option.icon}</span> : null}
              <span className="mobile-choice-copy">{option.label}{option.description ? <small>{option.description}</small> : null}</span>
              {selected ? <MobileIcon name="check" size={20} className="mobile-choice-check" /> : null}
            </button>
          );
        })}
      </div>
    </>
  );
}

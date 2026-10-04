import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { useT } from "../../i18n/index.js";
import { pushBackLayer } from "./mobile-back.js";
import { closeMobileChoice, useMobileChoice, type MobileChoiceState } from "./mobile-choice-store.js";
import { MobileIcon } from "./mobile-icons.js";
import { pushOverlayHistory, releaseOverlayHistory } from "./mobile-overlay-history.js";
import { showMobileToast } from "./mobile-toast.js";

/** 고른 뒤 닫기까지 — ✓가 그 행으로 옮겨 그려진 것을 보여 준다. */
const CLOSE_AFTER_PICK_MS = 120;
const LEAVE_MS = 150;

/**
 * 설정의 선택 팝업(P-1) — 스크림 위 가운데 카드. 하위 화면 없이 현재값을 바로 고친다.
 * 고르면 즉시 적용하고 ✓가 옮겨 그려진 뒤 닫는다. 바깥 탭·뒤로(하드웨어·브라우저)·Esc는 값을 그대로 두고 닫는다.
 */
export function MobileChoicePopup() {
  const choice = useMobileChoice();
  return choice ? <ChoiceCard choice={choice} /> : null;
}

function ChoiceCard({ choice }: { readonly choice: MobileChoiceState }) {
  const { spec } = choice;
  const t = useT();
  const titleId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const historyIdRef = useRef<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  // 고른 뒤 닫히기 전까지는 고른 값을 ✓로 보인다(저장이 늦어도 눈에 바로 반응).
  const [picked, setPicked] = useState<string | null>(null);
  const shown = picked ?? spec.value;
  const withIcons = spec.options.some((option) => option.icon);

  // 뒤로 레지스트리 + history 항목 하나 — 겹침 가운데 맨 위로 선다.
  useEffect(() => {
    const releaseLayer = pushBackLayer(() => closeMobileChoice());
    historyIdRef.current = pushOverlayHistory(() => { historyIdRef.current = null; closeMobileChoice(); });
    return () => {
      releaseLayer();
      if (historyIdRef.current !== null) { releaseOverlayHistory(historyIdRef.current); historyIdRef.current = null; }
    };
  }, []);

  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>("[aria-checked='true']:not(:disabled)")?.focus({ preventScroll: true });
  }, []);

  const finish = () => {
    setLeaving(true);
    window.setTimeout(() => closeMobileChoice(), LEAVE_MS);
  };

  const pick = (value: string) => {
    if (leaving) return;
    if (value !== spec.value) {
      setPicked(value);
      void Promise.resolve(spec.onSelect(value)).catch(() => showMobileToast(t("mobile.choice.failed")));
    }
    window.setTimeout(finish, CLOSE_AFTER_PICK_MS);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(); return; }
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (buttons.length === 0) return;
    const index = buttons.findIndex((button) => button === document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : -1;
    if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
  };

  return (
    <div className={`mobile-choice-scrim${leaving ? " is-leaving" : ""}`} onClick={() => finish()}>
      <div
        className="mobile-choice"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="mobile-choice-title">{spec.title}</h2>
        <div className="mobile-choice-list" role="radiogroup" aria-labelledby={titleId} ref={listRef}>
          {spec.options.map((option) => {
            const selected = option.value === shown;
            return (
              <button
                type="button"
                role="radio"
                key={option.value}
                aria-checked={selected}
                className={`mobile-choice-row${selected ? " is-selected" : ""}${option.description ? " has-description" : ""}`}
                disabled={option.disabled}
                onClick={() => pick(option.value)}
              >
                {withIcons ? <span className="mobile-choice-icon" aria-hidden="true">{option.icon ?? null}</span> : null}
                <span className="mobile-choice-copy">
                  <span className="mobile-choice-label" style={option.previewSize ? { fontSize: option.previewSize } : undefined}>{option.label}</span>
                  {option.description ? <small>{option.description}</small> : null}
                </span>
                {selected ? <MobileIcon name="check" size={22} className="mobile-choice-check" /> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

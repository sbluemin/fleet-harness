import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { MobileModelChoiceProps } from "@fleet-console/sdk/settings/browser";

import { useT } from "../../i18n/index.js";
import { pushBackLayer } from "./mobile-back.js";
import { closeMobileChoice, useMobileChoice, type MobileChoiceState } from "./mobile-choice-store.js";
import { MobileIcon } from "./mobile-icons.js";
import { openedByKeyboard } from "./mobile-input-modality.js";
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

/**
 * 스크림 + 카드 껍데기 — 뒤로 레지스트리·history 항목·Esc·방향키·초점 이동을 소유한다.
 * 닫기 요청(바깥 탭·뒤로·Esc)은 150ms 페이드 뒤 `onClosed`로 알린다. 안에서 닫을 때는 `requestClose`를 쓴다.
 */
function ChoiceShell({ title, titleId, onClosed, children, listRef, renderBody }: {
  readonly title: string;
  readonly titleId: string;
  readonly onClosed: () => void;
  readonly children?: ReactNode;
  readonly listRef: React.RefObject<HTMLDivElement | null>;
  readonly renderBody: (requestClose: () => void) => ReactNode;
}) {
  const historyIdRef = useRef<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;
  const leavingRef = useRef(false);

  const requestClose = () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    window.setTimeout(() => closedRef.current(), LEAVE_MS);
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  useEffect(() => {
    const releaseLayer = pushBackLayer(() => requestCloseRef.current());
    historyIdRef.current = pushOverlayHistory(() => { historyIdRef.current = null; requestCloseRef.current(); });
    return () => {
      releaseLayer();
      if (historyIdRef.current !== null) { releaseOverlayHistory(historyIdRef.current); historyIdRef.current = null; }
    };
  }, []);

  useEffect(() => {
    if (openedByKeyboard()) listRef.current?.querySelector<HTMLButtonElement>("[aria-checked='true']:not(:disabled), button:not(:disabled)")?.focus({ preventScroll: true });
  }, [listRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); requestClose(); return; }
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (buttons.length === 0) return;
    const index = buttons.findIndex((button) => button === document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : -1;
    if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
  };

  return (
    <div className={`mobile-choice-scrim${leaving ? " is-leaving" : ""}`} onClick={requestClose}>
      <div className="mobile-choice" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
        <h2 id={titleId} className="mobile-choice-title">{title}</h2>
        {renderBody(requestClose)}
        {children}
      </div>
    </div>
  );
}

function ChoiceCard({ choice }: { readonly choice: MobileChoiceState }) {
  const { spec } = choice;
  const t = useT();
  const titleId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  // 고른 뒤 닫히기 전까지는 고른 값을 ✓로 보인다(저장이 늦어도 눈에 바로 반응).
  const [picked, setPicked] = useState<string | null>(null);
  const shown = picked ?? spec.value;
  const withIcons = spec.options.some((option) => option.icon);

  return (
    <ChoiceShell
      title={spec.title}
      titleId={titleId}
      listRef={listRef}
      onClosed={closeMobileChoice}
      renderBody={(requestClose) => (
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
                onClick={() => {
                  if (option.value !== spec.value) {
                    setPicked(option.value);
                    void Promise.resolve(spec.onSelect(option.value)).catch(() => showMobileToast(t("mobile.choice.failed")));
                  }
                  window.setTimeout(requestClose, CLOSE_AFTER_PICK_MS);
                }}
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
      )}
    />
  );
}

/**
 * 모델 팝업(P-1 변형) — 제공자별 묶음, 구분선, 「추론 강도」 글자 탭. 모델을 골라도 열린 채다(강도까지 고르게).
 * 값은 `ModelPicker`가 다시 그려 줄 때마다 갱신된다. 닫기는 바깥 탭·뒤로·Esc다.
 */
export function MobileModelChoice({ title, groups, value, onSelect, effort, reset, onClose }: MobileModelChoiceProps) {
  const titleId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  return (
    <ChoiceShell
      title={title}
      titleId={titleId}
      listRef={listRef}
      onClosed={onClose}
      renderBody={(requestClose) => (
        <div className="mobile-choice-list" ref={listRef}>
          <div role="radiogroup" aria-labelledby={titleId}>
            {groups.map((group) => (
              <div key={group.key} role="presentation">
                <div className="mobile-choice-band">{group.icon ? <span className="mobile-choice-band-icon" aria-hidden="true">{group.icon}</span> : null}{group.label}</div>
                {group.options.map((option) => {
                  const selected = option.value === value;
                  return (
                    <button type="button" role="radio" key={option.value} aria-checked={selected} className={`mobile-choice-row${selected ? " is-selected" : ""}`} onClick={() => onSelect(option.value)}>
                      <span className="mobile-choice-copy"><span className="mobile-choice-label">{option.label}</span></span>
                      {option.meta ? <span className="mobile-choice-meta">{option.meta}</span> : null}
                      {selected ? <MobileIcon name="check" size={22} className="mobile-choice-check" /> : <span className="mobile-choice-check-slot" aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          {effort ? (
            <>
              <div className="mobile-choice-rule" role="separator" />
              <div className="mobile-choice-band" id={`${titleId}-effort`}>{effort.label}</div>
              <div className="mobile-choice-tabs" role="radiogroup" aria-labelledby={`${titleId}-effort`}>
                {effort.levels.map((level) => {
                  const on = level.value === effort.value;
                  return (
                    <button type="button" role="radio" key={level.value} aria-checked={on} className={`mobile-choice-tab${on ? " is-on" : ""}`} onClick={() => effort.onSelect(level.value)}>
                      {level.label}
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
          {reset ? (
            <>
              <div className="mobile-choice-rule" role="separator" />
              <button
                type="button"
                className={`mobile-choice-row${reset.description ? " has-description" : ""}`}
                onClick={() => { reset.onSelect(); window.setTimeout(requestClose, CLOSE_AFTER_PICK_MS); }}
              >
                <span className="mobile-choice-copy">
                  <span className="mobile-choice-label">{reset.label}</span>
                  {reset.description ? <small>{reset.description}</small> : null}
                </span>
              </button>
            </>
          ) : null}
        </div>
      )}
    />
  );
}

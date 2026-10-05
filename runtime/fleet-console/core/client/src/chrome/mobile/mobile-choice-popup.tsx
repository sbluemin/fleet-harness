import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { MobileCoordinateChoiceProps, MobileModelChoiceProps, MobileModelGroup } from "@fleet-console/sdk/settings/browser";
import { clampRosterEffort, findRosterRow, rosterRowEfforts } from "@fleet-console/sdk/models";
import { launchProviderCaption, launchProviderFromGroupId, launchProviderGlyph } from "@fleet-console/sdk/components/launch-provider-glyphs";

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

  // 터치로 열면 포커스가 팝업 안에 없다 — 연결된 키보드의 Esc도 닫히도록 문서에서 듣는다(PR-0c 뒤에도 Esc가 닿게).
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); requestCloseRef.current(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
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
/**
 * 코어 안에서만 쓰는 확장 — 고르는 것이 곧 확정인 탭이면 그 값을 알린 뒤 시트가 스스로 닫힌다(✓가 옮겨 그려진 뒤).
 * 좌표 시트가 「강도 탭 = 확정 + 닫힘」을 이 자리로 낸다. 호스트 계약(`MobileModelChoiceProps`)은 그대로다.
 */
type MobileModelChoiceInternalProps = MobileModelChoiceProps & {
  readonly closeAfterSelect?: (value: string) => boolean;
  readonly closeAfterEffort?: boolean;
};

export function MobileModelChoice({ title, groups, value, onSelect, effort, reset, onClose, closeAfterSelect, closeAfterEffort = false }: MobileModelChoiceInternalProps) {
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
                <div className="mobile-choice-band">{group.label}</div>
                {group.options.map((option) => {
                  const selected = option.value === value;
                  return (
                    <button type="button" role="radio" key={option.value} aria-checked={selected} className={`mobile-choice-row${selected ? " is-selected" : ""}`} onClick={() => { onSelect(option.value); if (closeAfterSelect?.(option.value)) window.setTimeout(requestClose, CLOSE_AFTER_PICK_MS); }}>
                      <span className="mobile-choice-copy"><span className="mobile-choice-label">{withoutGroupPrefix(option.label, group.label)}</span></span>
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
                    <button type="button" role="radio" key={level.value} aria-checked={on} className={`mobile-choice-tab${on ? " is-on" : ""}`} onClick={() => { effort.onSelect(level.value); if (closeAfterEffort) window.setTimeout(requestClose, CLOSE_AFTER_PICK_MS); }}>
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

const EXTRA_VALUE_PREFIX = "extra:";

function formatContextWindow(contextWindow: number | undefined): string | undefined {
  if (!contextWindow || contextWindow <= 0) return undefined;
  return contextWindow >= 1_000_000 ? "1M" : `${Math.round(contextWindow / 1000)}K`;
}

/**
 * 좌표 시트 — 모델 로스터를 모델 팝업의 문법(공급자 묶음 → 구분선 → 강도 탭)으로 편다. 강도 탭은 고른 행이 내놓는
 * 사다리 전체다. 로스터 밖 저장값은 「꺼짐」 묶음에 그대로 서고, 선택 방식(extras)은 맨 위 묶음이다.
 */
export function MobileCoordinateChoice({ title, roster, value, onSelect, effort, effortLabel, offLabel, extras, reset, onClose }: MobileCoordinateChoiceProps) {
  const row = findRosterRow(roster, value.model);
  const groups: MobileModelGroup[] = [];
  if (extras?.length) {
    groups.push({ key: "extras", label: "", options: extras.filter((extra) => !extra.disabled).map((extra) => ({ value: `${EXTRA_VALUE_PREFIX}${extra.id}`, label: extra.label, ...(extra.hint ? { meta: extra.hint } : {}) })) });
  }
  for (const group of roster) {
    const provider = launchProviderFromGroupId(group.id);
    groups.push({
      key: group.id,
      label: provider ? launchProviderCaption(provider) : group.label,
      ...(provider ? { icon: launchProviderGlyph(provider) } : {}),
      options: group.rows.map((candidate) => {
        const meta = formatContextWindow(candidate.contextWindow);
        return { value: candidate.launch.model ?? candidate.id, label: candidate.label, ...(meta ? { meta } : {}) };
      }),
    });
  }
  if (value.model && !row) groups.push({ key: "off", label: offLabel ?? "…", options: [{ value: value.model, label: value.model }] });
  const activeExtra = extras?.find((extra) => extra.active);
  const ladder = effort === "track" && row && !activeExtra ? rosterRowEfforts(row) : [];
  const currentEffort = clampRosterEffort(ladder, value.effort);
  // 강도 탭이 서지 않는 탭 — 선택 방식, 그리고 강도를 받지 않는 모델(또는 모델만 고르는 칸)의 모델 탭 — 은 고르는 것이 곧 확정이다.
  const settlesOnTap = (next: string): boolean => {
    if (next.startsWith(EXTRA_VALUE_PREFIX)) return true;
    const target = findRosterRow(roster, next);
    return effort !== "track" || !target || rosterRowEfforts(target).length === 0;
  };
  return (
    <MobileModelChoice
      title={title}
      groups={groups}
      value={activeExtra ? `${EXTRA_VALUE_PREFIX}${activeExtra.id}` : row?.launch.model ?? value.model ?? ""}
      onSelect={(next) => {
        if (next.startsWith(EXTRA_VALUE_PREFIX)) {
          extras?.find((extra) => `${EXTRA_VALUE_PREFIX}${extra.id}` === next)?.onPick();
          return;
        }
        const target = findRosterRow(roster, next);
        const nextEffort = target && effort === "track" ? clampRosterEffort(rosterRowEfforts(target), value.effort) : undefined;
        onSelect({ model: next, ...(nextEffort ? { effort: nextEffort } : {}) }, { final: settlesOnTap(next) });
      }}
      closeAfterSelect={settlesOnTap}
      closeAfterEffort
      {...(ladder.length > 0 && currentEffort && row ? {
        effort: {
          label: effortLabel,
          levels: (row.chips ?? []).map((chip) => ({ value: chip.id, label: chip.label })),
          value: currentEffort,
          onSelect: (next: string) => onSelect({ model: row.launch.model ?? row.id, effort: next }, { final: true }),
        },
      } : {})}
      {...(reset ? { reset } : {})}
      onClose={onClose}
    />
  );
}

/** 그룹 머리가 이미 공급자를 말하므로 모델 이름의 「Codex-」 같은 공급자 접두어는 뗀다(남는 것이 없으면 그대로 둔다). */
function withoutGroupPrefix(label: string, group: string): string {
  const prefix = `${group}-`;
  return label.length > prefix.length && label.toLowerCase().startsWith(prefix.toLowerCase()) ? label.slice(prefix.length) : label;
}

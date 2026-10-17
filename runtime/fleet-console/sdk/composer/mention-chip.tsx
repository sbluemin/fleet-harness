import type { ReactNode } from "react";

/**
 * 멘션 칩 — 받는 이 알약과 본문 속 참조 토큰이 같은 마크업을 쓴다.
 *
 * 구조만 소유한다. 외양은 호스트 `components.css`의 `.fc-mention-chip`이고, 아바타는
 * `-mark` 슬롯을 호출부가 채운다. 이 모듈은 상태를 두지 않는다. contenteditable 삽입은
 * React가 아니라 `mentionChipHtml` 문자열이다 — 실행 취소 기록에 들어가는 편집 명령이
 * HTML을 받기 때문이다. React `MentionChip`과 그 문자열은 같은 클래스·같은 자식 순서다.
 */

export const MENTION_CHIP_CLASS = "fc-mention-chip";
export const MENTION_CHIP_MARK_CLASS = "fc-mention-chip-mark";
export const MENTION_CHIP_LABEL_CLASS = "fc-mention-chip-label";
export const MENTION_CHIP_REMOVE_CLASS = "fc-mention-chip-x";

export interface MentionChipMarkup {
  /** `@`를 붙이기 전의 이름·제목. 잘림은 CSS가 하고, 여기에는 전체를 싣는다. */
  readonly label: string;
  /** 말풍선 툴팁. 없으면 `@` + label. */
  readonly title?: string;
  /** 아바타 슬롯. contenteditable 경로는 비워 두고 호스트가 나중에 채운다. 기본은 둔다. */
  readonly markSlot?: boolean;
  /** 있으면 ✕를 둔다. 접근 이름이지, 보이는 글자는 항상 ×다. */
  readonly removeLabel?: string;
  /** 루트에 더하는 속성. `class`는 무시한다. */
  readonly attributes?: Readonly<Record<string, string>>;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!);

function extraAttributes(attributes: MentionChipMarkup["attributes"]): string {
  return Object.entries(attributes ?? {})
    .filter(([key]) => /^[A-Za-z_:][\w:.-]*$/.test(key) && key.toLowerCase() !== "class")
    .map(([key, value]) => ` ${key}="${escapeHtml(value)}"`)
    .join("");
}

/** contenteditable `insertHTML`용. React `MentionChip`과 같은 뼈대다. */
export function mentionChipHtml(spec: MentionChipMarkup): string {
  const shown = `@${spec.label}`;
  const tip = spec.title ?? shown;
  const mark = spec.markSlot === false
    ? ""
    : `<span class="${MENTION_CHIP_MARK_CLASS}" aria-hidden="true">&#8203;</span>`;
  // ✕는 button이 아니다. contenteditable의 insertHTML이 폼 컨트롤을 버리는 브라우저가 있어, 같은 클래스의 span으로 둔다.
  const remove = spec.removeLabel
    ? `<span role="button" tabindex="0" class="${MENTION_CHIP_REMOVE_CLASS}" aria-label="${escapeHtml(spec.removeLabel)}">×</span>`
    : "";
  return `<span class="${MENTION_CHIP_CLASS}" title="${escapeHtml(tip)}"${extraAttributes(spec.attributes)}>${mark}<span class="${MENTION_CHIP_LABEL_CLASS}">${escapeHtml(shown)}</span>${remove}</span>`;
}

/** `mentionChipHtml`과 같은 마크업의 원소. 초안 복원처럼 DOM을 직접 세울 때 쓴다. */
export function mentionChipElement(doc: Document, spec: MentionChipMarkup): HTMLElement {
  const template = doc.createElement("template");
  template.innerHTML = mentionChipHtml(spec);
  const node = template.content.firstElementChild;
  if (!(node instanceof HTMLElement)) throw new Error("mention chip markup was empty");
  return node;
}

export interface MentionChipProps {
  readonly label: string;
  readonly title?: string;
  readonly mark?: ReactNode;
  readonly removeLabel?: string;
  readonly onRemove?: () => void;
  /** 있으면 루트가 버튼이다 — 기록 말풍선이 목표를 열 때. ✕와 함께 쓰지 않는다. */
  readonly onActivate?: () => void;
  readonly ariaLabel?: string;
}

/** 그룹 수신자 칩·기록 토큰. 인라인 contenteditable 토큰은 `mentionChipHtml`을 쓴다. */
export function MentionChip({ label, title, mark, removeLabel, onRemove, onActivate, ariaLabel }: MentionChipProps) {
  const shown = `@${label}`;
  const tip = title ?? shown;
  const body = (
    <>
      {mark !== undefined ? <span className={MENTION_CHIP_MARK_CLASS} aria-hidden="true">{mark}</span> : null}
      <span className={MENTION_CHIP_LABEL_CLASS}>{shown}</span>
      {removeLabel ? (
        <span
          role="button"
          tabIndex={0}
          className={MENTION_CHIP_REMOVE_CLASS}
          aria-label={removeLabel}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onRemove?.(); }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            onRemove?.();
          }}
        >
          ×
        </span>
      ) : null}
    </>
  );
  if (onActivate) {
    return (
      <button type="button" className={MENTION_CHIP_CLASS} title={tip} aria-label={ariaLabel ?? shown} onClick={(event) => { event.stopPropagation(); onActivate(); }}>
        {body}
      </button>
    );
  }
  return (
    <span className={MENTION_CHIP_CLASS} title={tip} {...(ariaLabel ? { "aria-label": ariaLabel } : {})}>
      {body}
    </span>
  );
}

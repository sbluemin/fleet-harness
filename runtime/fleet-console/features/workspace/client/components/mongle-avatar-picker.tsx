import { MONGLE_BASES, mongleBase, type MongleRole, type MongleState } from "../../shared/avatars.js";
import { IDENTITY_TONES, type IdentityTone } from "../../shared/identity-tones.js";
import { MongleAvatar } from "./mongle-avatar.js";

/**
 * 몽글 아바타 편집기 — 베이스 15종 격자, 색 8톤, 상태 미리보기, 다시 뽑기·처음 값으로·취소·적용.
 *
 * 제어형이다. 고르는 동안의 값과 저장은 호출부가 쥐고, 이 컴포넌트는 그리기와 누름만 알린다. 역할 특징(사령관 별·지휘관 안테나)은
 * 고르는 대상이 아니라 `role` 로 자동으로 얹힌다. 색을 고르면 격자 전체가 그 색으로 다시 칠해진다. 라벨은 호출부의 로케일이다.
 */

export interface MongleAvatarPickerLabels {
  readonly heading: string;
  readonly reroll: string;
  readonly reset: string;
  readonly preview: string;
  readonly cancel: string;
  readonly apply: string;
  readonly toneGroup: string;
  readonly baseGroup: string;
  readonly states: Readonly<Record<MongleAvatarPreviewState, string>>;
  readonly tones: Readonly<Record<IdentityTone, string>>;
}

export const MONGLE_PREVIEW_STATES = ["running", "awaiting", "unseen", "idle", "ended"] as const satisfies readonly MongleState[];
export type MongleAvatarPreviewState = (typeof MONGLE_PREVIEW_STATES)[number];

interface MongleAvatarPickerProps {
  readonly role: MongleRole;
  readonly base: number;
  readonly tone: IdentityTone | null;
  readonly previewState: MongleAvatarPreviewState;
  readonly locale: "en" | "ko";
  readonly labels: MongleAvatarPickerLabels;
  readonly dirty: boolean;
  readonly busy?: boolean;
  readonly onBase: (base: number) => void;
  readonly onTone: (tone: IdentityTone) => void;
  readonly onPreviewState: (state: MongleAvatarPreviewState) => void;
  readonly onReroll: () => void;
  readonly onReset: () => void;
  readonly onCancel: () => void;
  readonly onApply: () => void;
  readonly className?: string;
}

/** 베이스 15종 격자 — 고른 색으로 격자 전체를 칠한다. 편집기와 사령관 만들기 창이 함께 쓴다. */
export function MongleBaseGrid({ role, base, tone, locale, label, size = 34, onBase }: {
  readonly role: MongleRole;
  readonly base: number;
  readonly tone: IdentityTone | null;
  readonly locale: "en" | "ko";
  readonly label: string;
  readonly size?: number;
  readonly onBase: (base: number) => void;
}) {
  return (
    <div className="mongle-picker-bases" role="radiogroup" aria-label={label}>
      {MONGLE_BASES.map((preset) => {
        const name = preset.name[locale];
        return (
          <button key={preset.id} type="button" role="radio" aria-checked={preset.id === base} aria-label={name} title={name} className="mongle-picker-base" onClick={() => onBase(preset.id)}>
            <MongleAvatar base={preset.id} tone={tone} role={role} state="idle" size={size} label={name} decorative />
          </button>
        );
      })}
    </div>
  );
}

/** 색 8톤 점 — 아직 고르지 않았으면 베이스의 원래 색이 눌린 것으로 선다. */
export function MongleToneDots({ base, tone, label, names, onTone }: {
  readonly base: number;
  readonly tone: IdentityTone | null;
  readonly label: string;
  readonly names: Readonly<Record<IdentityTone, string>>;
  readonly onTone: (tone: IdentityTone) => void;
}) {
  const shownTone = tone ?? mongleBase(base).tone;
  return (
    <div className="mongle-picker-tones" role="radiogroup" aria-label={label}>
      {IDENTITY_TONES.map((key) => (
        <button key={key} type="button" role="radio" aria-checked={key === shownTone} aria-label={names[key]} title={names[key]} className={`mongle-picker-tone is-tone-${key}`} onClick={() => onTone(key)}>
          <i aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

/** 상태 미리보기 글자 줄 — 고른 상태를 그리는 큰 아바타는 호출부의 것이다. */
export function MonglePreviewStates({ previewState, label, states, onPreviewState, showLabel = true }: {
  readonly previewState: MongleAvatarPreviewState;
  readonly label: string;
  readonly states: Readonly<Record<MongleAvatarPreviewState, string>>;
  readonly onPreviewState: (state: MongleAvatarPreviewState) => void;
  readonly showLabel?: boolean;
}) {
  return (
    <div className="mongle-picker-preview">
      {showLabel ? <span className="mongle-picker-preview-label">{label}</span> : null}
      <span className="mongle-picker-states" role="radiogroup" aria-label={label}>
        {MONGLE_PREVIEW_STATES.map((state) => (
          <button key={state} type="button" role="radio" aria-checked={state === previewState} className="mongle-picker-state" onClick={() => onPreviewState(state)}>{states[state]}</button>
        ))}
      </span>
    </div>
  );
}

export function MongleAvatarPicker({ role, base, tone, previewState, locale, labels, dirty, busy = false, onBase, onTone, onPreviewState, onReroll, onReset, onCancel, onApply, className }: MongleAvatarPickerProps) {
  return (
    <div className={["mongle-picker", className].filter(Boolean).join(" ")} role="group" aria-label={labels.heading}>
      <div className="mongle-picker-head">
        <span className="mongle-picker-title">{labels.heading}</span>
        <span className="mongle-picker-links">
          <button type="button" className="mongle-picker-link" onClick={onReroll}>{labels.reroll}</button>
          <button type="button" className="mongle-picker-link" onClick={onReset}>{labels.reset}</button>
        </span>
      </div>
      <MongleBaseGrid role={role} base={base} tone={tone} locale={locale} label={labels.baseGroup} onBase={onBase} />
      <MongleToneDots base={base} tone={tone} label={labels.toneGroup} names={labels.tones} onTone={onTone} />
      <MonglePreviewStates previewState={previewState} label={labels.preview} states={labels.states} onPreviewState={onPreviewState} />
      <div className="mongle-picker-actions">
        <button type="button" className="fc-btn fc-btn--secondary mongle-picker-button" onClick={onCancel}>{labels.cancel}</button>
        <button type="button" className="fc-btn fc-btn--primary mongle-picker-button" disabled={!dirty || busy} onClick={onApply}>{labels.apply}</button>
      </div>
    </div>
  );
}

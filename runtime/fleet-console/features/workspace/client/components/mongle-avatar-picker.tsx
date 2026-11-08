import { isPromotedBaseId, MONGLE_BASES, mongleBase, PROMOTED_BASES, type MongleBase, type MongleRole, type MongleState } from "../../shared/avatars.js";
import { IDENTITY_TONES, type IdentityTone } from "../../shared/identity-tones.js";
import { MongleAvatar } from "./mongle-avatar.js";

/**
 * 몽글 아바타 편집기 — 베이스 15종 격자(사령관에게는 아래 「진급 사령관」 3종 줄이 더 선다), 색 8톤, 상태 미리보기, 다시 뽑기·처음 값으로·취소·적용.
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
  /** 사령관에게만 서는 진급 3종 줄의 이름. */
  readonly promotedGroup: string;
  /** 진급 캐릭터를 골랐을 때 색 점 아래에 서는 안내. */
  readonly toneLocked: string;
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

/**
 * 베이스 15종 격자 — 고른 색으로 격자 전체를 칠한다. 편집기와 사령관 만들기 창이 함께 쓴다.
 * `promotedLabel` 을 주면(사령관만) 격자 아래에 진급 사령관 3종 줄이 서고, 진급 캐릭터는 색 잠금 때문에 늘 시그니처 색으로 그려진다.
 */
export function MongleBaseGrid({ role, base, tone, locale, label, promotedLabel, size = 34, onBase }: {
  readonly role: MongleRole;
  readonly base: number;
  readonly tone: IdentityTone | null;
  readonly locale: "en" | "ko";
  readonly label: string;
  readonly promotedLabel?: string;
  readonly size?: number;
  readonly onBase: (base: number) => void;
}) {
  const cell = (preset: MongleBase, cellTone: IdentityTone | null) => {
    const name = preset.name[locale];
    return (
      <button key={preset.id} type="button" role="radio" aria-checked={preset.id === base} aria-label={name} title={name} className="mongle-picker-base" onClick={() => onBase(preset.id)}>
        <MongleAvatar base={preset.id} tone={cellTone} role={role} state="idle" size={size} label={name} decorative />
      </button>
    );
  };
  return (
    <>
      <div className="mongle-picker-bases" role="radiogroup" aria-label={label}>
        {MONGLE_BASES.map((preset) => cell(preset, tone))}
      </div>
      {promotedLabel !== undefined ? (
        <div className="mongle-picker-promoted">
          <span className="mongle-picker-promoted-label">{promotedLabel}</span>
          <div className="mongle-picker-bases is-promoted" role="radiogroup" aria-label={promotedLabel}>
            {PROMOTED_BASES.map((preset) => cell(preset, null))}
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * 색 8톤 점 — 아직 고르지 않았으면 베이스의 원래 색이 눌린 것으로 선다.
 * 진급 캐릭터를 골랐으면 색이 시그니처로 잠겨 점은 모두 비활성이고, 잠금 안내(`lockedLabel`)가 선다.
 */
export function MongleToneDots({ base, tone, label, names, lockedLabel, onTone }: {
  readonly base: number;
  readonly tone: IdentityTone | null;
  readonly label: string;
  readonly names: Readonly<Record<IdentityTone, string>>;
  readonly lockedLabel: string;
  readonly onTone: (tone: IdentityTone) => void;
}) {
  const locked = isPromotedBaseId(base);
  const shownTone = locked ? mongleBase(base).tone : tone ?? mongleBase(base).tone;
  return (
    <>
      <div className="mongle-picker-tones" role="radiogroup" aria-label={label} aria-disabled={locked || undefined}>
        {IDENTITY_TONES.map((key) => (
          <button key={key} type="button" role="radio" aria-checked={key === shownTone} aria-label={names[key]} title={names[key]} disabled={locked} className={`mongle-picker-tone is-tone-${key}`} onClick={() => onTone(key)}>
            <i aria-hidden="true" />
          </button>
        ))}
      </div>
      {locked ? <p className="mongle-picker-tone-locked" role="note">{lockedLabel}</p> : null}
    </>
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
      <MongleBaseGrid role={role} base={base} tone={tone} locale={locale} label={labels.baseGroup} promotedLabel={role === "commodore" ? labels.promotedGroup : undefined} onBase={onBase} />
      <MongleToneDots base={base} tone={tone} label={labels.toneGroup} names={labels.tones} lockedLabel={labels.toneLocked} onTone={onTone} />
      <MonglePreviewStates previewState={previewState} label={labels.preview} states={labels.states} onPreviewState={onPreviewState} />
      <div className="mongle-picker-actions">
        <button type="button" className="fc-btn fc-btn--secondary mongle-picker-button" onClick={onCancel}>{labels.cancel}</button>
        <button type="button" className="fc-btn fc-btn--primary mongle-picker-button" disabled={!dirty || busy} onClick={onApply}>{labels.apply}</button>
      </div>
    </div>
  );
}

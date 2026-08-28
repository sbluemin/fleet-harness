import * as React from "react";

import { Select } from "../react/browser.js";
import type { SettingsSectionDescriptor } from "./types.js";

export interface SettingsCardProps {
  readonly title?: React.ReactNode;
  readonly description?: string;
  readonly children: React.ReactNode;
}

export interface SettingsRowProps {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}

export interface SettingsToggleProps {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label?: string;
  readonly disabled?: boolean;
}

export interface SettingsSelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SettingsSelectProps {
  readonly value: string;
  readonly options: readonly SettingsSelectOption[];
  readonly onChange: (next: string) => void;
  readonly label?: string;
  readonly disabled?: boolean;
}

export interface SettingsFieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}

export interface SettingsSliderProps {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** 끌리는 동안 매 틱 호출된다 — 미리보기만 하고 저장하지 않는다. */
  readonly onPreview: (next: number) => void;
  /** 손을 뗄 때 한 번 호출된다 — 저장은 여기서만 일어난다. */
  readonly onCommit: (next: number) => void;
  readonly label: string;
  readonly formatValue: (value: number) => string;
  readonly decreaseLabel: string;
  readonly increaseLabel: string;
  readonly disabled?: boolean;
}

export function defineSettingsSection(descriptor: SettingsSectionDescriptor): SettingsSectionDescriptor {
  return descriptor;
}

export function ExperimentalBadge({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return <span className="experimental-badge">{children}</span>;
}

export type SettingsScopeKind = "live" | "restart" | "sessions";

/**
 * 한 설정이 언제 효력을 갖는지 말하는 칩. 저장 위치와 적용 시점은 설정마다 한 번,
 * 이 한 모양으로만 말한다 — 카드마다 다른 문장으로 되풀이하면 서로 어긋나기 시작한다.
 * 문구는 호출자가 자기 카탈로그에서 가져온다(코어는 en/ko, 플러그인은 자기 로케일).
 */
export function SettingsScope({ kind, label }: { readonly kind: SettingsScopeKind; readonly label: string }): React.ReactElement {
  return (
    <span className={`settings-scope is-${kind}`}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

export function SettingsCard({ title, description, children }: SettingsCardProps): React.ReactElement {
  return (
    <section className="fc-settings-card">
      {title ? <h3 className="fc-settings-card__title">{title}</h3> : null}
      {description ? <p className="fc-settings-card__desc">{description}</p> : null}
      <div className="fc-settings-card__body">{children}</div>
    </section>
  );
}

export function SettingsRow({ label, hint, children }: SettingsRowProps): React.ReactElement {
  const labelId = React.useId();
  const hintId = React.useId();
  return (
    <div className="fc-settings-row" role="group" aria-labelledby={labelId} aria-describedby={hint ? hintId : undefined}>
      <div className="fc-settings-row__copy">
        <div className="fc-settings-row__label" id={labelId}>{label}</div>
        {hint ? <div className="fc-settings-row__hint" id={hintId}>{hint}</div> : null}
      </div>
      <div className="fc-settings-row__control">{children}</div>
    </div>
  );
}

/**
 * 켬/끔은 콘솔 전체에서 이 한 모양으로만 말한다. 이전에는 플러그인 SDK가 자기 iOS형 스위치를
 * aurora로 칠하고, 코어의 리퀴드 글래스는 맨 체크박스를 쓰고, 원격 접속은 또 다른 스위치를 써서
 * 같은 뜻이 한 화면에서 세 모양으로 갈렸다. 켜짐은 선택이자 위치이므로 brass가 칠하고,
 * 신호 토큰(aurora/warn/coral)은 상태를 말하는 자리에만 남는다.
 */
export function SettingsToggle({ checked, onChange, label, disabled = false }: SettingsToggleProps): React.ReactElement {
  const id = React.useId();
  return (
    <label className="fc-settings-toggle" htmlFor={id}>
      <input
        id={id}
        className="fc-settings-toggle__input"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label ? undefined : "Toggle setting"}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="settings-switch fc-settings-toggle__control" aria-hidden="true">
        <span className="settings-switch-knob" />
      </span>
      {label ? <span className="fc-settings-toggle__label">{label}</span> : null}
    </label>
  );
}

export function SettingsSelect({ value, options, onChange, label, disabled = false }: SettingsSelectProps): React.ReactElement {
  const labelId = React.useId();
  const selectOptions = options.map((option) => ({ value: option.value, label: option.label }));
  const control = (
    <Select
      value={value}
      options={selectOptions}
      onChange={onChange}
      disabled={disabled}
      label={label ? undefined : "Select setting"}
      aria-labelledby={label ? labelId : undefined}
    />
  );
  return label ? (
    <label className="fc-settings-select">
      <span className="fc-settings-select__label" id={labelId}>{label}</span>
      {control}
    </label>
  ) : (
    <div className="fc-settings-select">{control}</div>
  );
}

/**
 * 연속값을 고르는 하나의 문법. 코어의 터미널·UI 글꼴 크기가 쓰는 −/슬라이더/+ 조합을 그대로
 * 플러그인에 연다 — 같은 조작이 표면마다 다른 물건으로 보이면 한쪽만 고쳐지는 날이 온다.
 * 트랙과 손잡이는 코어의 공유 `.fleet-slider`가 그리고, 채움 비율만 `--slider-fill`로 싣는다.
 *
 * 저장 시점이 이 컴포넌트의 계약이다. 끌리는 동안에는 onPreview만 부르고 손을 뗄 때(pointerup·
 * keyup·blur) onCommit을 한 번 부른다. 매 틱 저장하면 플러그인 설정 문서가 통째로 초당 수십 번
 * 다시 쓰이고, 진행 중인 쓰기끼리 롤백이 엇갈려 앞선 저장을 되돌린다.
 */
export function SettingsSlider({
  value,
  min,
  max,
  step,
  onPreview,
  onCommit,
  label,
  formatValue,
  decreaseLabel,
  increaseLabel,
  disabled = false,
}: SettingsSliderProps): React.ReactElement {
  const clamp = (next: number): number => Math.max(min, Math.min(max, next));
  const read = (event: React.SyntheticEvent<HTMLInputElement>): number =>
    clamp(Number(event.currentTarget.value));
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;

  // 한 번의 조작이 pointerup·keyup·blur를 잇달아 낸다. 소비처마다 중복을 걸러 내게 두면
  // 저마다 다르게 걸러 내므로, 같은 값을 두 번 저장하지 않는 책임은 이 컨트롤이 진다.
  const lastCommittedRef = React.useRef(value);
  const dirtyRef = React.useRef(false);
  const commit = (next: number, deliberate = false): void => {
    if (!deliberate && !dirtyRef.current && next === lastCommittedRef.current) return;
    lastCommittedRef.current = next;
    dirtyRef.current = false;
    onCommit(next);
  };

  return (
    <div className="fc-settings-slider">
      <button
        type="button"
        className="fc-settings-slider__stepper"
        disabled={disabled || value <= min}
        aria-label={decreaseLabel}
        onClick={() => commit(clamp(value - step), true)}
      >
        −
      </button>
      <input
        className="fleet-slider fc-settings-slider__range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={formatValue(value)}
        style={{ "--slider-fill": `${fill}%` } as React.CSSProperties}
        onChange={(event) => {
          dirtyRef.current = true;
          onPreview(read(event));
        }}
        onPointerUp={(event) => commit(read(event))}
        // 값을 움직이는 키에서만 저장한다 — Tab·Shift·Escape의 keyup까지 받으면 값이 그대로인
        // 채로 설정을 다시 쓴다.
        onKeyUp={(event) => {
          if (VALUE_KEYS.has(event.key)) commit(read(event));
        }}
        onBlur={(event) => commit(read(event))}
      />
      <button
        type="button"
        className="fc-settings-slider__stepper"
        disabled={disabled || value >= max}
        aria-label={increaseLabel}
        onClick={() => commit(clamp(value + step), true)}
      >
        +
      </button>
      {/* 값은 range 가 aria-valuetext 로 이미 읽어 준다. output 은 role=status(라이브 영역)라
          그대로 두면 한 번 움직일 때마다 같은 값을 두 번 말한다 — 눈으로만 읽는 표시로 남긴다. */}
      <output className="fc-settings-slider__value" aria-hidden="true">{formatValue(value)}</output>
    </div>
  );
}

const VALUE_KEYS = new Set([
  "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp",
  "End", "Home", "PageDown", "PageUp",
]);

export function SettingsField({ label, hint, children }: SettingsFieldProps): React.ReactElement {
  const labelId = React.useId();
  const hintId = React.useId();
  return (
    <div className="fc-settings-field" role="group" aria-labelledby={labelId} aria-describedby={hint ? hintId : undefined}>
      <div className="fc-settings-field__label" id={labelId}>
        {label}
      </div>
      {hint ? <div className="fc-settings-field__hint" id={hintId}>{hint}</div> : null}
      <div className="fc-settings-field__control">
        {children}
      </div>
    </div>
  );
}

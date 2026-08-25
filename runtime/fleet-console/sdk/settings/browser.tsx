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

import * as React from "react";

import type { SettingsSectionDescriptor } from "./types.js";

export interface SettingsCardProps {
  readonly title?: string;
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
      <span className="fc-settings-toggle__control" aria-hidden="true" />
      {label ? <span className="fc-settings-toggle__label">{label}</span> : null}
    </label>
  );
}

export function SettingsSelect({ value, options, onChange, label, disabled = false }: SettingsSelectProps): React.ReactElement {
  const id = React.useId();
  const select = (
    <select
      id={id}
      className="fc-settings-select__control"
      value={value}
      disabled={disabled}
      aria-label={label ? undefined : "Select setting"}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
  return label ? (
    <label className="fc-settings-select" htmlFor={id}>
      <span className="fc-settings-select__label">{label}</span>
      {select}
    </label>
  ) : (
    <div className="fc-settings-select">{select}</div>
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

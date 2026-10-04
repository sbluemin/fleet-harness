import type { ReactNode } from "react";

import "./settings-mobile.css";

/**
 * Settings pieces in the mobile grammar (impl-spec S-02, S-48): group rows, radio rows and the
 * 44×26 switch. The desktop controls — boxed effort selectors, help chips, the desktop toggle —
 * are not shown on a phone; these carry the same state through the same save paths.
 */

export function MobileSwitch({ checked, busy, disabled, label, onChange }: {
  readonly checked: boolean;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      className={`settings-mobile-switch${checked ? " is-on" : ""}`}
      onClick={(event) => { event.stopPropagation(); onChange(!checked); }}
    >
      <i aria-hidden="true" />
    </button>
  );
}

/** A row whose whole face flips its switch, so the target is the row and not a 44px knob. */
export function MobileToggleRow({ title, sub, checked, busy, disabled, onChange, trailing }: {
  readonly title: string;
  readonly sub?: ReactNode;
  readonly checked: boolean;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly onChange: (next: boolean) => void;
  readonly trailing?: ReactNode;
}) {
  return (
    <div className={`mobile-group-row settings-mobile-toggle-row${sub ? " is-two" : ""}${disabled ? " is-dim" : ""}`} onClick={() => { if (!disabled && !busy) onChange(!checked); }}>
      <span className="mobile-group-row-copy">{title}{sub ? <small>{sub}</small> : null}</span>
      {trailing}
      <MobileSwitch checked={checked} busy={busy} disabled={disabled} label={title} onChange={onChange} />
    </div>
  );
}

export function MobileRadioRow({ checked, label, sub, lead, disabled, onSelect }: {
  readonly checked: boolean;
  readonly label: string;
  readonly sub?: string;
  readonly lead?: ReactNode;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button type="button" role="radio" aria-checked={checked} className={`mobile-group-row${sub ? " is-two" : ""}${disabled ? " is-dim" : ""}`} disabled={disabled} onClick={onSelect}>
      <span className={`mobile-radio${checked ? " is-on" : ""}`} aria-hidden="true" />
      {lead}
      <span className="mobile-group-row-copy">{label}{sub ? <small>{sub}</small> : null}</span>
    </button>
  );
}

/** The muted label above a group (S-02 `.glab`). */
export function MobileGroupLabel({ children }: { readonly children: ReactNode }) {
  return <p className="settings-mobile-glab">{children}</p>;
}

import type { ReactNode } from "react";

import "./settings-mobile.css";

/**
 * Pieces of the mobile grammar that the SDK settings kit does not cover: radio rows and the group
 * label inside a mobile sheet (impl-spec S-16). Settings sections themselves use the SDK parts,
 * which the mobile settings host draws.
 */

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

import type { ReactNode } from "react";

import { resolveLocalizedText } from "@fleet-console/i18n/translate";
import type { OperationClusterRowMark } from "../../../../../features/objectives/shared/operation-clusters.js";

import { useConsoleLocale } from "../../i18n/index.js";

/** 줄 열기와 맡김 표식은 나란한 누름 자리다 — 버튼 안에 버튼을 넣지 않고, 꺼진 표식도 터치에서 늘 보인다. */
export function MobileMarkedRow({ mark, children }: { readonly mark?: OperationClusterRowMark; readonly children: ReactNode }) {
  return mark ? <div className="mobile-marked-row">{children}<MobileRowMark mark={mark} /></div> : children;
}

function MobileRowMark({ mark }: { readonly mark: OperationClusterRowMark }) {
  const locale = useConsoleLocale();
  const toggle = mark.toggle;
  const glyph = mark.renderGlyph?.();
  const label = resolveLocalizedText(mark.label, locale);
  const active = toggle?.pressed ?? true;
  const className = ["mobile-cluster-mark", glyph ? "has-glyph" : "", active ? `is-${mark.square}` : "is-off", active && mark.emphasized ? "is-emphasized" : ""].filter(Boolean).join(" ");
  const icon = <i className={className} aria-hidden="true">{glyph}</i>;
  return toggle ? (
    <button
      type="button"
      data-press="r1"
      className="mobile-row-mark"
      aria-pressed={toggle.pressed}
      aria-label={resolveLocalizedText(toggle.label, locale)}
      title={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (event.detail > 1) return;
        toggle.onToggle(locale);
      }}
      onKeyDown={(event) => {
        if (event.code === "Space") event.stopPropagation();
        if ((event.key === "Enter" || event.key === " ") && event.repeat) event.preventDefault();
      }}
    >{icon}</button>
  ) : <span className="mobile-row-mark" role="img" aria-label={label} title={label}>{icon}</span>;
}

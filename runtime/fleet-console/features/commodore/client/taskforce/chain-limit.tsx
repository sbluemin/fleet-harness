import { useMemo } from "react";
import { createPortal } from "react-dom";
import { MenuCheckGlyph, useSelect } from "@fleet-console/ui/react";
import { SettingsRow } from "../../../settings/client/preferences-context.js";
import { TASKFORCE_CHAIN_LIMITS, type TaskforceChainLimit } from "../../shared/contracts/taskforce.js";
import { taskforceT } from "./i18n.js";

const keyOf = (limit: TaskforceChainLimit) => limit === null ? "none" as const : `${limit}` as const;

/**
 * 논의 턴 상한 — 세부 정보의 멤버 섹션 아래 한 줄. 사령관 설정의 「사령관 모델」 줄과 같은
 * 문법(제목·설명 + 오른쪽 행 값 드롭다운)이다. 고르는 즉시 저장한다. 저장 중에도 막지 않는다 —
 * 막으면 고른 직후 초점이 트리거에서 빠진다. 겹친 선택은 부르는 쪽이 거른다.
 */
export function TaskforceChainLimitRow({ value, language, onChange }: { readonly value: TaskforceChainLimit; readonly language: "ko" | "en"; readonly onChange: (limit: TaskforceChainLimit) => void }) {
  const t = taskforceT(language);
  const options = useMemo(() => TASKFORCE_CHAIN_LIMITS.map((limit) => ({ value: keyOf(limit), label: t(`taskforce.chainLimit.${keyOf(limit)}`) })), [language]);
  const select = useSelect({
    value: keyOf(value),
    options,
    compact: true,
    onChange: (key) => { const next = TASKFORCE_CHAIN_LIMITS.find((limit) => keyOf(limit) === key); if (next !== undefined && next !== value) onChange(next); },
  });
  const label = t("taskforce.chainLimit");
  return <section className="objectives-commodore-settings taskforce-chain-limit">
    <SettingsRow label={label} hint={t("taskforce.chainLimitHint")}>
      <div {...select.rootProps} className={`${select.rootProps.className} fc-select--compact`}>
        <button {...select.triggerProps} className="fc-row-value" aria-label={label}><span className="fc-row-value-text">{options.find((option) => option.value === keyOf(value))?.label}</span></button>
        {select.isOpen ? createPortal(<ul {...select.listboxProps} aria-label={label}>{options.map((option, index) => <li key={option.value} {...select.getOptionProps(index)} className="fc-select__option">{option.label}<MenuCheckGlyph className="fc-select__check" size={14} /></li>)}</ul>, document.body) : null}
      </div>
    </SettingsRow>
  </section>;
}

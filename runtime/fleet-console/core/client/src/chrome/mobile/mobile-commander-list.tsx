import { useId, useState } from "react";

import { CommodoreRecentActions } from "../../../../../features/commodore/client/commodore-trail.js";
import { SORTS, activityOf, setSort, useSortPreference, type SortPreference } from "../../../../../features/workspace/client/commander-tab/commander-sort.js";
import { commanderObjectiveId } from "../../../../../features/workspace/client/objective-clusters.js";
import { ClusterRowAvatar, ClusterRowProgress, clusterRowSummary, type SideBarRowItem } from "../../../../../features/workspace/client/sidebar/side-bar-cluster-row.js";
import { useConsoleLocale, useT } from "../../i18n/index.js";
import { focusObjective } from "../../integration/store.js";
import { useConversationTime } from "./mobile-conversation-row.js";
import { MobileIcon } from "./mobile-icons.js";
import { MobileMarkedRow } from "./mobile-row-mark.js";
import { MobileSheet } from "./mobile-sheet.js";
import { pushMobileSheet, setMobileDestination } from "./mobile-store.js";

type Leave = (run: () => void) => void;

/** 첫 탭은 고르기, 펼친 행의 버튼은 열기 — 시작 전·진행 중·완료가 같은 목록에 선다. */
export function MobileCommanderList({ commodoreId, rows, leave, hasAttention }: {
  readonly commodoreId: string;
  readonly rows: {
    readonly sorted: readonly SideBarRowItem[];
    readonly sections: readonly { readonly id: string; readonly title: string | null; readonly rows: readonly SideBarRowItem[] }[];
    readonly preference: SortPreference;
  };
  readonly leave: Leave;
  readonly hasAttention: boolean;
}) {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const { sorted, sections, preference } = rows;
  const current = SORTS.find((sort) => sort.key === preference.key) ?? SORTS[0]!;
  return (
    <section className="mobile-commander-list" aria-label={t("commanderTab.aria")}>
      <div className="mobile-commander-bar">
        <span>{t("commanderTab.count", { count: sorted.length })}</span>
        <button type="button" className="mobile-pill-secondary" aria-haspopup="dialog" onClick={() => pushMobileSheet({ kind: "custom", render: (dismiss) => <CommanderSortSheet onClose={dismiss} /> })}>
          {t("commanderTab.sort.button", { label: t(current.label) })}<MobileIcon name="down" size={14} />
        </button>
        <button type="button" className="mobile-commander-direction" aria-label={t(preference.direction === "asc" ? "commanderTab.sort.ascending" : "commanderTab.sort.descending")} onClick={() => setSort({ ...preference, direction: preference.direction === "asc" ? "desc" : "asc" })}>
          <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><path d={preference.direction === "asc" ? "M8 13V3M8 3 4.5 6.5M8 3l3.5 3.5" : "M8 3v10M8 13l-3.5-3.5M8 13l3.5-3.5"} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      {sorted.length === 0 && !hasAttention ? <p className="mobile-conv-empty-note">{t("mobile.commodore.sessions.empty")}</p> : null}
      {sections.map((section) => <section key={section.id}>
        {section.title !== null ? <h3 className="mobile-conv-section"><span>{section.title}</span><span>{section.rows.length}</span></h3> : null}
        <ol className="mobile-commander-rows">
          {section.rows.map((item) => <CommanderRow key={item.layout.cluster.id} item={item} commodoreId={commodoreId} selected={selected === item.layout.cluster.id} onSelect={() => setSelected(selected === item.layout.cluster.id ? null : item.layout.cluster.id)} leave={leave} />)}
        </ol>
      </section>)}
    </section>
  );
}

function CommanderRow({ item, commodoreId, selected, onSelect, leave }: { readonly item: SideBarRowItem; readonly commodoreId: string; readonly selected: boolean; readonly onSelect: () => void; readonly leave: Leave }) {
  const t = useT();
  const language = useConsoleLocale();
  const time = useConversationTime();
  const detailId = useId();
  const { layout, row } = item;
  const { state, label, decisionNote, handlingStatus, conversationLine } = clusterRowSummary(item, language, t);
  const activity = activityOf(item);
  const objectiveId = commanderObjectiveId(layout.cluster);
  const open = () => leave(() => {
    // 뿌리 없는 목표는 시작 화면으로 — 가짜 세션 id로 focus하지 않는다.
    if (!layout.cluster.root) { layout.cluster.open?.(); return; }
    setMobileDestination({ kind: "home" });
    focusObjective(layout.cluster.root);
  });
  return <li className={`mobile-commander-item${selected ? " is-selected" : ""}`} data-cluster-row-id={layout.cluster.id}>
    <MobileMarkedRow mark={row.mark}>
      <button type="button" data-press="r1" className="mobile-conv-row" aria-expanded={selected} aria-controls={selected ? detailId : undefined} aria-description={decisionNote || undefined} onClick={onSelect}>
        <span className="mobile-conv-row-av"><ClusterRowAvatar item={item} rowState={state} label={label} size={40} decorative /></span>
        <span className="mobile-conv-row-copy">
          <span className="mobile-conv-row-top"><span className="mobile-conv-row-title">{layout.cluster.title}</span>{activity !== undefined ? <time className="mobile-conv-row-aside" dateTime={new Date(activity).toISOString()}>{time(activity)}</time> : null}</span>
          <span className="mobile-commander-line">
            <span className={`mobile-conv-state is-${row.decisionRequestedAt !== undefined ? "awaiting" : state}${handlingStatus ? " is-handling" : ""}`}>{conversationLine}</span>
            <ClusterRowProgress progress={row.progress} />
          </span>
        </span>
      </button>
    </MobileMarkedRow>
    {selected ? <div id={detailId} className="mobile-commander-detail">
      {/* reveal 신호는 폰의 사령관 대화로 이동하지 않는다 — 여기서는 누를 수 없는 최근 기록이다. */}
      {objectiveId !== null ? <CommodoreRecentActions commodoreId={commodoreId} objectiveId={objectiveId} language={language} /> : null}
      <button type="button" data-press="r3" className="mobile-pill" onClick={open}>{t("mobile.commodore.sessions.open")}<MobileIcon name="right" size={16} /></button>
    </div> : null}
  </li>;
}

function CommanderSortSheet({ onClose }: { readonly onClose: () => void }) {
  const t = useT();
  const preference = useSortPreference();
  const name = useId();
  return <MobileSheet title={t("commanderTab.sort.menu")} ariaLabel={t("commanderTab.sort.menu")} onClose={onClose} focusInputOnTouch={false} className="mobile-commander-sort">
    <div role="radiogroup" aria-label={t("commanderTab.sort.menu")}>
      {SORTS.map((sort) => <label key={sort.key} className="mobile-sheet-row mobile-commander-sort-option">
        <span>{t(sort.label)}</span>
        <input type="radio" name={name} checked={sort.key === preference.key} onChange={() => setSort({ ...preference, key: sort.key, direction: sort.direction })} />
        <span className="mobile-commander-sort-check" aria-hidden="true">{sort.key === preference.key ? <MobileIcon name="check" size={20} /> : null}</span>
      </label>)}
    </div>
    <hr />
    <button type="button" className="mobile-sheet-row" role="switch" aria-checked={preference.answerFirst} onClick={() => setSort({ ...preference, answerFirst: !preference.answerFirst })}>
      {t("commanderTab.sort.answerFirst")}<span aria-hidden="true" className={`mobile-switch${preference.answerFirst ? " is-on" : ""}`} />
    </button>
    <button type="button" className="mobile-sheet-row" role="switch" aria-checked={preference.grouped} onClick={() => setSort({ ...preference, grouped: !preference.grouped })}>
      {t("commanderTab.sort.grouped")}<span aria-hidden="true" className={`mobile-switch${preference.grouped ? " is-on" : ""}`} />
    </button>
  </MobileSheet>;
}

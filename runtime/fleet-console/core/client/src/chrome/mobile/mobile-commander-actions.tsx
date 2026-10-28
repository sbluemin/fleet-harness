import { createContext, useContext } from "react";

import type { SideBarRowItem } from "../../../../../features/workspace/client/sidebar/side-bar-cluster-row.js";
import { useT } from "../../i18n/index.js";
import { archiveObjectiveFromUi, type ArchiveOutcome } from "../../integration/objective-actions.js";
import { mobileObjectiveActions } from "./mobile-objective-menu.js";
import { openMobileInput } from "./mobile-input-sheet.js";
import { MobileSheet } from "./mobile-sheet.js";
import { runAfterSheetRelease } from "./mobile-sheet-host.js";
import { pushMobileSheet } from "./mobile-store.js";
import { rememberArchivedTitle } from "./mobile-toast.js";

/** 앱의 보관 결과·되돌리기 경로를 목록과 시트에도 건넨다. */
export const MobileArchiveOutcomeContext = createContext<((outcome: ArchiveOutcome) => void) | null>(null);

export function useMobileCommanderActions(): (item: SideBarRowItem) => void {
  const t = useT();
  const onArchived = useContext(MobileArchiveOutcomeContext);
  return (item) => {
    const objective = item.anchor?.objectiveRecord;
    const rename = objective ? () => pushMobileSheet({ kind: "rename", objectiveId: objective.id })
      : item.row.rename ? () => openMobileInput({ title: t("mobile.sheet.rename.title"), value: item.layout.cluster.title, onSave: item.row.rename! }) : undefined;
    const archive = objective && onArchived ? () => {
      rememberArchivedTitle(objective.id, objective.title);
      void archiveObjectiveFromUi(objective.id).then((outcome) => { if (outcome) onArchived(outcome); });
    } : item.row.archive;
    const items = mobileObjectiveActions({ t, onRename: rename, onArchive: archive });
    pushMobileSheet({ kind: "custom", render: (close) => (
      <MobileSheet title={item.layout.cluster.title} ariaLabel={t("mobile.bar.objectiveRecordMenu")} onClose={close} focusInputOnTouch={false}>
        {items.map((action) => <button type="button" key={action.id} className="mobile-sheet-row" disabled={action.disabled} onClick={() => runAfterSheetRelease(action.run)}>
          <span className="mobile-sheet-row-glyph">{action.icon}</span><span>{action.label}</span>
        </button>)}
      </MobileSheet>
    ) });
  };
}

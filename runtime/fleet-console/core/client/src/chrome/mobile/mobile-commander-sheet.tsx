import { useT } from "../../i18n/index.js";
import { useConsoleState } from "../../hooks/use-store.js";
import { focusObjective, openMobileNewSession } from "../../integration/store.js";
import { CommanderListOwner, CommodoreCommanderList } from "../../../../../features/workspace/client/commander-tab/commander-list.js";
import { openCommodoreMobile } from "../../../../../features/commodore/client/commodore-state.js";
import { openLedger } from "../../../../../features/execution/client/agent/chat/group/index.js";
import { MobileSheet } from "./mobile-sheet.js";
import { pushMobileSheet, setMobileDestination, useMobileDestination } from "./mobile-store.js";
import { runAfterSheetRelease } from "./mobile-sheet-host.js";

/** 폰은 레일 대신 머리 제목에서 같은 명단을 연다. 시트 history가 걷힌 뒤 목적지를 바꾼다. */
export function openMobileCommanderSheet(commodoreId: string): void {
  pushMobileSheet({ kind: "custom", render: (close) => <MobileCommanderSheet commodoreId={commodoreId} onClose={close} /> });
}

function MobileCommanderSheet({ commodoreId, onClose }: { readonly commodoreId: string; readonly onClose: () => void }) {
  const t = useT();
  const state = useConsoleState();
  const destination = useMobileDestination();
  const selectedId = destination.kind === "plugin" ? null : state.objectiveRecords.find((record) => record.id === state.activeObjectiveId && record.commodoreId === commodoreId)?.id ?? null;
  return <MobileSheet title={t("commanderTab.aria")} onClose={onClose} className="mobile-commander-sheet" focusInputOnTouch={false}>
    <CommanderListOwner commodoreId={commodoreId} selected={selectedId === null} onSelect={() => runAfterSheetRelease(() => openCommodoreMobile("log", commodoreId))} />
    <div className="commander-list-rule" role="separator" />
    <CommodoreCommanderList commodoreId={commodoreId} selectedId={selectedId}
      onNewSession={() => runAfterSheetRelease(() => openMobileNewSession(commodoreId))}
      onSelect={(item) => runAfterSheetRelease(() => {
        const root = item.layout.cluster.root;
        if (!root) { item.layout.cluster.open?.(); return; }
        openLedger(root, null);
        setMobileDestination({ kind: "home" });
        focusObjective(root);
      })}
    />
  </MobileSheet>;
}

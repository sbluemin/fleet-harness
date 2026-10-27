import { useMemo } from "react";
import { commodoreSectionLabel, useCommodoreList } from "../../../../features/commodore/client/commodore-list.js";
import { ArchiveSheet, type ArchiveSheetDeps } from "../../../../features/workspace/client/archive/archive-sheet.js";
import { useT } from "../i18n/index.js";

/** 사령관 기능의 목록을 workspace 보관함의 표시 전용 포트에 연결한다. */
export function ArchiveSheetHost() {
  const commodores = useCommodoreList();
  const t = useT();
  const deps = useMemo<ArchiveSheetDeps>(() => ({
    commodores: commodores.map((owner) => ({
      commodoreId: owner.commodoreId,
      label: commodoreSectionLabel(owner, t("archive.unknownCommodore", { id: owner.commodoreId.slice(0, 8) })),
      theaters: owner.theaters,
    })),
  }), [commodores, t]);
  return <ArchiveSheet deps={deps} />;
}

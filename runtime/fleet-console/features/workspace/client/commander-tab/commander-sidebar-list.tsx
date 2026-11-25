import { selectBrowserSpaceForCommodore } from "../../../browser/client/browser-surface.js";
import { commanderObjectiveId } from "../objective-clusters.js";
import { CommodoreCommanderList } from "./commander-list.js";
import { openCommanderConversation } from "./commander-navigation.js";
import { useCommanderPopups } from "./commander-popups.js";
import { useCommanderRows } from "./commander-rows.js";

/**
 * 좌측 사이드바의 지휘관 목록 — 우측 작업 탭과 같은 행 조작을 쓴다. 아바타는 목표 팝업, 임무 게이지는 임무 팝업을 열고,
 * 가리키거나 행 안에 초점이 있으면 나타나는 글리프(목표·구성원·증거)는 목표·임무 팝업 또는 증거 뷰어를 연다.
 * 행 본문은 지휘관 대화를 열고, 플릿 브라우저가 열려 있으면 소속 사령관 스페이스로 맞춘다.
 */
export function SidebarCommanderList({ commodoreId, selectedId }: { readonly commodoreId: string; readonly selectedId: string | null }) {
  const listed = useCommanderRows(commodoreId, selectedId);
  const { rowPopups, openTab, dialogs } = useCommanderPopups(commodoreId);
  const sections = listed.listSections.filter((group) => group.settled !== true);
  if (!sections.some((group) => group.rows.length > 0)) return null;
  return <>
    <CommodoreCommanderList
      sortNameOnly
      showBar={false}
      commodoreId={commodoreId}
      selectedId={selectedId}
      onSelect={(item) => {
        const objectiveId = commanderObjectiveId(item.layout.cluster);
        if (!objectiveId) return;
        openCommanderConversation(commodoreId, objectiveId);
        selectBrowserSpaceForCommodore(commodoreId);
      }}
      popups={rowPopups}
      onGlyphTab={(objectiveId, tab, item, opener) => openTab(item, objectiveId, tab, opener)}
    />
    {dialogs}
  </>;
}

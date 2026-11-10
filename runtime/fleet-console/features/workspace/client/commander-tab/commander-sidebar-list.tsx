import { CommodoreCommanderList } from "./commander-list.js";
import { useCommanderPopups } from "./commander-popups.js";

/**
 * 좌측 사이드바의 지휘관 목록 — 우측 작업 탭과 같은 행 조작을 쓴다. 아바타는 목표 팝업, 임무 게이지는 임무 팝업을 열고,
 * 가리키거나 행 안에 초점이 있으면 나타나는 글리프(목표·구성원·증거)는 목표·임무 팝업 또는 증거 뷰어를 연다.
 * 행 본문은 지휘관 대화를 연다.
 */
export function SidebarCommanderList({ commodoreId, selectedId, hideSettled }: { readonly commodoreId: string; readonly selectedId: string | null; readonly hideSettled: boolean }) {
  const { rowPopups, openTab, dialogs } = useCommanderPopups(commodoreId);
  return <>
    <CommodoreCommanderList
      sortNameOnly
      showBar={false}
      hideSettled={hideSettled}
      commodoreId={commodoreId}
      selectedId={selectedId}
      popups={rowPopups}
      onGlyphTab={(objectiveId, tab, item, opener) => openTab(item, objectiveId, tab, opener)}
    />
    {dialogs}
  </>;
}

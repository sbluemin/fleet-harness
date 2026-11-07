import { useEffect, useState, useSyncExternalStore } from "react";
import type { CommodoreTasksListProps } from "../../../commodore/client/deps.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import { commanderObjectiveId } from "../objective-clusters.js";
import { CommodoreCommanderList } from "./commander-list.js";
import { openCommanderConversation } from "./commander-navigation.js";
import { openCommodoreConversation } from "../../../commodore/client/commodore-conversation.js";
import { CommanderMissionsDialog, CommanderRowPanel } from "../../../objectives/client/objectives-panel.js";
import { getT as getObjectivesT } from "../../../objectives/client/i18n/index.js";
import { loadBoard, objectivesApi, useObjectiveBoard } from "../../../objectives/client/objectives-state.js";
import { unseenRecords } from "../../../objectives/shared/types.js";
import { commodoreAvatarKey } from "../../shared/avatars.js";
import { useAvatarAccent } from "../avatar-accent.js";
import type { SideBarRowItem } from "../sidebar/side-bar-cluster-row.js";
import type { CommanderRowGlyphTab } from "./commander-row-glyphs.js";

type Missions = { readonly objectiveId: string; readonly title: string; readonly opener: HTMLElement };

// 행 글리프가 펼친 탭 — 어느 행인지는 묻지 않는다. 펼쳐지는 행은 늘 지금 활성 목표의 행이라, 사령관을 옮기거나 다른 목표를 열어도 같은 탭이
// 새 활성 목표에서 이어 보인다. 활성 목표가 없으면 기억만 하고 아무 행도 펼치지 않는다. 화면 메모리로만 둔다.
let expandedTab: CommanderRowGlyphTab | null = null;
const expandedListeners = new Set<() => void>();
function setExpandedTab(next: CommanderRowGlyphTab | null): void {
  if (expandedTab === next) return;
  expandedTab = next;
  for (const listener of expandedListeners) listener();
}
const subscribeExpandedTab = (listener: () => void) => { expandedListeners.add(listener); return () => { expandedListeners.delete(listener); }; };
const readExpandedTab = () => expandedTab;

/**
 * 작업 탭 「목표」 섹션이 쓰는 목록 — 조립(호스트)이 commodore feature에 넘기는 렌더러다.
 * commodore feature가 workspace 목록을 직접 가져오면 순환이 생기므로, 이 모듈 한 곳에서만 잇는다.
 * 행이나 아바타를 누르면 지휘관 대화가 바로 열리고, 임무 게이지를 누르면 임무 팝업(구성원 로스터 + 임무 그래프)이 뜬다.
 * 행의 글리프(목표·구성원·라이브러리)를 누르면 그 목표를 열고 그 내용만 그 행 아래에 펼친다(아코디언). 펼침은 활성 목표를 따른다 —
 * 좌·우 목록·칩 어느 길로 다른 목표를 열든, 사령관을 옮기든 같은 탭이 새 활성 목표 행에서 이어 펼쳐지고, 활성 목표가 없으면 숨는다.
 * 펼침 상태는 화면 메모리로만 둔다.
 */
export function TasksCommanderList({ commodoreId, selectedId, heading, onSelect }: CommodoreTasksListProps) {
  const state = useConsoleState();
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const objectivesT = getObjectivesT(language);
  const [missions, setMissions] = useState<Missions | null>(null);
  // 임무 팝업은 body 포털이라 오른쪽 패널의 지휘관 강조색을 물려받지 못한다 — 같은 값을 팝업에 직접 건넨다.
  const accent = useAvatarAccent(commodoreAvatarKey(commodoreId));
  const tab = useSyncExternalStore(subscribeExpandedTab, readExpandedTab, readExpandedTab);
  // 활성(선택) 목표의 행만 펼친다 — 선택은 좌·우 목록이 같이 읽는 가운데 대화의 목표다.
  const expanded = selectedId !== null && tab !== null ? { objectiveId: selectedId, tab } : null;
  // 활성 행의 펼친 글리프를 다시 누르면 접히고, 다른 글리프를 누르면 내용만 바뀐다. 활성이 아닌 행의 글리프는 그 목표를 열고 함께 펼친다.
  const handleGlyphTab = (objectiveId: string, next: CommanderRowGlyphTab) => {
    if (selectedId === objectiveId) { setExpandedTab(expandedTab === next ? null : next); return; }
    setExpandedTab(next);
    openCommanderConversation(commodoreId, objectiveId);
  };
  // 게이지 단추의 안 읽은 기록 점이 읽는 보드 — 목록이 함께 올린다.
  const board = useObjectiveBoard(commodoreId);
  const api = objectivesApi();
  useEffect(() => { if (api !== null) void loadBoard(api, commodoreId); }, [api, commodoreId]);
  const unseenOf = (objectiveId: string) => board.loaded && (board.objectives.find((candidate) => candidate.id === objectiveId)?.missions.some((mission) => unseenRecords(mission) > 0) ?? false);

  const openConversation = (item: SideBarRowItem) => {
    const objectiveId = commanderObjectiveId(item.layout.cluster);
    if (onSelect) {
      onSelect({
        objectiveId,
        open: item.layout.cluster.open,
        hasRecord: objectiveId !== null && state.objectiveRecords.some((record) => record.id === objectiveId),
      });
      return;
    }
    if (objectiveId !== null) openCommanderConversation(commodoreId, objectiveId);
    else item.layout.cluster.open?.();
  };

  const handleSelect = (item: SideBarRowItem) => {
    const objectiveId = commanderObjectiveId(item.layout.cluster);
    // 선택된 행을 다시 누르면 사령관 대화로 돌아간다(#2252).
    if (objectiveId !== null && selectedId === objectiveId) { openCommodoreConversation(commodoreId); return; }
    openConversation(item);
  };

  return <>
    <CommodoreCommanderList
      commodoreId={commodoreId}
      selectedId={selectedId}
      sortNameOnly
      card
      heading={heading}
      onSelect={handleSelect}
      popups={(item, objectiveId) => ({
        // 아바타도 행 본문과 같이 지휘관 대화를 연다 — 팝업 문구는 대화 열기로 읽힌다.
        avatarLabel: `${item.layout.cluster.title} · ${objectivesT("objectives.popover.openChat")}`,
        progressLabel: (done, total) => objectivesT("objectives.popover.missions", { done, total }),
        unseen: unseenOf(objectiveId),
        unseenLabel: objectivesT("objectives.tabs.unseenDot"),
        onAvatar: () => handleSelect(item),
        onProgress: (opener) => { setMissions({ objectiveId, title: item.layout.cluster.title, opener }); },
      })}
      expansion={{
        expanded,
        onGlyphTab: handleGlyphTab,
        renderPanel: (item, tab) => {
          const objectiveId = commanderObjectiveId(item.layout.cluster);
          if (objectiveId === null) return null;
          // 펼침 안의 길(임무·결정·결과물로 가기)은 그 탭을 고르기만 한다 — 다시 눌러 접기는 행 글리프만의 동작이다.
          return <CommanderRowPanel commodoreId={commodoreId} objectiveId={objectiveId} language={language} tab={tab} onGlyphTab={setExpandedTab} onOpenObjective={(id) => openCommanderConversation(commodoreId, id)} />;
        },
      }}
    />
    {missions ? (
      <CommanderMissionsDialog commodoreId={commodoreId} objectiveId={missions.objectiveId} title={missions.title} language={language} {...(accent ? { accent } : {})}
        onOpenObjective={(id) => openCommanderConversation(commodoreId, id)}
        onClose={() => { const opener = missions.opener; setMissions(null); if (opener.isConnected) opener.focus(); }} />
    ) : null}
  </>;
}

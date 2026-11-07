import { useEffect, useState } from "react";
import type { CommodoreTasksListProps } from "../../../commodore/client/deps.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import { commanderObjectiveId } from "../objective-clusters.js";
import { CommodoreCommanderList } from "./commander-list.js";
import { openCommanderConversation } from "./commander-navigation.js";
import { openCommodoreConversation } from "../../../commodore/client/commodore-conversation.js";
import { CommanderMissionsDialog } from "../../../objectives/client/objectives-panel.js";
import { getT as getObjectivesT } from "../../../objectives/client/i18n/index.js";
import { loadBoard, objectivesApi, useObjectiveBoard } from "../../../objectives/client/objectives-state.js";
import { unseenRecords } from "../../../objectives/shared/types.js";
import { commodoreAvatarKey } from "../../shared/avatars.js";
import { useAvatarAccent } from "../avatar-accent.js";
import type { SideBarRowItem } from "../sidebar/side-bar-cluster-row.js";

type Missions = { readonly objectiveId: string; readonly title: string; readonly opener: HTMLElement };

/**
 * 작업 탭 「목표」 섹션이 쓰는 목록 — 조립(호스트)이 commodore feature에 넘기는 렌더러다.
 * commodore feature가 workspace 목록을 직접 가져오면 순환이 생기므로, 이 모듈 한 곳에서만 잇는다.
 * 행 펼침이 없다 — 행이나 아바타를 누르면 지휘관 대화가 바로 열리고, 임무 게이지를 누르면
 * 임무 팝업(구성원 로스터 + 임무 그래프)이 뜬다.
 */
export function TasksCommanderList({ commodoreId, selectedId, heading, onSelect }: CommodoreTasksListProps) {
  const state = useConsoleState();
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const objectivesT = getObjectivesT(language);
  const [missions, setMissions] = useState<Missions | null>(null);
  // 임무 팝업은 body 포털이라 오른쪽 패널의 지휘관 강조색을 물려받지 못한다 — 같은 값을 팝업에 직접 건넨다.
  const accent = useAvatarAccent(commodoreAvatarKey(commodoreId));
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
    />
    {missions ? (
      <CommanderMissionsDialog commodoreId={commodoreId} objectiveId={missions.objectiveId} title={missions.title} language={language} {...(accent ? { accent } : {})}
        onOpenObjective={(id) => openCommanderConversation(commodoreId, id)}
        onClose={() => { const opener = missions.opener; setMissions(null); if (opener.isConnected) opener.focus(); }} />
    ) : null}
  </>;
}

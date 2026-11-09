import { useEffect, useState, useSyncExternalStore } from "react";
import type { CommodoreTasksListProps } from "../../../commodore/client/deps.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import { commanderObjectiveId } from "../objective-clusters.js";
import { CommodoreCommanderList } from "./commander-list.js";
import { openCommanderConversation } from "./commander-navigation.js";
import { openCommodoreConversation } from "../../../commodore/client/commodore-conversation.js";
import { CommanderGoalDialog, CommanderMissionsDialog, CommanderRowPanel } from "../../../objectives/client/objectives-panel.js";
import { getT as getObjectivesT } from "../../../objectives/client/i18n/index.js";
import { loadBoard, objectivesApi, useObjectiveBoard } from "../../../objectives/client/objectives-state.js";
import { unseenRecords } from "../../../objectives/shared/types.js";
import { objectiveTabHasContent } from "../../../objectives/client/detail-content.js";
import { useSharedFileCount } from "../../../objectives/client/shared-folder-count.js";
import { commodoreAvatarKey } from "../../shared/avatars.js";
import { useAvatarAccent } from "../avatar-accent.js";
import type { SideBarRowItem } from "../sidebar/side-bar-cluster-row.js";
import type { CommanderRowGlyphTab } from "./commander-row-glyphs.js";

type Popup = { readonly objectiveId: string; readonly title: string; readonly opener: HTMLElement };

// 행 글리프가 펼친 행과 탭 — 펼침은 글리프를 누른 행에 서며 가운데 대화(활성 목표)와 무관하다. 화면 메모리로만 둔다.
type Expanded = { readonly objectiveId: string; readonly tab: CommanderRowGlyphTab };
let expandedRow: Expanded | null = null;
const expandedListeners = new Set<() => void>();
function setExpandedRow(next: Expanded | null): void {
  if (expandedRow === next || (expandedRow !== null && next !== null && expandedRow.objectiveId === next.objectiveId && expandedRow.tab === next.tab)) return;
  expandedRow = next;
  for (const listener of expandedListeners) listener();
}
const subscribeExpandedRow = (listener: () => void) => { expandedListeners.add(listener); return () => { expandedListeners.delete(listener); }; };
const readExpandedRow = () => expandedRow;

/**
 * 작업 탭 「목표」 섹션이 쓰는 목록 — 조립(호스트)이 commodore feature에 넘기는 렌더러다.
 * commodore feature가 workspace 목록을 직접 가져오면 순환이 생기므로, 이 모듈 한 곳에서만 잇는다.
 * 행을 누르면 지휘관 대화가 바로 열리고, 아바타를 누르면 목표 팝업(브리핑·달성 기준·결정·회고·후속 목표)이, 임무 게이지를 누르면 임무 팝업(구성원 로스터 + 임무 그래프)이 뜬다.
 * 행의 글리프(목표·구성원·라이브러리)를 누르면 그 내용만 그 행 아래에 펼친다(아코디언) — 가운데 대화는 그대로 두고 열지 않는다.
 * 펼침 상태는 화면 메모리로만 둔다.
 */
export function TasksCommanderList({ commodoreId, selectedId, heading, onSelect }: CommodoreTasksListProps) {
  const state = useConsoleState();
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const objectivesT = getObjectivesT(language);
  const [missions, setMissions] = useState<Popup | null>(null);
  const [goal, setGoal] = useState<Popup | null>(null);
  // 임무 팝업은 body 포털이라 오른쪽 패널의 지휘관 강조색을 물려받지 못한다 — 같은 값을 팝업에 직접 건넨다.
  const accent = useAvatarAccent(commodoreAvatarKey(commodoreId));
  const expandedState = useSyncExternalStore(subscribeExpandedRow, readExpandedRow, readExpandedRow);
  // 게이지 단추의 안 읽은 기록 점이 읽는 보드 — 목록이 함께 올린다.
  const board = useObjectiveBoard(commodoreId);
  const expandedObjective = expandedState === null || !board.loaded ? null : board.objectives.find((candidate) => candidate.id === expandedState.objectiveId) ?? null;
  const sharedFiles = useSharedFileCount(expandedObjective, true);
  // 펼친 행은 글리프를 누른 행이다. 그 탭이 그 목표에서 비어 있으면 접힌 채 둔다(기억은 지우지 않는다).
  const expanded = expandedState !== null && (expandedObjective === null || objectiveTabHasContent(expandedObjective, expandedState.tab, sharedFiles)) ? expandedState : null;
  // 펼친 글리프를 다시 누르면 접히고, 다른 글리프를 누르면 내용만 바뀐다. 다른 행의 글리프를 누르면 펼침이 그 행으로 옮겨 간다(한 번에 한 행).
  const handleGlyphTab = (objectiveId: string, next: CommanderRowGlyphTab) => {
    const current = expandedRow;
    setExpandedRow(current !== null && current.objectiveId === objectiveId && current.tab === next ? null : { objectiveId, tab: next });
  };
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
        // 아바타는 목표 팝업을 연다 — 지휘관 대화는 행 본문이 연다.
        avatarLabel: `${item.layout.cluster.title} · ${objectivesT("objectives.popover.openGoal")}`,
        progressLabel: (done, total) => objectivesT("objectives.popover.missions", { done, total }),
        unseen: unseenOf(objectiveId),
        unseenLabel: objectivesT("objectives.tabs.unseenDot"),
        onAvatar: (opener) => { setGoal({ objectiveId, title: item.layout.cluster.title, opener }); },
        onProgress: (opener) => { setMissions({ objectiveId, title: item.layout.cluster.title, opener }); },
      })}
      expansion={{
        expanded,
        onGlyphTab: handleGlyphTab,
        renderPanel: (item, tab) => {
          const objectiveId = commanderObjectiveId(item.layout.cluster);
          if (objectiveId === null) return null;
          // 펼침 안의 길(임무·결정·결과물로 가기)은 그 탭을 고르기만 한다 — 다시 눌러 접기는 행 글리프만의 동작이다.
          return <CommanderRowPanel readOnly commodoreId={commodoreId} objectiveId={objectiveId} language={language} tab={tab} onGlyphTab={(next) => setExpandedRow({ objectiveId, tab: next })} onOpenObjective={(id) => openCommanderConversation(commodoreId, id)} />;
        },
      }}
    />
    {goal ? (
      <CommanderGoalDialog commodoreId={commodoreId} objectiveId={goal.objectiveId} title={goal.title} language={language} {...(accent ? { accent } : {})}
        onOpenObjective={(id) => openCommanderConversation(commodoreId, id)}
        onClose={() => { const opener = goal.opener; setGoal(null); if (opener.isConnected) opener.focus(); }} />
    ) : null}
    {missions ? (
      <CommanderMissionsDialog commodoreId={commodoreId} objectiveId={missions.objectiveId} title={missions.title} language={language} {...(accent ? { accent } : {})}
        onOpenObjective={(id) => openCommanderConversation(commodoreId, id)}
        onClose={() => { const opener = missions.opener; setMissions(null); if (opener.isConnected) opener.focus(); }} />
    ) : null}
  </>;
}

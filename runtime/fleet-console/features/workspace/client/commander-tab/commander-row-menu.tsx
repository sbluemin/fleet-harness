import { useCallback, useEffect, useRef } from "react";

import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import type { ObjectiveRecord } from "../../../../core/client/src/integration/types.js";
import { openCommanderConversation } from "./commander-navigation.js";
import { commanderObjectiveId } from "../objective-clusters.js";
import { objectiveRecordAccentFromNode } from "../objective-accent.js";
import { GroupContextMenu } from "../sidebar/group-context-menu.js";
import { useContextMenuKeyboard } from "../sidebar/context-menu-keyboard.js";
import { getTheaterGroupCollapse } from "../sidebar/group-collapse-store.js";
import { requestSideBarObjectiveAction } from "../sidebar/interaction.js";
import { closeCommanderRowMenu, useCommanderRowMenuRequest } from "../sidebar/commander-row-menu-store.js";
import type { SideBarRowItem } from "../sidebar/side-bar-cluster-row.js";

/**
 * 지휘관 행 우클릭 — #2098 이전 사이드바 줄 메뉴와 같은 카드다.
 * 세션이 있는 행(뿌리 Objective)은 열기·이름·플러그인 스위치·그룹·액센트·보관이고,
 * 세션이 없는 목표는 이름(있을 때)과 그 줄이 선언한 보관만이다.
 * objective-records 의 죽은 kind="chip" 상태에는 기대지 않는다.
 */
export function CommanderRowMenuLayer({
  onSetAccent,
  onSetGroupId,
  onCreateGroup,
  onArchiveObjective,
}: {
  readonly onSetAccent: (objectiveId: string, accentKey: string | null) => void;
  readonly onSetGroupId: (objectiveId: string, groupId: string | null) => void;
  readonly onCreateGroup: (commodoreId: string, name: string, objectiveId?: string) => void;
  readonly onArchiveObjective: (objectiveId: string) => void;
}) {
  const request = useCommanderRowMenuRequest();
  const state = useConsoleState();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const anchored = request?.item.anchor?.objectiveRecord ?? null;
  const objective = anchored
    ? state.objectiveRecords.find((record) => record.id === anchored.id) ?? null
    : null;
  returnFocusRef.current = request?.returnFocus ?? null;

  const close = useCallback(() => {
    if (document.hasFocus()) returnFocusRef.current?.focus();
    closeCommanderRowMenu();
  }, []);

  useEffect(() => {
    if (request?.item.anchor && objective === null) closeCommanderRowMenu();
  }, [objective, request]);

  useContextMenuKeyboard({
    open: request !== null && (objective !== null || request.item.row.archive !== undefined),
    menuSelector: '.group-context-menu-card[role="menu"]',
    returnFocusRef,
    onEscape: close,
  });

  if (!request) return null;
  if (objective) {
    return (
      <GroupContextMenu
        kind="chip"
        objectiveRecord={objective}
        groups={state.groups.filter((group) => group.commodoreId === objective.commodoreId)}
        accentKey={getTheaterGroupCollapse(objective.theaterId).objectiveRecordAccent[objective.id]
          ?? objectiveRecordAccentFromNode(objective)}
        anchor={request.anchor}
        actions={{
          onOpen: () => openRow(request.item, objective),
          ...(request.item.row.rename ? { onRename: () => requestSideBarObjectiveAction(objective.id, "rename") } : {}),
          onSetAccent: (key) => onSetAccent(objective.id, key),
          onSetGroupId: (groupId) => onSetGroupId(objective.id, groupId),
          onCreateGroup: (name) => onCreateGroup(objective.commodoreId, name, objective.id),
          onCloseObjective: () => onArchiveObjective(objective.id),
        }}
        onClose={close}
      />
    );
  }
  const archive = request.item.row.archive;
  if (!archive) return null;
  const actionId = request.item.layout.cluster.id;
  return (
    <GroupContextMenu
      kind="row"
      anchor={request.anchor}
      actions={{
        ...(request.item.row.rename ? { onRename: () => requestSideBarObjectiveAction(actionId, "rename") } : {}),
        onArchive: archive,
      }}
      onClose={close}
    />
  );
}

function openRow(item: SideBarRowItem, objective: ObjectiveRecord): void {
  const objectiveId = commanderObjectiveId(item.layout.cluster) ?? objective.id;
  const commodoreId = objective.commodoreId ?? item.layout.cluster.commodoreId;
  if (commodoreId) openCommanderConversation(commodoreId, objectiveId);
  else item.layout.cluster.open?.();
}

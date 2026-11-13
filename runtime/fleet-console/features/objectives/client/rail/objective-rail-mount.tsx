import { useEffect, useSyncExternalStore } from "react";

import { useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { registerConversationObjectiveTab } from "../../../../core/client/src/chrome/rail/objective-tabs.js";
import { useConversationStandIn, useConversationSubject } from "../../../workspace/client/conversation/conversation-slots.js";
import { useConversationSurface } from "../../../workspace/client/conversation/conversation-surface-store.js";
import { commanderOwnerOf } from "../../../workspace/client/commander-tab/commander-rows.js";
import { useClusterIndex } from "../../../workspace/client/objective-clusters.js";
import { COMMODORE_SURFACE_ID } from "../../../commodore/client/commodore-conversation.js";
import { getT } from "../i18n/index.js";
import { FRESH_SURFACE_ID, findAnyObjective, loadObjective, subscribeObjectiveOrFinished } from "../objectives-state.js";
import { ObjectiveRail } from "./objective-rail.js";
import { OBJECTIVE_RAIL_TAB_ID } from "./objective-rail-tab.js";

/**
 * 가운데가 지휘관·구성원·시작 전(또는 보관된 완료) 목표일 때의 그 목표 id.
 * 사령관 대화와 새 목표 화면은 사령관 탭을 그대로 두므로 null.
 */
export function useObjectiveRailId(): string | null {
  const surface = useConversationSurface();
  const subject = useConversationSubject();
  const standIn = useConversationStandIn();
  const index = useClusterIndex();
  const newSession = useConsoleState().newSession;
  if (newSession !== null || surface?.surfaceId === COMMODORE_SURFACE_ID) return null;
  if (surface?.surfaceId === FRESH_SURFACE_ID) {
    const id = surface.params.objectiveId;
    return typeof id === "string" && id !== "" ? id : null;
  }
  if (surface !== null && standIn === null) return null;
  const root = subject ? subject.parentObjectiveId ?? subject.id : standIn;
  if (root === null) return null;
  return commanderOwnerOf(index.clusters, root) !== null ? root : null;
}

function ObjectiveRailTab() {
  const id = useObjectiveRailId();
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const objective = useSyncExternalStore(subscribeObjectiveOrFinished, () => (id === null ? null : findAnyObjective(id)), () => null);
  useEffect(() => {
    if (id !== null && objective === null) void loadObjective(id).catch(() => undefined);
  }, [id, objective]);
  if (id === null) return null;
  if (objective === null) return <div className="objective-rail"><p className="objective-rail-empty">{getT(language)("objectives.rail.area.loading")}</p></div>;
  return <ObjectiveRail objective={objective} language={language} />;
}

/**
 * 데스크톱에서만 3영역 탭을 등록한다. 폰 대화 정보 화면은 구성원 탭을 그대로 읽으므로 여기 탭을 싣지 않는다.
 * 목표가 바뀌는 동안에는 등록을 유지해 패널이 깜빡이지 않게 하고, 맥락을 떠나면 걷는다.
 */
export function ObjectiveRailMount({ layout }: { readonly layout?: "mobile" | "desktop" }) {
  const id = useObjectiveRailId();
  const show = layout !== "mobile" && id !== null;
  useEffect(() => {
    if (!show) return undefined;
    return registerConversationObjectiveTab({
      id: OBJECTIVE_RAIL_TAB_ID,
      title: (locale) => getT(locale)("objectives.rail.area.panel"),
      icon: () => null,
      order: 5,
      desktopOnly: true,
      render: () => <ObjectiveRailTab />,
    });
  }, [show]);
  return null;
}

import type { MobileBarMenuItem } from "../../../../../features/workspace/shared/pane.js";

import type { useT } from "../../i18n/index.js";
import type { ObjectiveRecord } from "../../integration/types.js";
import { MobileIcon } from "./mobile-icons.js";
import { pushMobileSheet } from "./mobile-store.js";

/**
 * 대화 ⋮ 메뉴 — Objective 화면 머리와 대화 정보 화면이 같은 항목을 같은 순서로 보인다: 이름 변경, 본문이 `mobileObjective.setMenuItems`로
 * 끼운 항목들(보기 전환·계속 허용 …), 보관. 이름 변경·보관은 화면 주인(지휘관)의 것이라 구성원 본문을 보는 동안에도 `objectiveRecord`은 그 주인이다.
 */
export function mobileObjectiveMenuItems({ objectiveRecord, bodyItems, t, onArchive }: {
  readonly objectiveRecord: ObjectiveRecord;
  readonly bodyItems: readonly MobileBarMenuItem[];
  readonly t: ReturnType<typeof useT>;
  readonly onArchive: () => void;
}): readonly MobileBarMenuItem[] {
  return [
    { id: "rename", icon: <MobileIcon name="pencil" size={20} />, label: t("mobile.menu.rename"), run: () => pushMobileSheet({ kind: "rename", objectiveId: objectiveRecord.id }) },
    ...bodyItems,
    { id: "archive", icon: <MobileIcon name="archive" size={20} />, label: t("mobile.menu.archive"), run: onArchive },
  ];
}

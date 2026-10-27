import { useSyncExternalStore } from "react";
import { commodoreOwnerAlias, subscribeCommodore } from "./commodore-state.js";
import type { getT } from "./i18n/index.js";

/** 사령관(UUID)의 이름 — 별칭, 없으면 「사령관」. Theater 에서 찾지 않는다. */
export function commodoreName(commodoreId: string, t: ReturnType<typeof getT>): string {
  return commodoreOwnerAlias(commodoreId) ?? t("commodore.name");
}

/** 이름만 바뀌어도 대화 상태 객체와 무관하게 표시를 갱신한다. */
export function useCommodoreName(commodoreId: string, t: ReturnType<typeof getT>): string {
  return useSyncExternalStore(subscribeCommodore, () => commodoreName(commodoreId, t), () => commodoreName(commodoreId, t));
}

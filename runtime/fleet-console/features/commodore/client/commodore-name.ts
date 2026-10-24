import { useSyncExternalStore } from "react";
import { commodoreAlias, commodoreOwnerAlias, subscribeCommodore } from "./commodore-state.js";
import type { getT } from "./i18n/index.js";

export function commodoreName(theaterId: string, t: ReturnType<typeof getT>): string {
  return commodoreAlias(theaterId) ?? t("commodore.name");
}

/** 이름만 바뀌어도 대화 상태 객체와 무관하게 표시를 갱신한다. */
export function useCommodoreName(theaterId: string, t: ReturnType<typeof getT>): string {
  return useSyncExternalStore(subscribeCommodore, () => commodoreName(theaterId, t), () => commodoreName(theaterId, t));
}

export function commodoreOwnerName(commodoreId: string, t: ReturnType<typeof getT>): string {
  return commodoreOwnerAlias(commodoreId) ?? t("commodore.name");
}
export function useCommodoreOwnerName(commodoreId: string, t: ReturnType<typeof getT>): string {
  return useSyncExternalStore(subscribeCommodore, () => commodoreOwnerName(commodoreId, t), () => commodoreOwnerName(commodoreId, t));
}

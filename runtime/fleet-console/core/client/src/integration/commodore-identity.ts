import { clampCommodoreAlias } from "../../../../features/commodore/shared/alias.js";
import { createCommodoreForTheater, fetchTheaters, setCommodoreAlias } from "./api.js";
import { getState, hydrateTheaters } from "./store.js";

/** Workspace는 편집 포트만 받는다. 조합이 화면의 Theater 문맥을 UUID로 해석하고 사령관 API에 쓴다. */
export const commodoreAliasEditor = {
  clamp: clampCommodoreAlias,
  async save(theaterId: string, alias: string | null): Promise<void> {
    const theater = getState().theaters.find((row) => row.id === theaterId);
    if (!theater) throw new Error("theater_unavailable");
    const commodoreId = theater.commodore?.id ?? await createCommodoreForTheater(theaterId);
    await setCommodoreAlias(commodoreId, alias);
    // 성공한 저장을 재수화 실패 때문에 다시 쓰게 하지 않는다. 다른 창은 lifecycle 사건으로 갱신된다.
    await fetchTheaters(null).then(hydrateTheaters).catch(() => {});
  },
};

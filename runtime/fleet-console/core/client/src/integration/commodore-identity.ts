import { clampCommodoreAlias } from "../../../../features/commodore/shared/alias.js";
import { fetchTheaters, setCommodoreAlias } from "./api.js";
import { getState, hydrateTheaters } from "./store.js";

const COMMODORE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 별칭은 이미 있는 사령관 UUID에만 쓴다. Theater 등록으로 사령관을 만들지 않는다. */
export const commodoreAliasEditor = {
  clamp: clampCommodoreAlias,
  async save(id: string, alias: string | null): Promise<void> {
    const commodoreId = COMMODORE_UUID.test(id) ? id : getState().theaters.find((row) => row.id === id)?.commodore?.id;
    if (!commodoreId) throw new Error("commodore_required");
    await setCommodoreAlias(commodoreId, alias);
    await fetchTheaters(null).then(hydrateTheaters).catch(() => {});
  },
};

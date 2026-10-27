import { clampCommodoreAlias } from "../../../../features/commodore/shared/alias.js";
import { refreshCommodoreList } from "../../../../features/commodore/client/commodore-list.js";
import { setCommodoreAlias } from "./api.js";

const COMMODORE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 별칭은 이미 있는 사령관 UUID에만 쓴다. Theater 등록으로 사령관을 만들지 않고, Theater 에서 주인을 찾지 않는다. */
export const commodoreAliasEditor = {
  clamp: clampCommodoreAlias,
  async save(commodoreId: string, alias: string | null): Promise<void> {
    if (!COMMODORE_UUID.test(commodoreId)) throw new Error("commodore_required");
    await setCommodoreAlias(commodoreId, alias);
    await refreshCommodoreList().catch(() => {});
  },
};

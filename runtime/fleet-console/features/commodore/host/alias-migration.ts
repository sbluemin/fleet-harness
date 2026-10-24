import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { commodoreEntitySchema, type CommodoreEntities } from "./entities.js";
import { writeFileAtomic } from "./store.js";
import { normalizeCommodoreAlias } from "../shared/alias.js";

/** 원본 읽기·제거는 명부 저장소가 맡는다. 이 포트는 사령관 대상의 커밋과 재확인만 수행한다. */
export function migrateCommodoreAliases(entries: readonly { readonly theaterId: string; readonly alias: unknown; readonly registered: boolean }[], owners: { readonly entities: CommodoreEntities; readonly issueForAlias: (theaterId: string) => string }): void {
  for (const entry of entries) {
    const alias = normalizeCommodoreAlias(entry.alias);
    if (typeof alias !== "string") {
      console.warn(`[commodore] alias migration ${entry.theaterId}: invalid_alias; discarded`);
      continue;
    }
    const id = owners.entities.resolve(entry.theaterId) ?? (entry.registered ? owners.issueForAlias(entry.theaterId) : null);
    if (!id) {
      console.warn(`[commodore] alias migration ${entry.theaterId}: orphan_tombstone; discarded`);
      continue;
    }
    const dir = owners.entities.dirOf(id);
    if (!dir) throw new Error("commodore_alias_migration_unavailable");
    const file = path.join(dir, "state.json");
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const state = commodoreEntitySchema.parse(current);
    if (state.alias !== undefined) continue;
    // 검증 결과로 원문을 재생성하지 않는다. 이번 이전은 alias 한 필드만 바꾼다.
    const next = { ...current, alias };
    commodoreEntitySchema.parse(next);
    writeFileAtomic(file, JSON.stringify(next));
    if (!owners.entities.dirOf(id) || !isDeepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), next)) throw new Error("commodore_alias_migration_verification_failed");
  }
}

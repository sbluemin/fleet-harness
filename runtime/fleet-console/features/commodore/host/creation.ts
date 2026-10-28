import fs from "node:fs";
import path from "node:path";
import type { createCommodoreOwnership } from "./ownership.js";
import { createCommodoreStore, type CommodoreStore } from "./store.js";
import { CommodoreStoreError } from "./errors.js";

export interface CommodoreCreateInput {
  readonly alias: string;
  readonly theaters: readonly string[];
  readonly directive: string;
  readonly intel: readonly string[];
  readonly memoryRefs?: readonly string[];
}

/** 사령관 전용 생성 경로. 초기화는 비공개 staging 저장소에서 끝낸 뒤 한 번에 공개한다. */
export function createCommodoreCreator(deps: {
  readonly ownership: ReturnType<typeof createCommodoreOwnership>;
  readonly store: CommodoreStore;
  readonly created?: (commodoreId: string) => void;
}) {
  return (sourceId: string, input: CommodoreCreateInput) => {
    deps.ownership.assertWritable(sourceId);
    const { entities } = deps.ownership;
    const ownPaths = new Set(entities.theatersOf(sourceId).map((row) => row.path));
    const theaters = [...new Set(input.theaters.map((root) => {
      if (!path.isAbsolute(root)) throw new CommodoreStoreError("theater_unavailable");
      let canonical: string;
      try {
        canonical = fs.realpathSync.native(root);
        if (!fs.statSync(canonical).isDirectory()) throw new Error();
      } catch { throw new CommodoreStoreError("theater_unavailable"); }
      if (!ownPaths.has(canonical)) throw new CommodoreStoreError("theater_not_owned");
      return canonical;
    }))].map((root) => ({ path: root }));
    // 다른 사령관의 기억이나 파일 경로는 받지 않는다. 복사할 항목만 읽어 출처·검증 시각을 보존한다.
    const memories = [...new Set(input.memoryRefs ?? [])].map((ref) => deps.store.memory.read(sourceId, ref));
    const refs = new Set(memories.map((entry) => entry.ref));
    const id = entities.create(undefined, (newId, directory) => {
      let rows: readonly { readonly path: string }[] = [];
      const staged = createCommodoreStore({
        dirOf: (candidate) => candidate === newId ? directory : null,
        theatersOf: () => rows, theaterIdsOf: () => [],
        replaceTheatersInIndex: (_candidate, next) => { rows = next; },
        emit: () => {},
      });
      staged.setAlias(newId, input.alias);
      staged.setTheaters(newId, theaters);
      staged.setDirective(newId, input.directive);
      for (const text of input.intel) staged.addIntel(newId, { text, source: `commodore:${sourceId}` });
      for (const entry of memories) staged.memory.copy(newId, { ...entry, links: entry.links.filter((ref) => refs.has(ref)) });
    });
    try { deps.created?.(id); }
    catch (error) {
      // 호스트 초기화도 실패하면 공개된 새 UUID를 거둔다. 기존 사령관에는 손대지 않는다.
      const retired = entities.remove(id);
      deps.store.forget(id);
      fs.rmSync(retired, { recursive: true, force: true });
      throw error;
    }
    deps.store.announceCreated(id);
    return { commodoreId: id, target: `commodore:${id}` };
  };
}

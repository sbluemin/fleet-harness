import fs from "node:fs";
import path from "node:path";
import type { createCommodoreOwnership } from "./ownership.js";
import { createCommodoreStore, type CommodoreStore } from "./store.js";
import type { CommodoreCoordinates } from "../shared/contracts/types.js";
import { CommodoreStoreError } from "./errors.js";
import { canonicalModelId, clampRosterEffort, findRosterRow, isAgentEffort, rosterRowEfforts, type ModelRosterTarget } from "../../ai-gateway/shared/models.js";
import type { ModelRosterHost } from "../../ai-gateway/host/model-ports.js";

/** 생성 도구에서 모델을 생략했을 때의 사령관·지휘관 기본 좌표. */
const CREATE_DEFAULTS = { model: "opus[1m]", effort: "high", commanderEffort: "medium" } as const;

export interface CommodoreCreateInput {
  readonly alias: string;
  readonly theaters: readonly string[];
  readonly description: string;
  readonly intel: readonly string[];
  readonly memoryRefs?: readonly string[];
  readonly model?: string;
  readonly effort?: CommodoreCoordinates["effort"];
  readonly commanderModel?: string;
  readonly commanderEffort?: string;
}

/** 사령관 전용 생성 경로. 초기화는 비공개 staging 저장소에서 끝낸 뒤 한 번에 공개한다. */
export function createCommodoreCreator(deps: {
  readonly ownership: ReturnType<typeof createCommodoreOwnership>;
  readonly store: CommodoreStore;
  /** 화면 선택기와 같은 로스터. 사령관은 agent, 지휘관은 launch 사다리로 모델·강도를 확인한다. 지휘관 모델은 사람이 켠 목록(enabled)으로도 확인한다. */
  readonly models?: Pick<ModelRosterHost, "roster" | "enabled">;
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
    // 공개 전에 좌표를 정한다 — 거절된 생성은 UUID를 남기지 않는다.
    const coordinate = (target: ModelRosterTarget, model: string | undefined, effort: string | undefined, fallbackEffort: string) => {
      const id = canonicalModelId(model ?? CREATE_DEFAULTS.model);
      if (!deps.models) return { model: id, effort: effort ?? fallbackEffort };
      const row = findRosterRow(deps.models.roster(target), id);
      if (!row) {
        if (model !== undefined) throw new CommodoreStoreError("model_not_in_roster", undefined, { model });
        return { model: id, effort: effort ?? fallbackEffort };
      }
      const ladder = rosterRowEfforts(row);
      if (effort !== undefined && ladder.length > 0 && !ladder.includes(effort)) throw new CommodoreStoreError("invalid_effort", undefined, { model: id, efforts: ladder });
      // 강도를 생략하면 기본 강도를 그 모델의 사다리에 맞춘다. 사다리가 없으면 강도를 저장하지 않는다.
      const chosen = effort ?? clampRosterEffort(ladder, fallbackEffort);
      return { model: id, ...(chosen !== undefined ? { effort: chosen } : {}) };
    };
    const own = coordinate("agent", input.model, input.effort, CREATE_DEFAULTS.effort);
    const ownEffort = isAgentEffort(own.effort) ? own.effort : undefined;
    const commander = coordinate("launch", input.commanderModel, input.commanderEffort, CREATE_DEFAULTS.commanderEffort);
    // 새 사령관의 지휘관 모델은 넘긴 것이든 생략해 정해진 기본값이든 사람이 AI Gateway에서 켠 것만 받는다. 다른 모델로 바꾸지 않고,
    // 켠 목록을 읽지 못하면 추측으로 통과시키지 않는다.
    if (deps.models?.enabled) {
      const enabled = deps.models.enabled();
      if (!enabled) throw new CommodoreStoreError("gateway_settings_unavailable");
      if (!enabled.has(commander.model)) throw new CommodoreStoreError("model_not_enabled", undefined, { model: input.commanderModel ?? commander.model });
    }
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
      staged.setDescription(newId, input.description);
      if (ownEffort) staged.setCoordinates(newId, { model: own.model, effort: ownEffort });
      staged.setCommander(newId, commander);
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

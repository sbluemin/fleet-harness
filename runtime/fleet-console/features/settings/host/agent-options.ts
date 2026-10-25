import path from "node:path";

import {
  createStoreCarryOver,
  sanitizeAgentOptionsData,
  type AgentOptionsData,
  type AgentOptionsService,
  type ClaudeCodeTheaterSystemPrompt,
  type DurableJsonStore,
} from "@fleet-console/infra";

import type { ConsoleSettingsData } from "./settings-domain.js";

/** Host-side UUID admission keeps the schema independent of the Commodore feature. */
export interface CommodoreSystemPromptService {
  readonly exists: (commodoreId: string) => boolean;
  readonly read: (commodoreId: string | undefined) => ClaudeCodeTheaterSystemPrompt | null;
  readonly save: (commodoreId: string, prompt: ClaudeCodeTheaterSystemPrompt | null) => ClaudeCodeTheaterSystemPrompt | null;
  readonly subagentsKept: (commodoreId: string | undefined) => boolean;
  readonly keepSubagents: (commodoreId: string, kept: boolean) => boolean;
  readonly purge: (theaterId: string) => void;
  readonly migrate: (owners: readonly { readonly commodoreId: string; readonly theaterIds: readonly string[] }[]) => void;
}

export function createCommodoreSystemPromptService(options: AgentOptionsService, exists: (id: string) => boolean): CommodoreSystemPromptService {
  const mark = (current: AgentOptionsData, id: string): AgentOptionsData => ({ ...current, commodoreSettingsMigrated: { ...current.commodoreSettingsMigrated, [id]: true } });
  return {
    exists,
    read: (id) => id && exists(id) ? options.load().claudeCodeCommodoreSystemPrompts?.[id] ?? null : null,
    subagentsKept: (id) => !!id && exists(id) && options.load().claudeCodeCommodoreSubagents?.[id] === true,
    save(id, prompt) {
      if (!exists(id)) throw new Error("commodore_not_found");
      const value = prompt?.mode === "on" && !prompt.body.trim() ? null : prompt;
      const updated = options.update((current) => {
        const prompts = { ...current.claudeCodeCommodoreSystemPrompts };
        if (value === null) delete prompts[id]; else prompts[id] = value;
        const { claudeCodeCommodoreSystemPrompts: _previous, ...rest } = mark(current, id);
        return Object.keys(prompts).length ? { ...rest, claudeCodeCommodoreSystemPrompts: prompts } : rest;
      });
      return updated.claudeCodeCommodoreSystemPrompts?.[id] ?? null;
    },
    keepSubagents(id, kept) {
      if (!exists(id)) throw new Error("commodore_not_found");
      options.update((current) => {
        const values: Record<string, true> = { ...current.claudeCodeCommodoreSubagents };
        if (kept) values[id] = true; else delete values[id];
        const { claudeCodeCommodoreSubagents: _previous, ...rest } = mark(current, id);
        return Object.keys(values).length ? { ...rest, claudeCodeCommodoreSubagents: values } : rest;
      });
      return kept;
    },
    migrate(owners) {
      if (!owners.some((owner) => !options.load().commodoreSettingsMigrated?.[owner.commodoreId])) return;
      options.update((current) => {
        let next = current;
        for (const { commodoreId: id, theaterIds } of owners) {
          if (next.commodoreSettingsMigrated?.[id]) continue;
          const hasSettings = next.claudeCodeCommodoreSystemPrompts?.[id] !== undefined || next.claudeCodeCommodoreSubagents?.[id] !== undefined;
          if (!hasSettings && theaterIds.length === 1) {
            const theater = theaterIds[0]!;
            const prompt = current.claudeCodeTheaterSystemPrompts?.[theater];
            if (prompt) next = { ...next, claudeCodeCommodoreSystemPrompts: { ...next.claudeCodeCommodoreSystemPrompts, [id]: prompt } };
            if (current.claudeCodeTheaterSubagents?.[theater]) next = { ...next, claudeCodeCommodoreSubagents: { ...next.claudeCodeCommodoreSubagents, [id]: true } };
          } else if (!hasSettings) console.warn(`[commodore] settings migration ${id}: ambiguous_theaters; default retained`);
          next = mark(next, id);
        }
        return next;
      });
    },
    purge(theaterId) {
      // Only retired source settings are purged with a forgotten Theater. UUID settings are independent.
      options.update((current) => {
        const prompts = { ...current.claudeCodeTheaterSystemPrompts };
        const agents = { ...current.claudeCodeTheaterSubagents };
        delete prompts[theaterId]; delete agents[theaterId];
        const { claudeCodeTheaterSystemPrompts: _prompts, claudeCodeTheaterSubagents: _agents, ...rest } = current;
        return { ...rest, ...(Object.keys(prompts).length ? { claudeCodeTheaterSystemPrompts: prompts } : {}), ...(Object.keys(agents).length ? { claudeCodeTheaterSubagents: agents } : {}) };
      });
    },
  };
}

/** 옛 자리의 파일 이름. Console 설정 파일과 이름이 같아 디렉터리만으로 구분된다. */
const LEGACY_OPTIONS_FILE_NAME = "settings.json";

export interface CreateAgentOptionsServiceDeps {
  /**
   * 이미 만들어진 Console 설정 저장소를 그대로 쓴다. 여기서 두 번째 저장소를 만들면 같은
   * 파일을 두 개의 락 소유자가 다투게 된다.
   */
  readonly store: DurableJsonStore<ConsoleSettingsData>;
  /**
   * 이 옵션들이 예전에 살던 디렉터리들(가장 최근 자리가 앞). 그 안의 `settings.json`을 한 번만
   * 승계한다 — 옛 자리는 Fleet 루트였고, 그래서 Console 인스턴스를 갈아도 같은 파일이었다.
   */
  readonly legacyDirs?: readonly string[];
}

/**
 * Agent 실행 옵션의 읽기·쓰기 창구. 저장 자리는 `console/settings.json`의 `agent` 섹션이고,
 * 쓰는 쪽은 그 사실을 몰라도 된다.
 *
 * 승계 완료의 표식은 **`agent` 키의 존재**다. 목적지 파일은 테마 하나만 바꿔도 이미 존재하므로
 * 파일 존재로는 판정할 수 없고, 값이 비었는지로 판정하면 사용자가 모든 옵션을 기본값으로
 * 되돌린 상태를 옛 값으로 되살린다.
 */
export function createAgentOptionsService(deps: CreateAgentOptionsServiceDeps): AgentOptionsService {
  const { store } = deps;
  const carryOver = createStoreCarryOver<AgentOptionsData>({
    destinationPath: store.path,
    adopted: () => store.load().agent !== undefined,
    sourcePaths: (deps.legacyDirs ?? []).map((dir) => path.join(dir, LEGACY_OPTIONS_FILE_NAME)),
    adopt: (parsed) => {
      const data = sanitizeAgentOptionsData(parsed).data;
      return Object.keys(data).length > 0 ? data : undefined;
    },
  });

  const commit = (mutate: (current: AgentOptionsData) => AgentOptionsData): AgentOptionsData => {
    const next = store.update((current) => ({
      ...current,
      // 잠금 안에서 시작점을 고른다. 이미 `agent`가 있으면 그쪽이 사실이고, 없으면 승계할 값이
      // 시작점이다 — 둘을 나누면 승계 직전의 부분 갱신이 옛 값을 고아로 만든다.
      agent: sanitizeAgentOptionsData(mutate(current.agent ?? carryOver.carried() ?? {})).data,
    }));
    carryOver.consume();
    return next.agent ?? {};
  };

  return {
    load: () => {
      carryOver.probe();
      const current = store.load().agent;
      if (current !== undefined) return current;
      if (!carryOver.pending()) return {};
      try {
        return commit((value) => value);
      } catch {
        // 락 경합·쓰기 실패는 결론이 아니다. 승계될 값으로 이번 읽기에 답하고 다음 접근이 다시 시도한다.
        return carryOver.carried() ?? {};
      }
    },
    update: (mutate) => {
      carryOver.probe();
      if (!carryOver.settled()) {
        throw new Error(
          `Agent options were not written: a previous settings file (${carryOver.sourcePaths.join(", ")}) `
          + "could not be read, and writing now would strand it. Make that file readable or remove it, then retry.",
        );
      }
      return commit(mutate);
    },
  };
}

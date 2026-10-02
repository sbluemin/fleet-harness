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

/** Host-side Theater admission keeps the shared infra schema independent of workspace registration. */
export interface TheaterSystemPromptService {
  readonly exists: (theaterId: string) => boolean;
  readonly read: (theaterId: string | undefined) => ClaudeCodeTheaterSystemPrompt | null;
  readonly save: (theaterId: string, prompt: ClaudeCodeTheaterSystemPrompt | null) => ClaudeCodeTheaterSystemPrompt | null;
  /**
   * Whether this Theater's Claude Code sessions keep their subagents. False (the default) means a
   * subagent call is answered in place of running, by whatever the host registered for that.
   */
  readonly subagentsKept: (theaterId: string | undefined) => boolean;
  readonly keepSubagents: (theaterId: string, kept: boolean) => boolean;
  /** Called only when a forgotten Theater's grace period expires. Idempotent for purge retries. */
  readonly purge: (theaterId: string) => void;
}

export function createTheaterSystemPromptService(
  options: AgentOptionsService,
  isRegistered: (theaterId: string) => boolean,
): TheaterSystemPromptService {
  return {
    exists: isRegistered,
    read(theaterId) {
      return theaterId && isRegistered(theaterId)
        ? options.load().claudeCodeTheaterSystemPrompts?.[theaterId] ?? null
        : null;
    },
    save(theaterId, prompt) {
      if (!isRegistered(theaterId)) throw new Error("theater_not_found");
      // Default mode with no user instructions is absence, not a redundant override.
      const value = prompt?.mode === "on" && prompt.body.trim().length === 0 ? null : prompt;
      const updated = options.update((current) => {
        const prompts = { ...current.claudeCodeTheaterSystemPrompts };
        if (value === null) delete prompts[theaterId];
        else prompts[theaterId] = value;
        const { claudeCodeTheaterSystemPrompts: _previous, ...rest } = current;
        return Object.keys(prompts).length ? { ...rest, claudeCodeTheaterSystemPrompts: prompts } : rest;
      });
      return updated.claudeCodeTheaterSystemPrompts?.[theaterId] ?? null;
    },
    subagentsKept(theaterId) {
      return !!theaterId && isRegistered(theaterId) && options.load().claudeCodeTheaterSubagents?.[theaterId] === true;
    },
    keepSubagents(theaterId, kept) {
      if (!isRegistered(theaterId)) throw new Error("theater_not_found");
      const updated = options.update((current) => withTheaterSubagents(current, theaterId, kept));
      return updated.claudeCodeTheaterSubagents?.[theaterId] === true;
    },
    purge(theaterId) {
      // The registry no longer contains the Theater, so only its stored id is needed here.
      options.update((current) => {
        const released = withTheaterSubagents(current, theaterId, false);
        if (!released.claudeCodeTheaterSystemPrompts?.[theaterId]) return released;
        const prompts = { ...released.claudeCodeTheaterSystemPrompts };
        delete prompts[theaterId];
        const { claudeCodeTheaterSystemPrompts: _previous, ...rest } = released;
        return Object.keys(prompts).length ? { ...rest, claudeCodeTheaterSystemPrompts: prompts } : rest;
      });
    },
  };
}

/** 기본값(대체)은 키가 없는 것이다 — 켜 둔 Theater만 남긴다. 바뀔 것이 없으면 같은 객체를 돌려준다. */
function withTheaterSubagents(current: AgentOptionsData, theaterId: string, kept: boolean): AgentOptionsData {
  if ((current.claudeCodeTheaterSubagents?.[theaterId] === true) === kept) return current;
  const theaters: Record<string, true> = { ...current.claudeCodeTheaterSubagents };
  if (kept) theaters[theaterId] = true;
  else delete theaters[theaterId];
  const { claudeCodeTheaterSubagents: _previous, ...rest } = current;
  return Object.keys(theaters).length ? { ...rest, claudeCodeTheaterSubagents: theaters } : rest;
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

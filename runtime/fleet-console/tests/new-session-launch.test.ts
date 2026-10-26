// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { Objective } from "../features/objectives/shared/types.js";
import type { ObjectiveCluster } from "../features/objectives/shared/objective-clusters.js";

import { readNewSessionSelection } from "../features/workspace/client/conversation/new-session-preferences.js";
import { resolveMentionEntry } from "../features/workspace/client/conversation/new-session-mention.js";
import { getState, removeTheater, setState } from "../core/client/src/integration/store.js";
import type { ObjectiveRecord, TheaterInfo } from "../core/client/src/integration/types.js";

function makeTheater(id: string): TheaterInfo {
  return { id, label: id, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-01T00:00:00.000Z", hasWiki: false, activeAdmiralCount: 0 };
}

describe("new session preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("treats a corrupt entry as no memory rather than throwing", () => {
    window.localStorage.setItem("fleet-console.newSession.selection", "{not json");
    expect(readNewSessionSelection()).toEqual({ theaterId: null, model: null, effort: null });
  });
});

describe("pending request lifecycle", () => {
  it("drops a pending launch when its Theater is removed", () => {
    // 사라진 Theater를 가리키는 발사 요청은 실행하지 않고 함께 버린다.
    setState({
      theaters: [makeTheater("t1"), makeTheater("t2")],
      pendingLaunch: {
        theaterId: "t1",
        pluginId: "terminal",
        kind: { id: "claude", type: "agent", title: "Claude" },
        variant: { prompt: "do the thing" },
      },
    });

    removeTheater("t1");

    expect(getState().pendingLaunch).toBeNull();
  });
});

function makeObjective(id: string, overrides: Partial<ObjectiveRecord> = {}): ObjectiveRecord {
  return {
    id,
    commodoreId: "c1",
    theaterId: "th-a",
    title: id,
    ...({}),
    ts: { createdAt: 1, updatedAt: 1 },
    ...overrides,
  };
}

const MESSAGEABLE = new Map<string, ReadonlySet<string>>([["terminal", new Set(["agent"])]]);

describe("resolveMentionEntry", () => {
  // composer.open({ mentionObjectiveId })가 건네는 명시 행선지의 해소. 그 패널을 직접 가리킨 지시라
  // 어느 Theater인지는 가리지 않지만, 메시지를 받지 않는 타입·입력 대기 중인 대상은 거른다.
  const state = {
    ...getState(),
    theaters: [makeTheater("th-a"), makeTheater("th-b")],
    objectiveRecords: [
      makeObjective("op-live"),
      makeObjective("op-await", { id: "op-await" }),
      makeObjective("op-far", { theaterId: "th-b" }),
    ],
    objectiveRecordRuntime: { "op-await": { lifecycle: "live", activity: "awaiting" } as const },
  };

  it("refuses an objective waiting on its own prompt and an unknown id", () => {
    expect(resolveMentionEntry(state, MESSAGEABLE, "op-await")).toBeNull();
    expect(resolveMentionEntry(state, MESSAGEABLE, "op-missing")).toBeNull();
  });
});

// 대표 데스크톱 경로: 레지스트리가 정준 id를 붙인 뒤 행 선택·시작 화면·행위·세션 승계까지 같은 로컬 목표를 가리켜야 한다.
it("keeps a registry goal in its commander pane before and after its session arrives", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const { combineClusterSources, loadFeatureRegistry, FeatureRegistryProvider } = await import("../core/client/src/integration/feature-registry.js");
  const { CommodoreCommanderList } = await import("../features/workspace/client/commander-tab/commander-list.js");
  const { ConversationStage } = await import("../features/workspace/client/conversation/conversation-shell.js");
  const { useConsoleState } = await import("../core/client/src/hooks/use-store.js");
  const { openConversationSurface, getConversationSurface, closeConversationSurface } = await import("../features/workspace/client/conversation/conversation-surface-store.js");
  const { openCommanderSplit, getCommanderSplit, closeCommanderSplit } = await import("../features/workspace/client/conversation/commander-split-store.js");
  const { setConversationBodyRenderer, setConversationStandInComposer } = await import("../features/workspace/client/conversation/conversation-slots.js");
  const { upsertObjectiveLocally, removeObjectiveLocally } = await import("../features/objectives/client/objectives-state.js");
  const { installCommodoreBoard } = await import("../features/commodore/client/board.js");
  const owner = "11111111-1111-4111-8111-111111111111";
  const id = "22222222-2222-4222-8222-222222222222";
  const goal: Objective = {
    id, commodoreId: owner, theaterId: "t-pane", groupId: null, title: "Pane goal", createdAt: 1,
    commander: { sessionName: null, started: false }, note: "Goal brief", attachments: [], results: [],
    planning: false, criteriaOpen: false, stoppedAt: null, dueDate: null, today: false,
    addedBy: { kind: "commodore", commodoreId: owner, why: "Keep the goal beside its owner" },
    done: null, awaitingHandoff: false, awaitingReview: false, handoff: null, extensions: [], extensionActive: false,
    criteria: [], criteriaProposals: [], members: [], missions: [], followups: [], followupBatches: [], followupHistory: null,
    origin: null, decisionRequest: null, decisionRequestRevision: 0, decisionDelivery: null, decisions: [], personHolds: [],
    commenced: false, operator: "human", removed: null, merged: [],
  };
  const openQuestion = vi.fn();
  const question: ObjectiveCluster = {
    id: "commodore-ask:question", commodoreId: owner, theaterId: goal.theaterId, title: "Owner question", members: [], open: openQuestion,
    row: { groupId: null, order: 1, fold: [], commodore: true, decisionRequestedAt: 1 },
  };
  let localClusters: readonly ObjectiveCluster[] = [{
    id, commodoreId: owner, theaterId: goal.theaterId, title: goal.title, avatarObjectiveId: id, members: [],
    row: { groupId: null, order: 0, fold: [], glyph: "fresh" },
  }, question];
  const listeners = new Set<() => void>();
  const clusters = combineClusterSources([{ pluginId: "objectives", source: {
    get: () => localClusters, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  } }]);
  const registry = { ...await loadFeatureRegistry(), objectiveRecordClusters: clusters, conversationSurfaces: [{
    id: "test-commodore", title: () => "Owner conversation", render: () => h("p", null, "Owner conversation"), commanderSplit: () => owner,
  }] };
  const board = { loaded: true, objectives: [{ ...goal, running: false, waiting: false }] };
  const offBoard = installCommodoreBoard({
    read: () => board, subscribe: () => () => {}, subscribeFinished: () => () => {}, railEntryIds: [],
    finished: () => [], finishedLoaded: () => true, findFinished: () => null, serverReached() {}, loadFinished() {},
    openObjective() {}, openObjectiveFromCluster() {}, openObjectiveOnPhone() {}, revealObjective() {}, renderObjectiveAvatar: () => null,
  });
  const offBody = setConversationBodyRenderer(({ objectiveRecord }) => h("p", { "data-pane-session": objectiveRecord.id }, "Commander conversation"));
  const offComposer = setConversationStandInComposer((objectiveId) => h("textarea", { "data-pane-composer": objectiveId }));
  const previous = getState();
  setState({ objectiveRecords: [], nestedObjectiveRecords: [], activeObjectiveId: null, newSession: null, groups: [] });
  upsertObjectiveLocally(goal);
  expect(clusters.get()[0]?.id).toBe(`objectives:${id}`);
  // 기존에 저장한 선택은 호스트 묶음 id가 아니라 로컬 Objective id다.
  openCommanderSplit(owner, id);
  openConversationSurface("test-commodore", { commodoreId: owner });
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  function Screen() {
    const state = useConsoleState();
    return h(FeatureRegistryProvider, { value: registry },
      h(CommodoreCommanderList, { commodoreId: owner }),
      h(ConversationStage, { state, insets: { top: 0, right: 0, bottom: 0, left: 0 }, language: "en", objectiveRecordKinds: [], onClose() {},
        toolContext: { theaterId: null, pathContext: { kind: "root", relPath: null, label: "" }, language: "en", api: {} } as Parameters<typeof ConversationStage>[0]["toolContext"] }),
    );
  }
  try {
    await act(async () => root.render(h(Screen)));
    const row = () => node.querySelector<HTMLButtonElement>(`[data-cluster-row-id="objectives:${id}"] .side-bar-cluster-row-main`)!;
    expect(row().getAttribute("aria-current")).toBe("true");
    expect(node.querySelector(".objectives-fresh-title")?.textContent).toBe(goal.title);
    expect(node.querySelector("[data-pane-composer]")?.getAttribute("data-pane-composer")).toBe(id);
    expect(node.querySelector(".objectives-commodore-recent-actions")?.textContent).toContain("Keep the goal beside its owner");
    await act(async () => { closeCommanderSplit(); });
    await act(async () => row().click());
    expect(getCommanderSplit().picked[owner]).toBe(id);
    expect(node.querySelector(".objectives-fresh-title")?.textContent).toBe(goal.title);
    await act(async () => {
      localClusters = [{ ...localClusters[0]!, root: id, avatarObjectiveId: undefined, row: { groupId: null, order: 0, fold: [id] } }, question];
      setState({ objectiveRecords: [makeObjective(id, { commodoreId: owner, theaterId: goal.theaterId, title: goal.title })] });
      for (const listener of listeners) listener();
    });
    await act(async () => row().click());
    expect(node.querySelector("[data-pane-session]")?.getAttribute("data-pane-session")).toBe(id);
    expect(node.querySelector(".objectives-fresh-title")).toBeNull();
    expect(row().getAttribute("aria-current")).toBe("true");
    expect(getCommanderSplit().picked[owner]).toBe(id);
    expect(getConversationSurface()?.surfaceId).toBe("test-commodore");
    await act(async () => node.querySelector<HTMLButtonElement>('[data-cluster-row-id="objectives:commodore-ask:question"] .side-bar-cluster-row-main')!.click());
    expect(openQuestion).toHaveBeenCalledOnce();
    expect(getCommanderSplit().picked[owner]).toBe(id);
  } finally {
    await act(async () => root.unmount());
    node.remove(); closeConversationSurface(); closeCommanderSplit(); offComposer(); offBody(); offBoard();
    removeObjectiveLocally(id); setState(previous); canvas.mockRestore(); vi.unstubAllGlobals();
  }
});

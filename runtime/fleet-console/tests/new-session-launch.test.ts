// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { Objective } from "../features/objectives/shared/types.js";
import type { ObjectiveCluster } from "../features/objectives/shared/objective-clusters.js";

import { readNewSessionSelection } from "../features/workspace/client/conversation/new-session-preferences.js";
import { resolveMentionEntry } from "../features/workspace/client/conversation/new-session-mention.js";
import { getState, pruneRemovedCommodoreTheater, setState } from "../core/client/src/integration/store.js";
import type { ObjectiveRecord } from "../core/client/src/integration/types.js";

// jsdom 에 없는 애니메이션은 문맥 승계의 대상이 아니다.
vi.mock("../features/workspace/client/conversation/new-session-playground.js", () => ({ NewSessionPlayground: () => null }));

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
      pendingLaunch: {
        theaterId: "t1",
        pluginId: "terminal",
        kind: { id: "claude", type: "agent", title: "Claude" },
        variant: { prompt: "do the thing" },
      },
    });

    pruneRemovedCommodoreTheater("c1", "t1");

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
it("opens a registry goal as a full conversation before and after its session arrives", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  // jsdom 은 글자 범위의 기하를 제공하지 않는다. 이 테스트는 세션 승계를 보고, 머리 줄 배치는 실앱에서 검증한다.
  const range = vi.spyOn(document, "createRange").mockImplementation(() => Object.assign(new Range(), {
    getBoundingClientRect: () => new DOMRect(),
  }));
  const { combineClusterSources, loadFeatureRegistry, FeatureRegistryProvider } = await import("../core/client/src/integration/feature-registry.js");
  const { CommodoreCommanderList } = await import("../features/workspace/client/commander-tab/commander-list.js");
  const { ConversationStage } = await import("../features/workspace/client/conversation/conversation-shell.js");
  const { useConsoleState } = await import("../core/client/src/hooks/use-store.js");
  const { openConversationSurface, getConversationSurface, closeConversationSurface } = await import("../features/workspace/client/conversation/conversation-surface-store.js");
  const { connectFreshConversation, freshConversationSurface } = await import("../features/objectives/client/fresh-conversation.js");
  const { useConversationSurface, subscribeConversationSurface } = await import("../features/workspace/client/conversation/conversation-surface-store.js");
  const { setConversationBodyRenderer, setConversationStandInComposer } = await import("../features/workspace/client/conversation/conversation-slots.js");
  const { upsertObjectiveLocally, removeObjectiveLocally } = await import("../features/objectives/client/objectives-state.js");
  const { installCommodoreBoard } = await import("../features/commodore/client/board.js");
  const { readCommodoreList, replaceCommodoreList } = await import("../features/commodore/client/commodore-list.js");
  const { isCommodoreConversationSelected } = await import("../features/commodore/client/commodore-conversation.js");
  const { getViewedTheaterId } = await import("../core/client/src/integration/viewed-theater.js");
  const { openDefaultNewSession, openNewSessionComposer } = await import("../features/workspace/client/conversation/new-session-entry.js");
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
    id: "test-commodore", title: () => "Owner conversation", render: () => h("p", null, "Owner conversation"), commodoreId: () => owner,
  }, freshConversationSurface] };
  const board = { loaded: true, objectives: [{ ...goal, running: false, waiting: false }] };
  const offBoard = installCommodoreBoard({
    read: () => board, subscribe: () => () => {}, subscribeFinished: () => () => {}, railEntryIds: [],
    finished: () => [], finishedLoaded: () => true, findFinished: () => null, serverReached() {}, loadFinished() {},
    openObjective() {}, openObjectiveFromCluster() {}, openObjectiveOnPhone() {}, revealObjective() {}, renderObjectiveAvatar: () => null,
  });
  const offBody = setConversationBodyRenderer(({ objectiveRecord }) => h("p", { "data-pane-session": objectiveRecord.id }, "Commander conversation"));
  const offComposer = setConversationStandInComposer((objectiveId) => h("textarea", { "data-pane-composer": objectiveId }));
  const previous = getState();
  const previousCommodores = readCommodoreList();
  const otherOwner = "33333333-3333-4333-8333-333333333333";
  replaceCommodoreList([otherOwner, owner].map((commodoreId) => ({
    commodoreId, label: commodoreId, active: false, run: { phase: "idle", totals: { session: 0, costUsd: 0, actions: 0 } },
    theaters: [{ theaterId: goal.theaterId, label: "Shared Theater", status: "available" }],
  })));
  setState({ objectiveRecords: [], nestedObjectiveRecords: [], activeObjectiveId: null, newSession: null, groups: [] });
  upsertObjectiveLocally(goal);
  expect(clusters.get()[0]?.id).toBe(`objectives:${id}`);
  const offFresh = connectFreshConversation({ isActive: () => true, open: openConversationSurface, close: closeConversationSurface, current: getConversationSurface, subscribe: subscribeConversationSurface });
  openConversationSurface("test-commodore", { commodoreId: owner });
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  function Screen() {
    const state = useConsoleState();
    const surface = useConversationSurface();
    const selectedId = typeof surface?.params.objectiveId === "string" ? surface.params.objectiveId : state.activeObjectiveId;
    return h(FeatureRegistryProvider, { value: registry },
      h(CommodoreCommanderList, { commodoreId: owner, selectedId }),
      h(ConversationStage, { state, insets: { top: 0, right: 0, bottom: 0, left: 0 }, language: "en", objectiveRecordKinds: [], onClose() {},
        toolContext: { theaterId: null, pathContext: { kind: "root", relPath: null, label: "" }, language: "en", api: {} } as Parameters<typeof ConversationStage>[0]["toolContext"] }),
    );
  }
  try {
    await act(async () => root.render(h(Screen)));
    const row = () => node.querySelector<HTMLButtonElement>(`[data-cluster-row-id="objectives:${id}"] .side-bar-cluster-row-main`)!;
    await act(async () => row().click());
    expect(row().getAttribute("aria-current")).toBe("true");
    expect(node.querySelector(".objectives-fresh-title")?.textContent).toBe(goal.title);
    expect(node.querySelector("[data-pane-composer]")?.getAttribute("data-pane-composer")).toBe(id);
    expect(getConversationSurface()?.params.objectiveId).toBe(id);
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
    expect(getState().activeObjectiveId).toBe(id);
    expect(getConversationSurface()).toBeNull();
    await act(async () => node.querySelector<HTMLButtonElement>('[data-cluster-row-id="objectives:commodore-ask:question"] .side-bar-cluster-row-main')!.click());
    expect(openQuestion).toHaveBeenCalledOnce();
    expect(getState().activeObjectiveId).toBe(id);

    // 같은 Theater 를 가진 다른 사령관이 목록 첫 번째여도, 다음 세션은 보던 사령관의 세션이다.
    // 기존 목표 승계 검사만으로는 새 세션이 표면·활성 기록을 걷은 뒤 소유 문맥을 잃는 경계를 지나지 않는다.
    await act(async () => node.querySelector<HTMLButtonElement>(".commander-tab-direction")!.click());
    expect(getState().newSession).toEqual({ commodoreId: owner, theaterId: goal.theaterId });
    expect(getState().activeObjectiveId).toBeNull();
    expect(getConversationSurface()).toBeNull();
    expect(getViewedTheaterId()).toBe(goal.theaterId);
    expect(isCommodoreConversationSelected(owner)).toBe(true);
    expect(isCommodoreConversationSelected(otherOwner)).toBe(false);

    // 시작 전 목표의 표면도 소유자를 싣는다. 단축키·팔레트·composer.open이 같은 진입 규칙을 쓴다.
    await act(async () => openConversationSurface(freshConversationSurface.id, { objectiveId: id, commodoreId: owner, theaterId: goal.theaterId }));
    expect(getState().newSession).toBeNull();
    expect(getState().activeObjectiveId).toBeNull();
    expect(getConversationSurface()?.surfaceId).toBe(freshConversationSurface.id);
    await act(async () => openDefaultNewSession());
    const opened = getState().newSession;
    expect(opened).toEqual({ commodoreId: owner, theaterId: goal.theaterId });
    await act(async () => openNewSessionComposer());
    expect(getState().newSession).toBe(opened);
    expect(getViewedTheaterId()).toBe(goal.theaterId);
    expect(isCommodoreConversationSelected(owner)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    node.remove(); closeConversationSurface(); offFresh(); offComposer(); offBody(); offBoard();
    removeObjectiveLocally(id); setState(previous); replaceCommodoreList(previousCommodores); canvas.mockRestore(); range.mockRestore(); vi.unstubAllGlobals();
  }
});

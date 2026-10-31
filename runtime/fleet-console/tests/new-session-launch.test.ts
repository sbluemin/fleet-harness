// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { Objective } from "../features/objectives/shared/types.js";
import type { ObjectiveCluster, ObjectiveClusterRow } from "../features/objectives/shared/objective-clusters.js";

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

describe("kept commodore owner", () => {
  // 레일 머리가 가운데가 아니라 레일을 따르는 조건 — 유지 상태일 때만 사령관 주인이다.
  it("keeps the panel owner only on the right with its commander centered", async () => {
    const { keptCommodoreOwnerOf } = await import("../features/workspace/client/commander-tab/commander-rows.js");
    expect(keptCommodoreOwnerOf("right", "c1", true)).toBe("c1");
    expect(keptCommodoreOwnerOf("left", "c1", true)).toBeNull();
    expect(keptCommodoreOwnerOf("right", null, true)).toBeNull();
    expect(keptCommodoreOwnerOf("right", "c1", false)).toBeNull();
  });

  // 유지 상태의 탭 줄은 사령관 탭 3개뿐 — 기본 「구성원」 탭은 펼친 행 패널의 「구성원」 탭이 대신한다.
  it("hides the core members tab while the kept panel stands", async () => {
    const { hidesCoreMembersTab } = await import("../features/workspace/client/conversation/conversation-shell.js");
    expect(hidesCoreMembersTab(false, "c1")).toBe(true);
    expect(hidesCoreMembersTab(true, null)).toBe(true);
    expect(hidesCoreMembersTab(false, null)).toBe(false);
  });
});

describe("kept commander tabs", () => {
  // 우측 펼침의 탭 유지 — 주인이 바뀌면 걷히고, 같은 주인이 돌아오면 두 겹으로 서지 않는다.
  const tab = (id: string) => ({ id, title: () => id, icon: () => null, render: () => null });

  it("releases the kept registration when the owner changes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const tabs = await import("../core/client/src/chrome/rail/objective-tabs.js");
    const node = document.createElement("div"); document.body.append(node);
    const root = createRoot(node);
    const seen: string[][] = [];
    function Probe() {
      seen.push(tabs.useRegisteredConversationObjectiveTabs().map((entry) => entry.id));
      return null;
    }
    try {
      await act(async () => root.render(h(Probe)));
      const disposers = await act(async () => [tab("kt-1"), tab("kt-2")].map((entry) => tabs.registerConversationObjectiveTab(entry)));
      await act(async () => root.render(h(Probe)));
      tabs.keepConversationObjectiveTabs("c1", () => { for (const dispose of disposers) dispose(); });
      // 다른 주인으로 바뀌면 걷힌다.
      tabs.releaseKeptConversationObjectiveTabs("c2");
      await act(async () => root.render(h(Probe)));
      expect(seen.at(-1)).toEqual([]);
    } finally {
      tabs.releaseKeptConversationObjectiveTabs(null);
      await act(async () => root.unmount());
      node.remove(); vi.unstubAllGlobals();
    }
  });

  it("does not double-register when the same owner returns", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const tabs = await import("../core/client/src/chrome/rail/objective-tabs.js");
    const node = document.createElement("div"); document.body.append(node);
    const root = createRoot(node);
    const seen: string[][] = [];
    function Probe() {
      seen.push(tabs.useRegisteredConversationObjectiveTabs().map((entry) => entry.id));
      return null;
    }
    try {
      await act(async () => root.render(h(Probe)));
      const first = await act(async () => [tab("kt-1"), tab("kt-2")].map((entry) => tabs.registerConversationObjectiveTab(entry)));
      tabs.keepConversationObjectiveTabs("c1", () => { for (const dispose of first) dispose(); });
      // 같은 사령관으로 돌아오면 보관만 버리고 새로 등록한다 — 같은 id가 두 겹으로 서지 않는다.
      tabs.adoptKeptConversationObjectiveTabs("c1");
      const second = await act(async () => [tab("kt-1"), tab("kt-2")].map((entry) => tabs.registerConversationObjectiveTab(entry)));
      await act(async () => root.render(h(Probe)));
      expect(seen.at(-1)).toEqual(["kt-1", "kt-2"]);
      for (const dispose of second) dispose();
      await act(async () => root.render(h(Probe)));
      expect(seen.at(-1)).toEqual([]);
    } finally {
      tabs.releaseKeptConversationObjectiveTabs(null);
      await act(async () => root.unmount());
      node.remove(); vi.unstubAllGlobals();
    }
  });
});
describe("commander rail keep rule", () => {
  // 우측 펼침의 행 펼치기와 레일 유지가 함께 읽는 판정 — 진행 중·시작 전·완료 지휘관만 그 사령관의 것으로 본다.
  const cluster = (id: string, init: Partial<ObjectiveCluster>): ObjectiveCluster => ({
    id, theaterId: "th-a", title: id, members: [], ...init,
  });
  const row = (fold: readonly string[]): ObjectiveClusterRow => ({ groupId: null, order: 0, fold });

  it("treats running, not-started and finished commanders of the commodore as its own", async () => {
    const { isCommanderObjective } = await import("../features/workspace/client/commander-tab/commander-rows.js");
    const clusters = [
      cluster("c-live", { commodoreId: "c1", root: "op-live", row: row(["op-live"]) }),
      cluster("c-fresh", { commodoreId: "c1", avatarObjectiveId: "op-fresh", row: row(["op-fresh"]) }),
      cluster("c-done", { commodoreId: "c1", root: "op-done", row: row(["op-done"]) }),
    ];
    expect(isCommanderObjective(clusters, "c1", "op-live")).toBe(true);
    expect(isCommanderObjective(clusters, "c1", "op-fresh")).toBe(true);
    expect(isCommanderObjective(clusters, "c1", "op-done")).toBe(true);
  });

  it("rejects other commodores, members and unknown ids", async () => {
    const { isCommanderObjective } = await import("../features/workspace/client/commander-tab/commander-rows.js");
    const clusters = [
      cluster("c-other", { commodoreId: "c2", root: "op-other", row: row(["op-other"]) }),
      cluster("c-mixed", {
        commodoreId: "c1", root: "op-root", decisionRequest: true,
        members: [{ objectiveId: "op-member", label: "member", after: [], progress: "open" }],
        row: row(["op-root", "op-member"]),
      }),
    ];
    expect(isCommanderObjective(clusters, "c1", "op-other")).toBe(false);
    expect(isCommanderObjective(clusters, "c1", "op-member")).toBe(false);
    expect(isCommanderObjective(clusters, "c1", "op-missing")).toBe(false);
  });
});

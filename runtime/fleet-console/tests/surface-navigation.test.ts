// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import type { SidebarRemotePage } from "../features/workspace/shared/sidebar-remote.js";
import type { Objective } from "../features/objectives/shared/types.js";
import { Terminal, type ILink } from "@xterm/xterm";
import { createFileLinkProvider } from "../features/execution/client/terminal/shared/terminal-file-links.js";
import type { PaneDescriptor } from "../features/workspace/shared/pane.js";
import { parseFileRef, isAbsolute } from "@fleet-console/markdown/file-ref";
import { createHostCapabilities, createHostPaneTargetPorts } from "../core/client/src/integration/feature-capabilities.js";
import { landPaneTarget, type PaneTargetBinding } from "../core/client/src/chrome/pane/pane-target.js";
import { getPaneStoreSnapshot, __resetPaneStoreForTests } from "../core/client/src/chrome/pane/pane-store.js";
import { getRailStoreSnapshot } from "../core/client/src/chrome/rail/rail-store.js";
import { getState, setState, setActiveObjective, applyObjectiveRemoved } from "../core/client/src/integration/store.js";
import { prepareCommodoreRemovalStage } from "../core/client/src/integration/commodore-deletion.js";
import { bindConsoleNavigate } from "../core/client/src/integration/console-location.js";
import { searchRailPanels } from "../core/client/src/integration/objective-search.js";

import { getSettingsModalSnapshot, closeSettingsModal } from "../features/settings/client/settings-door.js";
import { clearConversationStage, closeConversationSurface, getConversationSurface, isConversationStageEmpty, openConversationSurface, resumeConversationStage } from "../features/workspace/client/conversation/conversation-surface-store.js";
import { closeTheaterInbox, readTheaterInboxState } from "../features/workspace/client/theater-inbox/store.js";
import { getViewedTheaterId } from "../core/client/src/integration/viewed-theater.js";
import { replaceCommodoreList, setZoneCommodore } from "../features/commodore/client/commodore-list.js";
import { EMPTY_RUN_TOTALS } from "../features/commodore/shared/contracts/types.js";
import { __setViewportNarrowForTests } from "../core/client/src/integration/view-mode-store.js";
import { getMobileDestination, registerMobileDestinationEntries, setMobileDestination } from "../core/client/src/chrome/mobile/mobile-store.js";

// 원격 이름 편집은 화면 전환과 경쟁한다. API 권한 검사만으로는 두 번째 클릭 뒤 draft/초점을 잃고 다른 문서를 여는 결함을 잡지 못한다.
it("keeps remote title and alias edits in the requesting document across fresh snapshots", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  // 글꼴 배치는 실앱에서 검증한다. 이 경계는 글자 안 클릭의 실제 React event/편집/전환 흐름만 측정한다.
  const box = new DOMRect(62, 692, 200, 20);
  const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(box);
  const range = vi.spyOn(document, "createRange").mockImplementation(() => Object.assign(new Range(), { getClientRects: () => [new DOMRect(62, 704, 128, 16)], getBoundingClientRect: () => box }));
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ general: {} }));
  const store = await import("../features/workspace/client/sidebar/remote-sidebar-store.js");
  const transport = await import("../features/remote-access/client/sidebar-transport.js");
  const { RemoteSidebarRow } = await import("../features/workspace/client/sidebar/remote-sidebar-row.js");
  const source = { id: "objective", commodoreId: "owner", theaterId: "theater", groupId: null, title: "Remote goal", note: "brief", createdAt: 1,
    commander: { sessionName: null, started: true }, hasSession: true, planning: false, commenced: true, criteriaOpen: false,
    done: null, removed: null, awaitingHandoff: false, awaitingReview: false, handoff: null, stoppedAt: null, dueDate: null, today: false,
    members: [], missions: [], criteria: [], criteriaProposals: [], attachments: [], results: [], extensions: [], extensionActive: false,
    followups: [], followupBatches: [], followupHistory: null, origin: null, decisionRequest: null, decisionRequestRevision: 0,
    consultations: [], decisionDelivery: null, decisions: [], personHolds: [], addedBy: null, requestSource: null, merged: [] } as Objective;
  const face = { state: "idle" as const, activity: null, look: null };
  let page: SidebarRemotePage = { v: 1, at: 1, writable: true, autonomous: false, taskforceEnabled: false, computerUseAvailable: false, next: null, commodores: [], groups: [],
    preferences: { sort: { key: "name", direction: "asc", answerFirst: true, grouped: false }, folds: { fresh: false, done: false, settled: false }, keepExpanded: false, showSettled: true },
    objectives: [{ objective: source, computerUseEnabled: false, ownWorking: false, faces: { objective: face }, tool: null }] };
  const read = vi.spyOn(store, "useRemoteSidebar").mockImplementation(() => ({ page, error: null }));
  const refresh = vi.spyOn(store, "refreshRemoteSidebar").mockImplementation(() => {});
  const write = vi.spyOn(transport, "sidebarJson").mockResolvedValue({ ok: true });
  const onOpen = vi.fn();
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  const summary = { ...face, id: "owner", name: "Remote owner", preview: "reply", live: false, decisions: 0, browsing: false };
  const render = () => root.render(h(RemoteSidebarRow, { console: "entry", row: { consoleId: "remote", commodoreId: "owner", name: "Remote owner", home: false, machineLabel: "Other", machineAddress: "other", status: "ready" }, summary, directory: page, compact: false,
    frame: { dragging: false, dropTarget: false, dragOffsetY: 0, menuTarget: false, onMenu: () => {}, onPointerDragStart: () => {} }, onOpen, placement: () => null }));
  const doubleClick = async (element: HTMLElement, clientX = 74) => {
    const click = (detail: number) => { for (const type of ["mousedown", "mouseup", "click"]) element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, detail, clientX, clientY: 702 })); };
    await act(async () => click(1));
    await act(async () => { vi.advanceTimersByTime(50); click(2); element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2, clientX, clientY: 702 })); });
  };
  try {
    await act(async () => render());
    await doubleClick(node.querySelector<HTMLElement>(".side-bar-cluster-row-title")!, 250);
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(node.querySelector(".side-bar-cluster-row-rename-input")).toBeNull();
    expect(onOpen).toHaveBeenCalledOnce();
    onOpen.mockClear();
    await doubleClick(node.querySelector<HTMLElement>(".side-bar-cluster-row-title")!);
    const title = node.querySelector<HTMLInputElement>(".side-bar-cluster-row-rename-input")!;
    expect(title).not.toBeNull();
    await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; setter.call(title, "Edited goal"); title.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { page = { ...page, at: 2, objectives: page.objectives.map((entry) => ({ ...entry, objective: { ...entry.objective, title: "Updated remotely" } })) }; render(); vi.advanceTimersByTime(700); });
    expect(document.activeElement).toBe(title);
    expect(title.value).toBe("Edited goal");
    expect(title.closest("button")).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    await act(async () => { title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(write).toHaveBeenCalledWith("entry", "patch", { objectiveId: "objective", patch: { title: "Edited goal" } }, undefined);
    await doubleClick(node.querySelector<HTMLElement>(".side-bar-theater-name")!);
    expect(node.querySelector(".side-bar-theater-alias-input")).not.toBeNull();
    await act(async () => { page = { ...page, at: 3 }; render(); vi.advanceTimersByTime(700); });
    expect(document.activeElement).toBe(node.querySelector(".side-bar-theater-alias-input"));
    expect(onOpen).not.toHaveBeenCalled();
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    const trigger = node.querySelector<HTMLButtonElement>(".commodore-dock-trigger")!;
    await act(async () => { trigger.focus(); trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })); });
    const tools = [...node.querySelectorAll<HTMLButtonElement>(".commodore-dock-strip button")];
    expect(document.activeElement).toBe(tools[0]);
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    expect(document.activeElement).toBe(tools.at(-1));
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(document.activeElement).toBe(trigger);
    expect(onOpen).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); node.remove(); read.mockRestore(); refresh.mockRestore(); write.mockRestore(); fetch.mockRestore(); range.mockRestore(); rect.mockRestore(); canvas.mockRestore(); vi.useRealTimers(); vi.unstubAllGlobals();
  }
});

// 기존 팔레트·컴포저 검사는 외부 처리기의 Theater 착지와 재요청을 실행하지 않는다.
// 이 대표 경로는 SDK 요청과 팔레트가 같은 저장소 경계에서 주소를 보존하는지 확인한다.
// 파일을 읽으려는 요청이 대화를 닫거나 설정 포커스 요청을 남기지 않는지도 같은 경계에서 확인한다.
afterEach(() => { __resetPaneStoreForTests(); closeSettingsModal(); closeConversationSurface(); closeTheaterInbox(); registerMobileDestinationEntries(new Set()); setMobileDestination({ kind: "home" }); __setViewportNarrowForTests(false); replaceCommodoreList([]); setZoneCommodore(null); });

it("lands SDK and palette targets in the requested Theater with a fresh request id", async () => {
  const unbind = bindConsoleNavigate(() => undefined);
  replaceCommodoreList([{ commodoreId: "owner", label: "owner", theaters: [{ theaterId: "b", label: "b", status: "available" as const }, { theaterId: "a", label: "a", status: "available" as const }], active: false, run: { phase: "off" as const, totals: EMPTY_RUN_TOTALS } }]);
  const pane: PaneDescriptor = { id: "file-doc", role: "detail", mounts: ["rail"], title: () => "File", render: () => null };
  const bindings: PaneTargetBinding[] = [{ entry: { id: "files", title: "Files", icon: null, panes: [pane.id], handles: { openFile: () => ({ paneId: pane.id }) } }, panes: [pane] }];
  const host = createHostCapabilities(undefined, { railBindings: bindings });
  openConversationSurface("conversation", { theaterId: "b", commodoreId: "owner" });
  const conversation = getConversationSurface();
  expect(conversation).not.toBeNull();
  try {
    const request = { theaterId: "b", path: "src/main.ts", pathKind: "theater-relative" as const, line: 12, column: 3, source: "agent-chat" as const };
    expect(await host.navigate.openFile(request)).toEqual({ ok: true });
    const first = getPaneStoreSnapshot().rail[0]!;
    expect(getRailStoreSnapshot().activePanelId).toBe("files");
    expect(first.params).toMatchObject({ theaterId: "b", path: "src/main.ts", pathKind: "theater-relative", line: "12", column: "3" });
    expect(await host.navigate.openFile(request)).toEqual({ ok: true });
    expect(getPaneStoreSnapshot().rail[0]!.params.requestId).not.toBe(first.params.requestId);
    expect(getConversationSurface()).toBe(conversation);
    expect(readTheaterInboxState()).toBeNull();
    setZoneCommodore("owner");
    expect(landPaneTarget({ paneId: pane.id, theaterId: "a", params: { path: "README.md" } }, createHostPaneTargetPorts(bindings), "files")).toEqual({ ok: true });
    expect(getPaneStoreSnapshot().rail[0]!.params).toMatchObject({ theaterId: "a", path: "README.md" });
    expect(getViewedTheaterId()).toBe("a");
    expect(getConversationSurface()).toBeNull();
    expect(readTheaterInboxState()?.focusRequest).toBeNull();
    expect(getRailStoreSnapshot().activePanelId).toBe("files");
    const queries: string[] = [];
    const results = await searchRailPanels([{ id: "files", title: "Files", fileReferences: true, search: async ({ query }) => {
      queries.push(query);
      return [
        { id: "fuzzy", title: "Other", activate: () => ({ paneId: pane.id }) },
        { id: "exact", title: "main.ts", exact: true, activate: () => ({ paneId: pane.id, theaterId: "b", params: { path: query } }) },
      ];
    } }], "src/main.ts:12:3", "b", new AbortController().signal);
    expect(queries).toEqual(["src/main.ts"]);
    expect(results[0]!.results[0]!.exact).toBe(true);
    const target = await results[0]!.results[0]!.activate();
    expect(target).toBeTruthy();
    landPaneTarget(target!, createHostPaneTargetPorts(bindings), "files");
    expect(getPaneStoreSnapshot().rail[0]!.params).toMatchObject({ theaterId: "b", path: "src/main.ts", line: "12", column: "3" });

    const settings = { ...pane, id: "settings", role: "primary" as const };
    const settingsHost = createHostCapabilities(undefined, { railBindings: [{ entry: { id: "settings", title: "Settings", icon: null, panes: ["settings"] }, panes: [settings] }] });
    settingsHost.rail.open("settings", { section: "experiments" });
    expect(getSettingsModalSnapshot()).toEqual({ open: true, section: "experiments" });
    expect(await createHostCapabilities().navigate.openFile(request)).toEqual({ ok: false, reason: "no_handler" });
    host.consoleState.viewTheater!("a");
    expect(readTheaterInboxState()).toMatchObject({ theaterId: "a", address: { sectionId: "console:settings", pageId: "theaters" } });
    expect(readTheaterInboxState()?.focusRequest).not.toBeNull();

    // 데스크톱 착지 검사만으로는 폰 화면이 주소로 primary 를 다시 열 때 요청을 잃는 결함을 잡지 못한다.
    const destinationPane = { ...pane, id: "destination-pane", role: "primary" as const };
    const destinationHost = createHostCapabilities(undefined, { railBindings: [{ entry: { id: "destination", title: "Destination", icon: null, panes: [destinationPane.id], mobile: { destination: { order: 0 } } }, panes: [destinationPane] }] });
    // 모바일 틀이 아직 목적지 목록을 등록하지 않은 배치 전환 순간에도 선언만으로 화면에 착지한다.
    __setViewportNarrowForTests(true);
    destinationHost.rail.open("destination", { theaterId: "b", page: "details" });
    const address = getMobileDestination();
    expect(address).toMatchObject({ kind: "plugin", entryId: "destination", params: { theaterId: "b", page: "details" } });
    if (address.kind !== "plugin") throw new Error("destination not opened");
    destinationHost.rail.open(address.entryId, address.params);
    expect(getPaneStoreSnapshot().rail.find((instance) => instance.paneId === destinationPane.id)?.params).toMatchObject({ theaterId: "b", page: "details" });
  } finally { unbind(); }
});

it("reads an unregistered objective theater as the owning commodore's registered Theater", () => {
  const commodore = (commodoreId: string, theaterIds: readonly string[]) => ({
    commodoreId, label: commodoreId, theaters: theaterIds.map((theaterId) => ({ theaterId, label: theaterId, status: "available" as const })), active: false, run: { phase: "off" as const, totals: EMPTY_RUN_TOTALS },
  });
  setState({ activeObjectiveId: null, objectiveRecords: [] });
  replaceCommodoreList([
    commodore("owner-a", ["shared"]),
    commodore("owner-b", ["shared"]),
    commodore("owner-c", ["shared", "other"]),
  ]);
  openConversationSurface("objective-fresh", { objectiveId: "stored", theaterId: "9c56bd5e5148", commodoreId: "owner-a" });
  expect(getViewedTheaterId()).toBe("shared");
  openConversationSurface("objective-fresh", { objectiveId: "stored-b", theaterId: "9c56bd5e5148", commodoreId: "owner-b" });
  expect(getViewedTheaterId()).toBe("shared");
  openConversationSurface("objective-fresh", { objectiveId: "ambiguous", theaterId: "9c56bd5e5148", commodoreId: "owner-c" });
  expect(getViewedTheaterId()).toBeNull();
  openConversationSurface("objective-fresh", { objectiveId: "picked", theaterId: "other", commodoreId: "owner-c" });
  expect(getViewedTheaterId()).toBe("other");
  openConversationSurface("objective-fresh", { objectiveId: "foreign", theaterId: "other", commodoreId: "owner-a" });
  expect(getViewedTheaterId()).toBeNull();
  openConversationSurface("objective-fresh", { objectiveId: "hash", theaterId: "9c56bd5e5148", commodoreId: "owner-a" });
  expect(getViewedTheaterId()).toBe("shared");
  closeConversationSurface();
  const stored = { id: "stored-record", commodoreId: "owner-a", theaterId: "9c56bd5e5148", title: "Stored", ts: { createdAt: 1, updatedAt: 1 } };
  setState({ objectiveRecords: [stored], activeObjectiveId: stored.id });
  expect(getViewedTheaterId()).toBe("shared");
});

// 기존 이동 검사는 삭제 뒤 늦게 실행되는 기본 선택이 다른 수신자를 활성화하는 경계를 지나지 않는다.
it("keeps a deleted conversation's stage empty until an explicit conversation is opened", () => {
  const before = getState();
  __setViewportNarrowForTests(false);
  try {
    setState({});
    openConversationSurface("commodore", { commodoreId: "deleted-owner" });
    prepareCommodoreRemovalStage("deleted-owner");
    expect(getConversationSurface()).toBeNull();
    expect(isConversationStageEmpty()).toBe(true);
    // 이전 render의 effect나 기본 선택은 명시적으로 비운 무대를 다시 채우지 못한다.
    setActiveObjective("other-owner-objective", { fromStage: true });
    expect(getState().activeObjectiveId).toBeNull();
    setActiveObjective("chosen-objective");
    expect(isConversationStageEmpty()).toBe(false);
    expect(getState().activeObjectiveId).toBe("chosen-objective");

    clearConversationStage();
    openConversationSurface("commodore", { commodoreId: "chosen-owner" });
    expect(isConversationStageEmpty()).toBe(false);
    // 보통 표면 닫기와 보관의 null 선택에는 삭제 전용 차단을 켜지 않는다.
    closeConversationSurface();
    setActiveObjective(null);
    setActiveObjective("remaining-objective", { fromStage: true });
    expect(getState().activeObjectiveId).toBe("remaining-objective");

    const target = { id: "target-objective", commodoreId: "deleted-owner", theaterId: "a", title: "Target", ts: { createdAt: 1, updatedAt: 1 } };
    const other = { ...target, id: "other-objective", commodoreId: "other-owner", title: "Other" };
    setState({ objectiveRecords: [target, other] });
    setActiveObjective(target.id);
    prepareCommodoreRemovalStage(other.commodoreId);
    expect(getState().activeObjectiveId).toBe(target.id);
    expect(isConversationStageEmpty()).toBe(false);
    // removing는 목표 제거 전 들어온다. 삭제 버튼을 누른 창이 아니어도 소유자를 잃기 전에 비운다.
    prepareCommodoreRemovalStage(target.commodoreId);
    applyObjectiveRemoved(target.id);
    setActiveObjective(other.id, { fromStage: true });
    expect(getState().objectiveRecords).toEqual([other]);
    expect(getState().activeObjectiveId).toBeNull();
    expect(isConversationStageEmpty()).toBe(true);
    // 사령관 삭제 신호 없는 보통 목표 제거는 기존 기본 선택을 그대로 허용한다.
    setState({ objectiveRecords: [target, other] });
    setActiveObjective(target.id);
    applyObjectiveRemoved(target.id);
    setActiveObjective(other.id, { fromStage: true });
    expect(getState().activeObjectiveId).toBe(other.id);
    expect(isConversationStageEmpty()).toBe(false);
  } finally { resumeConversationStage(); setState(before); }
});

it("keeps file coordinates separate from schemes and absolute-path classification", () => {
  expect(parseFileRef('("src/main.ts:12:3"),')).toEqual({ path: "src/main.ts", line: 12, column: 3 });
  const absolute = parseFileRef("C:\\work\\main.ts(12,3)");
  expect(absolute).toEqual({ path: "C:/work/main.ts", line: 12, column: 3 });
  expect(isAbsolute(absolute!)).toBe(true);
  expect(parseFileRef("src/main.ts#L12C3")).toEqual({ path: "src/main.ts", line: 12, column: 3 });
  expect(parseFileRef("https://example.com/main.ts:12")).toBeNull();
  expect(parseFileRef("main.ts:0")).toBeNull();
});

// 경로 파서 검사만으로는 터미널의 공백 토큰화와 셀 범위가 실제 open 대상에 미치는 영향을 잡지 못한다.
// production provider에서 대표 입력·과포획 방어·수정키 gate를 한 경계로 확인한다.
it("opens complete absolute file references without absorbing prose or neighboring paths", async () => {
  const terminal = new Terminal({ cols: 400, rows: 16, allowProposedApi: true });
  // DOM selection manager는 open 뒤 생긴다. 여기서는 gate를 검사하고 실제 드래그는 앱에서 검증한다.
  const hasSelection = vi.spyOn(terminal, "hasSelection").mockReturnValue(false);
  const windows = String.raw`C:\Users\hbkang\Desktop\99. Cowork\PPW_플랫폼서비스_설정기능_사전점의_체크리스트_20261007.md`;
  const posix = "/workspace/other notes/check.md";
  const lines = [
    `${windows} 뒤에 이어지는 일반 문장 and/or`,
    `두 경로: ${windows} 그리고 ${posix} 이어서 설명`,
    `(C:\\a b\\c.md), "C:\\d e\\f.md", '/g h/i.md', 다음 문장`,
    "src/a.ts:10:9 ./b.ts(3,1) src/c.ts#L4 and/or",
    "Saved to /Users/a/notes and opened report.md",
    "/etc/hosts file then edit x.md",
    "A / B test.md and/or",
    "yes / no, see c.md",
    String.raw`C:\notes\자기계발 노트.md 뒤의 설명`,
    "https://example.com/view?file=/workspace/notes/report.md",
    "https://example.com/view?file=/workspace/my notes/report.md",
    `Report: ${posix} then https://example.com/view?file=/workspace/notes/report.md`,
  ];
  const expected = [
    [windows],
    [windows, posix],
    ["C:\\a b\\c.md", "C:\\d e\\f.md", "/g h/i.md"],
    ["src/a.ts:10:9", "./b.ts(3,1)", "src/c.ts#L4"],
    ["/Users/a/notes"],
    ["/etc/hosts"],
    [],
    [],
    [String.raw`C:\notes\자기계발 노트.md`],
    [],
    [],
    [posix],
  ];
  const open = vi.fn(async () => ({ ok: true as const }));
  const onOutcome = vi.fn();
  const provider = createFileLinkProvider(terminal, {
    source: () => ({ context: () => ({ theaterId: "a", cwdRelative: "src" }), open }),
    isMac: true, onHover: () => undefined, onOutcome,
  });
  try {
    await new Promise<void>((resolve) => terminal.write(lines.join("\r\n"), resolve));
    const allLinks: ILink[][] = [];
    for (let index = 0; index < lines.length; index++) {
      const links = await new Promise<ILink[]>((resolve) => provider.provideLinks(index + 1, (result) => resolve(result ?? [])));
      allLinks.push(links);
      expect(links.map((link) => link.text)).toEqual(expected[index]);
      const line = terminal.buffer.active.getLine(index)!;
      for (const link of links) {
        expect(line.translateToString(false, link.range.start.x - 1, link.range.end.x)).toBe(link.text);
        const start = lines[index]!.indexOf(link.text);
        expect(line.translateToString(false, 0, link.range.start.x - 1)).toBe(lines[index]!.slice(0, start));
        expect(line.translateToString(true, link.range.end.x)).toBe(lines[index]!.slice(start + link.text.length));
      }
    }
    const link = allLinks[0]![0]!;
    const plain = new MouseEvent("mouseup", { detail: 1, cancelable: true });
    link.activate(plain, link.text);
    expect(plain.defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenLastCalledWith({ ok: false, reason: "activation_required" });
    onOutcome.mockClear();
    hasSelection.mockReturnValue(true);
    link.activate(new MouseEvent("mouseup", { detail: 1 }), link.text);
    expect(onOutcome).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    hasSelection.mockReturnValue(false);
    const modified = new MouseEvent("mouseup", { detail: 1, metaKey: true, cancelable: true });
    link.activate(modified, link.text);
    expect(modified.defaultPrevented).toBe(true);
    expect(open).toHaveBeenLastCalledWith({ theaterId: "a", path: windows.replaceAll("\\", "/"), pathKind: "absolute" });
    const relative = allLinks[3]![0]!;
    relative.activate(modified, relative.text);
    expect(open).toHaveBeenLastCalledWith({ theaterId: "a", path: "src/src/a.ts", pathKind: "theater-relative", line: 10, column: 9 });
    await Promise.resolve();
    expect(onOutcome).toHaveBeenLastCalledWith({ ok: true });
  } finally { terminal.dispose(); }
});

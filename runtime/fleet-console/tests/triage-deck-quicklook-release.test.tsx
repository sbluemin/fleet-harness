// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/client/src/plugin-registry.js", () => ({
  usePluginRegistry: () => ({
    plugins: [],
    operationKinds: [{
      pluginId: "test-plugin",
      type: "shell",
      title: "Test",
      render: () => null,
    }],
    settingsSections: [],
    notificationKinds: [],
    railPanels: [],
  }),
}));

import { OperationsCanvas } from "../core/client/src/canvas/canvas.js";
import { loadForTheater, setState as setCanvasState } from "../core/client/src/canvas/canvas-store.js";
import { resetTriageDeckZoomForTests, resetTriageTheater, setTriageActive } from "../core/client/src/canvas/triage-store.js";
import { TRIAGE_DECK_QUICKLOOK_DWELL_MS } from "../core/client/src/canvas/triage-watch-deck.js";
import type { ConsoleState, OperationNode } from "../core/client/src/types.js";

const THEATER = "theater-a";
const OPERATION: OperationNode = {
  id: "operation-a",
  theaterId: THEATER,
  type: "shell",
  pluginId: "test-plugin",
  title: "Operation A",
  payload: {},
  geometry: { x: 0, y: 0, width: 320, height: 200, zIndex: 1 },
  ts: { createdAt: 0, updatedAt: 0 },
};
const OPERATION_B: OperationNode = { ...OPERATION, id: "operation-b", title: "Operation B" };
const CATALOG = [{ id: "test-plugin", title: "Test", kinds: [{ id: "shell", type: "shell", title: "Shell" }] }];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  loadForTheater(THEATER);
  setCanvasState({ viewport: { x: 0, y: 0, zoom: 1 }, operations: { [OPERATION.id]: OPERATION.geometry! } });
  setTriageActive(true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  resetTriageDeckZoomForTests();
  setTriageActive(false);
  resetTriageTheater(THEATER);
  loadForTheater(null);
  container?.remove();
  root = null;
  container = null;
});

// Quick-Look은 칸을 최대 1.95배로 키워 이웃 칸 위로 넘긴다 — 그 확대가 주인 없이 남으면 덱은
// "패널 하나만 밀도보다 크고 옆 칸을 덮은" 상태로 굳는다. 확대의 존재 근거는 포인터(또는 키보드
// 포커스)가 그 칸을 붙들고 있다는 사실이므로, 그 사실이 깨지는 모든 경로가 확대를 걷어야 한다.
describe("War Room deck Quick-Look release", () => {
  const enterDeck = () => {
    act(() => root!.render(createElement(OperationsCanvas, {
      state: STATE,
      catalog: CATALOG,
      canLaunch: true,
      renderKindIcon: () => null,
      onLaunchKind: () => {},
      onLaunchAtGeometry: () => {},
      onClose: () => {},
      onFocus: () => {},
      onRename: () => {},
      onSetAccent: () => {},
    })));
    // 진입 커튼이 걷혀야 덱이 선다.
    act(() => { vi.advanceTimersByTime(2_000); });
    const grid = container!.querySelector<HTMLElement>(".canvas-triage-deck-grid");
    expect(grid, "deck grid must be mounted once the curtain lifts").not.toBeNull();
    return grid!;
  };

  const cellFor = (operationId: string) =>
    container!.querySelector<HTMLElement>(`[data-triage-deck-card="${operationId}"]`)!;

  const hover = (cell: HTMLElement) => {
    act(() => cell.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })));
    act(() => { vi.advanceTimersByTime(TRIAGE_DECK_QUICKLOOK_DWELL_MS + 1); });
  };

  const expanded = () => [...container!.querySelectorAll(".canvas-triage-deck-cell.is-quicklook")]
    .map((cell) => (cell as HTMLElement).dataset.triageDeckCard);

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("releases the expanded cell when the pointer leaves the deck from outside any cell", () => {
    const grid = enterDeck();
    hover(cellFor(OPERATION.id));
    expect(expanded()).toEqual([OPERATION.id]);

    // 칸이 재정렬·재마운트로 포인터 밑을 빠져나간 뒤의 이탈은 칸에서 발화하지 않는다. 종전 판정은
    // "칸에서 시작한 out"만 해제로 받아, 이 경로에서 확대가 영영 주인 없이 남았다.
    act(() => grid.dispatchEvent(new PointerEvent("pointerout", {
      bubbles: true,
      pointerType: "mouse",
      relatedTarget: document.body,
    })));
    expect(expanded()).toEqual([]);
  });

  it("releases the expanded cell on the next pointer move over a cell-free part of the deck", () => {
    const grid = enterDeck();
    hover(cellFor(OPERATION.id));
    expect(expanded()).toEqual([OPERATION.id]);

    // 포인터를 치우면 풀려야 한다 — 덱 안이지만 칸이 아닌 자리(밴드 여백)로의 이동이 그 최소 신호다.
    act(() => grid.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" })));
    expect(expanded()).toEqual([]);
  });

  it("keeps the expansion while the pointer moves within the same cell", () => {
    enterDeck();
    const cell = cellFor(OPERATION.id);
    hover(cell);
    expect(expanded()).toEqual([OPERATION.id]);

    // 칸 안의 이동(본문 → 캡션 → 창 컨트롤)은 이탈이 아니다 — 여기서 걷히면 커서 밑에서 컨트롤이
    // 사라진다. 패널은 캔버스가 portal한 것이라 이 이동은 네이티브 버블로만 관측된다.
    const inside = cell.querySelector<HTMLElement>(".canvas-triage-deck-pick") ?? cell;
    act(() => inside.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" })));
    expect(expanded()).toEqual([OPERATION.id]);
    act(() => inside.dispatchEvent(new PointerEvent("pointerout", {
      bubbles: true,
      pointerType: "mouse",
      relatedTarget: cell,
    })));
    expect(expanded()).toEqual([OPERATION.id]);
  });

  it("hands the expansion to the cell the pointer moved onto", () => {
    enterDeck();
    const from = cellFor(OPERATION.id);
    const to = cellFor(OPERATION_B.id);
    hover(from);
    expect(expanded()).toEqual([OPERATION.id]);

    // 브라우저는 out(도착지=새 칸) → over(새 칸) 순으로 보낸다. 두 칸이 동시에 확대되면 안 된다.
    act(() => from.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: to })));
    act(() => to.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", relatedTarget: from })));
    act(() => { vi.advanceTimersByTime(TRIAGE_DECK_QUICKLOOK_DWELL_MS + 1); });
    expect(expanded()).toEqual([OPERATION_B.id]);
  });

  it("cancels an armed dwell that never became an expansion", () => {
    const grid = enterDeck();
    // 드웰 중(아직 확대 전)에 포인터가 칸을 떠나면 확대는 열리지 않아야 한다. 확대 상태만 보고
    // 판정하면 이 구간이 비어 있어, 떠난 뒤에 확대가 뒤늦게 열린다.
    act(() => cellFor(OPERATION.id).dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })));
    act(() => grid.dispatchEvent(new PointerEvent("pointerout", {
      bubbles: true,
      pointerType: "mouse",
      relatedTarget: document.body,
    })));
    act(() => { vi.advanceTimersByTime(TRIAGE_DECK_QUICKLOOK_DWELL_MS + 1); });
    expect(expanded()).toEqual([]);
  });
});

const STATE: ConsoleState = {
  connection: "connecting",
  connectionLostAt: null,
  channel: "unknown",
  activeTheme: "maritime",
  version: "test",
  updateAvailable: false,
  latestVersion: null,
  portMode: "dynamic",
  requestedPort: null,
  effectivePort: 0,
  portHonored: true,
  theaters: [{ id: THEATER, label: "Alpha" }],
  operations: [OPERATION, OPERATION_B],
  operationsHydrated: true,
  groups: [],
  activeTheaterId: THEATER,
  activeOperationId: OPERATION.id,
  activeOperationAcknowledged: true,
  operationRuntime: {
    [OPERATION.id]: { lifecycle: "live", activity: "idle" },
    [OPERATION_B.id]: { lifecycle: "live", activity: "idle" },
  },
  addingTheater: false,
  theaterError: null,
  operationsViewActive: true,
  operationSearchOpen: false,
  operationSearchSeed: null,
  quickLaunchOpen: false,
  quickLaunchPinned: false,
  quickLaunchFocusToggle: 0,
  quickLaunchExpandRequest: 0,
  quickLaunchDockSuppressed: false,
  quickLaunchDraft: null,
  quickLaunchError: null,
  pendingQuickLaunch: null,
  whatsNewOpen: false,
  releaseNotes: [],
  releaseNotesLoading: false,
  releaseNotesError: null,
  releaseNotesSourceRef: null,
  releaseNotesFetchedAt: null,
  releaseNotesStale: false,
  automaticWhatsNewVersion: null,
  selectedReleaseNoteKey: null,
  onboardingOpen: false,
  bootstrapped: true,
  pendingOperationFocus: null,
  keyboardFocusRequest: null,
  pendingSideBarAddTheater: false,
  pendingSideBarTheaterLaunch: null,
  launchMenuRequest: null,
  keyboardShortcutsOpen: false,
  operationNotifications: {},
  notificationPreferences: { globalMute: false, dnd: false, mutedTheaterIds: {} },
  codexReader: null,
  codexReaderExpanded: false,
};

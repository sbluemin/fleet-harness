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
import { getTriageDeckZoomLive, resetTriageDeckZoomForTests, resetTriageTheater, setTriageActive, setTriageDeckZoom, setTriageDeckZoomLive } from "../core/client/src/canvas/triage-store.js";
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

  // 확대된 칸의 캡션 컨트롤을 포인터로 누르면 그 컨트롤이 activeElement로 남는다 — 닫기 첫 클릭은
  // 확인만 무장하고 칸이 그대로 살아 있으므로 실제로 일어나는 상태다. 포커스가 확대를 붙들 자격은
  // 키보드로 옮겨온 포커스(:focus-visible)뿐이라, 그 두 경우가 갈리는지를 함께 잰다.
  // jsdom의 `:focus-visible`은 포커스가 있으면 무조건 참이라 포커스의 유래를 구분하지 못한다 —
  // 제품이 읽는 바로 그 술어만 이 테스트가 통제해, 두 방향을 모두 실제 계약으로 검증한다.
  const withFocusVisible = (visible: boolean, run: () => void) => {
    const original = Element.prototype.matches;
    Element.prototype.matches = function matchesWithFocusVisible(this: Element, selector: string): boolean {
      if (selector === ":focus-visible") return visible && this.ownerDocument.activeElement === this;
      return original.call(this, selector);
    };
    try { run(); } finally { Element.prototype.matches = original; }
  };

  it("does not let pointer-borne focus hold the expansion", () => {
    const grid = enterDeck();
    const cell = cellFor(OPERATION.id);
    hover(cell);
    expect(expanded()).toEqual([OPERATION.id]);

    withFocusVisible(false, () => {
      act(() => cell.querySelector<HTMLElement>(".canvas-triage-deck-pick")!.focus());
      expect(cell.contains(document.activeElement)).toBe(true);
      act(() => grid.dispatchEvent(new PointerEvent("pointerout", {
        bubbles: true,
        pointerType: "mouse",
        relatedTarget: document.body,
      })));
    });
    expect(expanded()).toEqual([]);
  });

  it("lets keyboard focus hold the expansion after the pointer leaves", () => {
    const grid = enterDeck();
    const cell = cellFor(OPERATION.id);

    withFocusVisible(true, () => {
      // 키보드 사용자는 포인터 없이 확대를 연다 — 포인터 이벤트가 그 확대를 걷어내면 안 된다.
      act(() => cell.querySelector<HTMLElement>(".canvas-triage-deck-pick")!.focus());
      expect(expanded()).toEqual([OPERATION.id]);
      act(() => grid.dispatchEvent(new PointerEvent("pointerout", {
        bubbles: true,
        pointerType: "mouse",
        relatedTarget: document.body,
      })));
      act(() => grid.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" })));
      expect(expanded()).toEqual([OPERATION.id]);
    });
  });

  // 덱 줌은 덱 위에서만 발화하므로, 밀도를 바꾸는 내내 포인터는 어떤 칸 위에 있다. 확대를 그대로
  // 두면 그 칸이 1.95배로 이웃을 덮은 채 밀도가 바뀌어, 사용자가 방금 조절한 판을 읽을 수 없다.
  it("releases the expansion when the deck density changes", () => {
    enterDeck();
    hover(cellFor(OPERATION.id));
    expect(expanded()).toEqual([OPERATION.id]);

    act(() => setTriageDeckZoomLive(0.6));
    expect(expanded()).toEqual([]);
  });

  // 라이브 배율은 표시용으로 소수 첫째 자리까지만 실린다 — 트랙패드의 작은 델타는 그 값을 그대로
  // 둔 채 칸 크기만 바꾸므로, 표시값을 신호로 삼으면 바로 그 구간에서 확대가 살아남는다. 제품이
  // 실제로 칸 크기를 정할 때 쓰는 경로(덱에 실리는 CSS 변수)로 잰다.
  it("releases the expansion on a density change too small to move the displayed zoom", () => {
    enterDeck();
    const cell = cellFor(OPERATION.id);
    hover(cell);
    expect(expanded()).toEqual([OPERATION.id]);

    // 제품과 같은 경로로 민다: 덱 위의 휠이 곧 밀도 조작이다. deltaY 9는 1.00 → 0.98로, 칸 크기는
    // 260px → 255px로 바뀌지만 표시 배율은 "1.0" 그대로다.
    const displayedBefore = getTriageDeckZoomLive();
    act(() => cell.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 9, deltaMode: 0 })));
    expect(getTriageDeckZoomLive(), "the displayed zoom must not move, or this case is not the one under test")
      .toBe(displayedBefore);
    expect(expanded()).toEqual([]);
  });

  // 폭 구간 안에서 행 높이만 넘어가는 델타 — 1.0020 → 1.0030은 폭을 261px로 둔 채 행 상한을
  // 210px → 211px로 옮긴다. 폭만 비교하면 이 전환이 신호를 만들지 못해 칸이 바뀌는데 확대가 남는다.
  it("releases the expansion when only the row size crosses a boundary", () => {
    act(() => setTriageDeckZoom(1.002));
    const grid = enterDeck();
    const owner = container!.querySelector<HTMLElement>(".operations-canvas")!;
    const read = () => ["--triage-card-min", "--triage-row-min", "--triage-row-max"]
      .map((name) => owner.style.getPropertyValue(name));
    const before = read();
    // 초기 배율을 세우는 tween이 이미 한 번 판을 다시 짰으므로, 무장은 포인터 이동이 증명한다.
    const cell = cellFor(OPERATION.id);
    act(() => cell.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" })));
    act(() => { vi.advanceTimersByTime(TRIAGE_DECK_QUICKLOOK_DWELL_MS + 1); });
    expect(expanded()).toEqual([OPERATION.id]);

    const displayedBefore = getTriageDeckZoomLive();
    act(() => grid.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -0.4534, deltaMode: 0 })));
    const after = read();
    expect(after[0], "the card width must stay put, or this case is not the one under test").toBe(before[0]);
    expect(after[2], "the row cap must be the value that moved").not.toBe(before[2]);
    expect(getTriageDeckZoomLive()).toBe(displayedBefore);
    expect(expanded()).toEqual([]);
  });

  it("does not re-arm on the entry the density change itself produced", () => {
    enterDeck();
    const cell = cellFor(OPERATION.id);
    act(() => setTriageDeckZoomLive(0.6));

    // 재배치되며 커서 밑으로 들어온 칸은 사용자가 겨눈 칸이 아니다 — 브라우저는 포인터가 멈춰
    // 있어도 그 진입을 boundary 이벤트로 보고하므로, 그것만으로 확대를 열면 밀도를 바꿀 때마다
    // 아무 칸이나 커진다.
    act(() => cell.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })));
    act(() => { vi.advanceTimersByTime(TRIAGE_DECK_QUICKLOOK_DWELL_MS + 1); });
    expect(expanded()).toEqual([]);
  });

  it("re-arms once the pointer actually moves after a density change", () => {
    enterDeck();
    const cell = cellFor(OPERATION.id);
    act(() => setTriageDeckZoomLive(0.6));

    // 이동이 곧 겨눔의 증명이다. 같은 칸에 머무르면 pointerover는 다시 오지 않으므로, 되살리는
    // 책임은 이동 쪽에 있어야 확대가 영영 닫히는 일이 없다.
    act(() => cell.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" })));
    act(() => { vi.advanceTimersByTime(TRIAGE_DECK_QUICKLOOK_DWELL_MS + 1); });
    expect(expanded()).toEqual([OPERATION.id]);
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

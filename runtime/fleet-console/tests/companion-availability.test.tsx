// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OperationRenderContext } from "../sdk/plugin/types.js";

const THEATER = "theater-availability";
const CODEX_OPERATION_ID = "operation-codex";
const CLAUDE_OPERATION_ID = "operation-claude";
const BARREN_OPERATION_ID = "operation-barren";

// "agent" kind는 실제 Terminal 플러그인 구도를 재현한다: 한 패널만 session model로 걸리고 나머지는 남는다.
const GATED_COMPANION_ID = "gated-panel";
const ALWAYS_COMPANION_ID = "always-panel";
// "barren" kind는 선언한 companion이 이 작전에서 전부 사용 불가한 상태다. 제품 kind로는 아직 도달할 수
// 없지만 available 계약이 보장하는 상태라, 계약 쪽에서 재현해 고정한다.
const BARREN_COMPANION_ID = "barren-panel";

function body(context: OperationRenderContext) {
  return createElement("div", {
    "data-testid": `body-${context.operationId}`,
    "data-hidden-companions": (context.hiddenCompanionPanelIds ?? []).join(","),
    "data-companions-open": String(context.companionsOpen ?? false),
  });
}

vi.mock("../core/client/src/plugin-registry.js", () => ({ useExpandedSurfaceDescriptors: () => new Map(),
  usePluginRegistry: () => ({
    plugins: [],
    operationKinds: [
      {
        pluginId: "test-plugin",
        type: "agent",
        title: "Test Agent",
        render: body,
        companions: [
          {
            id: GATED_COMPANION_ID,
            title: "Gated",
            available: (operation: { readonly payload: Record<string, unknown> , expandedSurfaces: [], persistentComponents: []}) =>
              (operation.payload.session as { readonly model?: string } | undefined)?.model !== "codex--gpt-5.6-sol",
            render: () => createElement("div", { "data-testid": GATED_COMPANION_ID }),
          },
          {
            id: ALWAYS_COMPANION_ID,
            title: "Always",
            render: () => createElement("div", { "data-testid": ALWAYS_COMPANION_ID }),
          },
        ],
      },
      {
        pluginId: "test-plugin",
        type: "barren",
        title: "Test Barren",
        render: body,
        companions: [
          {
            id: BARREN_COMPANION_ID,
            title: "Barren",
            available: () => false,
            render: () => createElement("div", { "data-testid": BARREN_COMPANION_ID }),
          },
        ],
      },
    ],
    failures: [],
    settingsSections: [],
    notificationKinds: [],
    railPanels: [],
  }),
}));

import { OperationsCanvas } from "../core/client/src/canvas/canvas.js";
import { loadForTheater, setCompanionOperationId, setState as setCanvasState } from "../core/client/src/canvas/canvas-store.js";
import type { ConsoleState, OperationNode } from "../core/client/src/types.js";

const OPERATIONS: readonly OperationNode[] = [
  operation(CODEX_OPERATION_ID, "agent", "codex--gpt-5.6-sol"),
  operation(CLAUDE_OPERATION_ID, "agent", "opus[1m]"),
  operation(BARREN_OPERATION_ID, "barren", "opus[1m]"),
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  loadForTheater(THEATER);
  setCanvasState({
    viewport: { x: 0, y: 0, zoom: 1 },
    operations: Object.fromEntries(OPERATIONS.map((node) => [node.id, geometry()])),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  loadForTheater(null);
  container?.remove();
  root = null;
  container = null;
});

describe("companion panel availability", () => {
  it("renders only available companions and still reports the unavailable id as hidden", () => {
    renderCanvas(CODEX_OPERATION_ID);

    expect(container?.querySelector(`[data-testid="${GATED_COMPANION_ID}"]`)).toBeNull();
    expect(container?.querySelector(`[data-testid="${ALWAYS_COMPANION_ID}"]`)).not.toBeNull();
    // 이 단언이 이 변경의 핵심 불변식이다. 플러그인은 "hidden 목록에 없음"을 곧 "보임"으로 읽으므로,
    // 사용 불가 패널이 visible에도 hidden에도 없으면 플러그인 쪽 가시성 판정이 뒤집힌다.
    expect(hiddenCompanionsOf(CODEX_OPERATION_ID)).toContain(GATED_COMPANION_ID);
  });

  it("keeps a companion that omits the predicate and one the predicate admits", () => {
    renderCanvas(CLAUDE_OPERATION_ID);

    expect(container?.querySelector(`[data-testid="${GATED_COMPANION_ID}"]`)).not.toBeNull();
    expect(container?.querySelector(`[data-testid="${ALWAYS_COMPANION_ID}"]`)).not.toBeNull();
    expect(hiddenCompanionsOf(CLAUDE_OPERATION_ID)).not.toContain(GATED_COMPANION_ID);
  });

  it("opens no companion layer when the operation admits no companion at all", () => {
    renderCanvas(BARREN_OPERATION_ID);

    expect(container?.querySelector(`[data-testid="${BARREN_COMPANION_ID}"]`)).toBeNull();
    expect(container
      ?.querySelector(`[data-testid="body-${BARREN_OPERATION_ID}"]`)
      ?.getAttribute("data-companions-open")).toBe("false");
  });
});

function hiddenCompanionsOf(operationId: string): readonly string[] {
  const raw = container
    ?.querySelector(`[data-testid="body-${operationId}"]`)
    ?.getAttribute("data-hidden-companions") ?? "";
  return raw.split(",");
}

function geometry() {
  return { x: 0, y: 0, width: 320, height: 200, zIndex: 1 };
}

function operation(id: string, type: string, model: string): OperationNode {
  return {
    id,
    theaterId: THEATER,
    type,
    pluginId: "test-plugin",
    title: id,
    payload: { session: { harness: "claude-code", model } },
    geometry: geometry(),
    ts: { createdAt: 0, updatedAt: 0 },
  };
}

function renderCanvas(activeOperationId: string): void {
  act(() => {
    root!.render(createElement(OperationsCanvas, {
      state: consoleState(activeOperationId),
      catalog: [],
      canLaunch: false,
      renderKindIcon: () => null,
      onLaunchKind: () => {},
      onLaunchAtGeometry: () => {},
      onClose: () => {},
      onFocus: () => {},
      onRename: () => {},
      onSetAccent: () => {},
    }));
    setCompanionOperationId(activeOperationId);
  });
}

function consoleState(activeOperationId: string): ConsoleState {
  return {
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
    theaters: [],
    operations: [...OPERATIONS],
    operationsHydrated: true,
    groups: [],
    activeTheaterId: THEATER,
    activeOperationId,
    activeOperationAcknowledged: true,
    operationRuntime: {},
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
}

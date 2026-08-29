// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/client/src/plugin-registry.js", () => ({ useExpandedSurfaceDescriptors: () => new Map(),
  usePluginRegistry: () => ({
    plugins: [],
    operationKinds: [{
      pluginId: "test-plugin",
      type: "shell",
      title: "Test",
      render: () => null,
    }],
    failures: [],
    settingsSections: [],
    notificationKinds: [],
    railPanels: [],
  }),
}));

import {
  clearInactiveTriageStageCompanion,
  OperationsCanvas,
} from "../core/client/src/canvas/canvas.js";
import { loadForTheater, setState as setCanvasState } from "../core/client/src/canvas/canvas-store.js";
import {
  armTriageSetAside,
  getTriageSetAsideArmedId,
  resetTriageTheater,
  setTriageActive,
} from "../core/client/src/canvas/triage-store.js";
import type { ConsoleState, OperationNode } from "../core/client/src/types.js";

const THEATER_A = "theater-a";
const OPERATION: OperationNode = {
  id: "operation-a",
  theaterId: THEATER_A,
  type: "shell",
  pluginId: "test-plugin",
  title: "Operation A",
  payload: {},
  geometry: { x: 0, y: 0, width: 320, height: 200, zIndex: 1 },
  ts: { createdAt: 0, updatedAt: 0 },
};
let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  loadForTheater(THEATER_A);
  setCanvasState({
    viewport: { x: 0, y: 0, zoom: 1 },
    operations: { [OPERATION.id]: OPERATION.geometry! },
  });
  setTriageActive(true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  resetTriageTheater(THEATER_A);
  loadForTheater(null);
  container?.remove();
  root = null;
  container = null;
});

describe("Triage stage companion synchronization", () => {
  it("disarms the previous Theater when the next view is not in Triage", () => {
    armTriageSetAside("operation-a");

    expect(clearInactiveTriageStageCompanion({
      theaterId: THEATER_A,
      operationId: "operation-a",
    })).toBeNull();
    expect(getTriageSetAsideArmedId()).toBeNull();
  });

  it("keeps an armed stage through a same-stage rerender", () => {
    renderCanvas();

    act(() => armTriageSetAside(OPERATION.id));

    expect(getTriageSetAsideArmedId()).toBe(OPERATION.id);
  });

  it("disarms the current Theater when the canvas unmounts", () => {
    renderCanvas();
    act(() => armTriageSetAside(OPERATION.id));
    expect(getTriageSetAsideArmedId()).toBe(OPERATION.id);

    act(() => root!.render(null));

    expect(getTriageSetAsideArmedId()).toBeNull();

    renderCanvas();
    act(() => armTriageSetAside(OPERATION.id));
    expect(getTriageSetAsideArmedId()).toBe(OPERATION.id);
  });
});

const STATE: ConsoleState = {
  connection: "connecting",
  operationRuntimeHydration: "ready",
  operationRuntimeError: null,
  connectionLostAt: null,
  controlHolder: null,
  controlCurtainDismissed: false,
  consoleName: "",
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
  operations: [OPERATION],
  operationsHydrated: true,
  groups: [],
  activeTheaterId: THEATER_A,
  activeOperationId: OPERATION.id,
  activeOperationAcknowledged: true,
  operationRuntime: { [OPERATION.id]: { lifecycle: "live", activity: "awaiting" } },
  addingTheater: false,
  theaterError: null,
  operationsViewActive: true,
  operationSearchOpen: false,
  operationSearchSeed: null,
  quickLaunchOpen: false,
  quickLaunchPinned: false,
  quickLaunchFocusToggle: 0,
  quickLaunchExpandRequest: 0,
  quickLaunchMentionSeed: null,
  quickLaunchDockSuppressed: false,
  quickLaunchDraft: null,
  quickLaunchDraftAttachments: null,
  quickLaunchError: null,
  quickLaunchErrorShortenBy: null,
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

function renderCanvas() {
  act(() => root!.render(createElement(OperationsCanvas, {
    state: STATE,
    catalog: [],
    canLaunch: false,
    renderKindIcon: () => null,
    onLaunchKind: () => {},
    onLaunchAtGeometry: () => {},
    onClose: () => {},
    onFocus: () => {},
    onOpenAll: () => {},
    onRename: () => {},
  })));
}

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSnapshot, loadForTheater, setOperationGeometry } from "../core/client/src/canvas/canvas-store.js";
import { minimizeOperationCompletely } from "../core/client/src/operation-actions.js";
import { getIdleArrivalIds, markIdleArrival, resetIdleArrivalForTests, setIdleArrivalAcknowledgementSuspended } from "../core/client/src/operation-marks.js";
import { getState, setState } from "../core/client/src/store.js";

beforeEach(() => {
  window.localStorage.clear();
  loadForTheater("theater-a");
  setOperationGeometry("operation", { x: 0, y: 0, width: 640, height: 400, zIndex: 1 });
  resetIdleArrivalForTests();
  setState({
    operations: [],
    activeTheaterId: "theater-a",
    activeOperationId: null,
    activeOperationAcknowledged: true,
  });
});

describe("Operation minimize action", () => {
  it("acknowledges an unseen idle arrival even while War Room suspends focus acknowledgement", () => {
    markIdleArrival("operation");
    setIdleArrivalAcknowledgementSuspended(true);

    minimizeOperationCompletely("operation");

    expect(getSnapshot().minimized).toContain("operation");
    expect(getIdleArrivalIds().has("operation")).toBe(false);
  });

  it("releases the active Operation before minimizing it", () => {
    setState({ activeOperationId: "operation", activeOperationAcknowledged: false });

    minimizeOperationCompletely("operation");

    expect(getState().activeOperationId).toBeNull();
    expect(getState().activeOperationAcknowledged).toBe(true);
  });
});

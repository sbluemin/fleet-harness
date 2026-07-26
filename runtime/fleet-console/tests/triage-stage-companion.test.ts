// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/client/src/plugin-registry.js", () => ({
  usePluginRegistry: () => ({
    plugins: [],
    operationKinds: [],
    settingsSections: [],
    notificationKinds: [],
    railPanels: [],
  }),
}));

import { clearInactiveTriageStageCompanion } from "../core/client/src/canvas/canvas.js";
import {
  armTriageSetAside,
  getTriageSetAsideArmedId,
  resetTriageTheater,
} from "../core/client/src/canvas/triage-store.js";

const THEATER_A = "theater-a";

afterEach(() => {
  resetTriageTheater(THEATER_A);
});

describe("Triage stage companion synchronization", () => {
  it("disarms the previous Theater when the next view is not in Triage", () => {
    armTriageSetAside(THEATER_A, "operation-a");

    expect(clearInactiveTriageStageCompanion({
      theaterId: THEATER_A,
      operationId: "operation-a",
    })).toBeNull();
    expect(getTriageSetAsideArmedId(THEATER_A)).toBeNull();
  });
});

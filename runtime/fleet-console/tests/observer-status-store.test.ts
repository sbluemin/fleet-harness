import { describe, expect, it } from "vitest";

import { applyObserverStatus, getState } from "../core/client/src/store.js";
import type { ObserverStatus } from "../core/client/src/types.js";

function status(channel: ObserverStatus["channel"]): ObserverStatus {
  return {
    workspaces: 0,
    version: "1.0.0",
    channel,
    updateAvailable: false,
    port: 0,
    portMode: "dynamic",
    requestedPort: null,
    effectivePort: 0,
    portHonored: true,
    wikiServerStatus: "unknown",
  };
}

describe("observer status store", () => {
  it("preserves local, stable, and unknown channels", () => {
    expect(getState().channel).toBe("unknown");
    for (const channel of ["local", "stable", "unknown"] as const) {
      applyObserverStatus(status(channel));
      expect(getState().channel).toBe(channel);
    }
  });
});

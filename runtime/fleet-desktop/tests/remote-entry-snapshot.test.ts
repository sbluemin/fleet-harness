import { describe, expect, it } from "vitest";

import { snapshotForAccessPhase, snapshotForAccessReady } from "../src/remote-entry-snapshot.js";

describe("remote entry snapshots", () => {
  it("renders the current access phase as active after immutable completed steps", () => {
    const snapshot = snapshotForAccessPhase("build-box", "opening_session");
    expect(snapshot.steps).toEqual([
      expect.objectContaining({ name: "Reading access link", state: "complete" }),
      expect.objectContaining({ name: "Pinning build-box", sub: "certificate fingerprint", state: "complete" }),
      expect.objectContaining({ name: "Opening session", state: "active" }),
    ]);
  });

  it("marks the active phase failed and finishes with a Console-ready handoff", () => {
    expect(snapshotForAccessPhase("build-box", "pinning_identity", true).steps.at(-1)).toEqual(expect.objectContaining({ state: "failed", result: "failed" }));
    expect(snapshotForAccessReady("build-box")).toEqual(expect.objectContaining({ handoff: "Console ready", steps: expect.arrayContaining([expect.objectContaining({ name: "Verifying console", state: "complete" })]) }));
  });
});

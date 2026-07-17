import { describe, expect, it } from "vitest";

import { snapshotForRemotePhase, snapshotForRemoteReady } from "../src/remote-entry-snapshot.js";

const target = { value: "alice@build-box", user: "alice", host: "build-box" };

describe("remote entry snapshots", () => {
  it("renders the current managed SSH phase as active after immutable completed steps", () => {
    const snapshot = snapshotForRemotePhase(target, "opening_tunnel");
    expect(snapshot.steps).toEqual([
      expect.objectContaining({ name: "Contacting build-box", sub: "SSH", state: "complete" }),
      expect.objectContaining({ name: "Installing Node runtime", state: "complete" }),
      expect.objectContaining({ name: "Installing Fleet Console", state: "complete" }),
      expect.objectContaining({ name: "Starting console", state: "complete" }),
      expect.objectContaining({ name: "Securing tunnel", state: "active" }),
    ]);
  });

  it("marks the active phase failed and finishes with a Console-ready handoff", () => {
    expect(snapshotForRemotePhase(target, "provisioning_console", true).steps.at(-1)).toEqual(expect.objectContaining({ state: "failed", result: "failed" }));
    expect(snapshotForRemoteReady(target)).toEqual(expect.objectContaining({ handoff: "Console ready", steps: expect.arrayContaining([expect.objectContaining({ name: "Verifying connection", state: "complete" })]) }));
  });
});

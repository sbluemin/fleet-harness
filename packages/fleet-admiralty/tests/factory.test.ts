import { describe, expect, it } from "vitest";

import { admiralty, createFleetAdmiralty, fleetAdmiralty } from "../src/index.js";

describe("fleet-admiralty factory", () => {
  it("exposes instance-owned multi-fleet runtime access", () => {
    const instance = createFleetAdmiralty();

    expect(instance.kind).toBe("fleet-admiralty");
    expect(instance.runtimeAccess.state()).toBeNull();
    expect(fleetAdmiralty.create().kind).toBe("fleet-admiralty");
    expect(admiralty.ipc).toBeDefined();
    expect(admiralty.runtimeAccess).toBeDefined();
  });
});

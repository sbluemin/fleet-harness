import { describe, expect, it } from "vitest";

import { admiral, createFleetAdmiral, fleetAdmiral } from "../src/index.js";

describe("fleet-admiral factory", () => {
  it("exposes the explicit construction boundary and single-fleet facade", () => {
    expect(createFleetAdmiral()).toEqual({ kind: "fleet-admiral" });
    expect(fleetAdmiral.create()).toEqual({ kind: "fleet-admiral" });
    expect(admiral.agent).toBeDefined();
    expect(admiral.protocols).toBeDefined();
    expect(admiral.mcp).toBeDefined();
  });
});

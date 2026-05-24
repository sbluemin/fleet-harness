import { describe, expect, it } from "vitest";

import { createGrandFleetRuntimeAccess } from "../../src/grand-fleet/runtime-access.js";
import type { AdmiraltyRuntimeState, FleetRuntimeState } from "../../src/grand-fleet/types.js";

describe("grand fleet runtime access", () => {
  it("initializes state once and stores admiralty and fleet runtimes independently", () => {
    const access = createGrandFleetRuntimeAccess();
    const admiraltyRuntime = { role: "admiralty" } as unknown as AdmiraltyRuntimeState;
    const fleetRuntime = { role: "fleet" } as unknown as FleetRuntimeState;

    expect(access.state()).toBeNull();

    access.initState("admiralty", {
      activeMissionId: "mission-1",
      activeMissionObjective: "Absorb packages",
      designation: "north",
      fleetId: "fleet-1",
      socketPath: "/tmp/fleet.sock",
      totalCost: 12,
    });
    access.initState("fleet", { fleetId: "ignored" });
    access.assignAdmiralty(admiraltyRuntime);
    access.assignFleet(fleetRuntime);

    expect(access.state()).toMatchObject({
      activeMissionId: "mission-1",
      activeMissionObjective: "Absorb packages",
      designation: "north",
      fleetId: "fleet-1",
      role: "admiralty",
      socketPath: "/tmp/fleet.sock",
      totalCost: 12,
    });
    expect(access.state()?.connectedFleets).toBeInstanceOf(Map);
    expect(access.admiralty()).toBe(admiraltyRuntime);
    expect(access.fleet()).toBe(fleetRuntime);

    access.clearAdmiralty();

    expect(access.admiralty()).toBeNull();
    expect(access.fleet()).toBe(fleetRuntime);
  });
});

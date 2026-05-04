import { afterEach, describe, expect, it } from "vitest";

import {
  buildFleetAcpSystemPrompt,
} from "@sbluemin/fleet-core/admiralty";
import {
  clearMissionBuffer,
  clearFleetSessionBindings,
  connectToAdmiralty,
  getFleetRuntime,
  setFleetSessionBindings,
  shutdownFleetRuntime,
} from "../../src/grand-fleet/fleet/runtime.js";
import {
  GRAND_FLEET_STATE_KEY,
  GRAND_FLEET_FLEET_RUNTIME_KEY,
  type FleetRuntimeState,
} from "@sbluemin/fleet-core/admiralty";

afterEach(() => {
  delete (globalThis as any)[GRAND_FLEET_FLEET_RUNTIME_KEY];
  delete (globalThis as any)[GRAND_FLEET_STATE_KEY];
});

describe("Fleet runtime bucket", () => {
  it("module reload 이후에도 같은 globalThis-backed runtime을 재사용한다", () => {
    const runtime = getFleetRuntime();
    runtime.lastHeartbeatAt = 42;
    runtime.lastStatusSignature = "sig";
    runtime.missionTexts.push("first report");

    const reloadedRuntime = getFleetRuntime();

    expect(reloadedRuntime).toBe(runtime);
    expect(reloadedRuntime.lastHeartbeatAt).toBe(42);
    expect(reloadedRuntime.lastStatusSignature).toBe("sig");
    expect(reloadedRuntime.missionTexts).toEqual(["first report"]);
  });

  it("mission report buffer를 순서대로 누적하고 clear 가능하게 유지한다", () => {
    const runtime: FleetRuntimeState = getFleetRuntime();

    runtime.missionTexts.push("alpha");
    runtime.missionTexts.push("beta");

    expect(runtime.missionTexts.join("\n\n---\n\n")).toBe("alpha\n\n---\n\nbeta");

    runtime.missionTexts = [];

    expect(runtime.missionTexts).toEqual([]);
  });

  it("abort/disconnect 경로에서 사용할 수 있도록 mission buffer clear API를 제공한다", () => {
    const runtime = getFleetRuntime();
    runtime.missionTexts.push("stale report");

    clearMissionBuffer();

    expect(runtime.missionTexts).toEqual([]);
  });

  it("shutdown-with-active-mission 경로에서 mission buffer와 prompt를 정리한다", () => {
    const runtime = getFleetRuntime();
    runtime.missionTexts.push("active mission summary");
    let promptReset = false;

    shutdownFleetRuntime("fleet-a", {
      resetPrompt: () => {
        promptReset = true;
      },
    });

    expect(runtime.missionTexts).toEqual([]);
    expect(promptReset).toBe(true);
  });

  it("session-bound dispatcher는 generation guard로 stale callback을 무시한다", () => {
    const sent: string[] = [];
    const stalePi = {
      sendUserMessage: (text: string) => {
        sent.push(`stale:${text}`);
      },
    };
    const freshPi = {
      sendUserMessage: (text: string) => {
        sent.push(`fresh:${text}`);
      },
    };
    const ctx = { ui: { notify: () => {} } };

    setFleetSessionBindings(stalePi as any, ctx as any);
    const staleDispatcher = getFleetRuntime().dispatcher;
    setFleetSessionBindings(freshPi as any, ctx as any);

    staleDispatcher?.sendMission("old");
    getFleetRuntime().dispatcher?.sendMission("new");

    expect(sent).toEqual(["fresh:new"]);
  });

  it("session_shutdown 후 presenter/dispatcher를 비운다", () => {
    const ctx = { ui: { notify: () => {} } };
    const pi = { sendUserMessage: () => {} };

    setFleetSessionBindings(pi as any, ctx as any);
    clearFleetSessionBindings();

    expect(getFleetRuntime().presenter).toBeUndefined();
    expect(getFleetRuntime().dispatcher).toBeUndefined();
  });

  it("Fleet ACP base prompt가 Fleet Action 핵심 섹션을 포함한다", () => {
    const prompt = buildFleetAcpSystemPrompt("fleet-a", "Fleet A", "/tmp/fleet-a", {
      includeGrandFleetContext: false,
    });

    expect(prompt).toContain("<fleet_acp_role>");
    expect(prompt).toContain("<fleet_action_guidelines>");
    expect(prompt).toContain("<carrier_roster_routing>");
    expect(prompt).toContain("<protocol_standing_orders>");
    expect(prompt).toContain("<runtime_context_tags>");
    expect(prompt).toContain("<request_directive_guidance>");
    expect(prompt).toContain("<tool_delegation_policy>");
    expect(prompt).not.toContain("<fleet_identity>");
  });

  it("connected prompt는 base 뒤에 Grand Fleet context를 append한다", () => {
    const prompt = buildFleetAcpSystemPrompt("fleet-a", "Fleet A", "/tmp/fleet-a", {
      includeGrandFleetContext: true,
    });

    expect(prompt).toContain("<fleet_acp_role>");
    expect(prompt).toContain("<fleet_identity>");
    expect(prompt.indexOf("<fleet_acp_role>")).toBeLessThan(prompt.indexOf("<fleet_identity>"));
  });

  it("manual connect lifecycle can sync base-only then connected prompt", () => {
    const calls: string[] = [];
    const ctx = { ui: { notify: () => {} } };
    const pi = { sendUserMessage: () => {} };

    setFleetSessionBindings(pi as any, ctx as any, {
      setBaseOnly: () => calls.push("base"),
      setConnected: (fleetId, designation, operationalZone) => {
        calls.push(`${fleetId}:${designation}:${operationalZone}`);
      },
    });

    getFleetRuntime().promptSync?.setBaseOnly();
    getFleetRuntime().promptSync?.setConnected("fleet-a", "Fleet A", "/tmp/fleet-a");

    expect(calls).toEqual(["base", "fleet-a:Fleet A:/tmp/fleet-a"]);
  });

  it("stale prompt sync callbacks are ignored after session rebinding", () => {
    const calls: string[] = [];
    const ctx = { ui: { notify: () => {} } };
    const pi = { sendUserMessage: () => {} };

    setFleetSessionBindings(pi as any, ctx as any, {
      setBaseOnly: () => calls.push("stale-base"),
      setConnected: () => calls.push("stale-connected"),
    });
    const stalePromptSync = getFleetRuntime().promptSync;

    setFleetSessionBindings(pi as any, ctx as any, {
      setBaseOnly: () => calls.push("fresh-base"),
      setConnected: () => calls.push("fresh-connected"),
    });

    stalePromptSync?.setConnected("old", "Old", "/old");
    getFleetRuntime().promptSync?.setConnected("new", "New", "/new");

    expect(calls).toEqual(["fresh-connected"]);
  });

  it("existing connected client on reload resyncs connected prompt after rebind", () => {
    const calls: string[] = [];
    (globalThis as any)[GRAND_FLEET_STATE_KEY] = {
      role: "fleet",
      fleetId: "fleet-a",
      designation: "Fleet A",
      socketPath: "/tmp/admiralty.sock",
      connectedFleets: new Map(),
      totalCost: 0,
      activeMissionId: null,
      activeMissionObjective: null,
    };
    const runtime = getFleetRuntime();
    runtime.client = {
      close: () => {},
      getState: () => "connected",
      sendNotification: () => {},
    };
    const ctx = { ui: { notify: () => {} } };
    const pi = { sendUserMessage: () => {} };

    setFleetSessionBindings(pi as any, ctx as any, {
      setBaseOnly: () => calls.push("base"),
      setConnected: (fleetId, designation, operationalZone) => {
        calls.push(`${fleetId}:${designation}:${operationalZone}`);
      },
    });

    connectToAdmiralty("/tmp/admiralty.sock", "fleet-a");

    expect(calls).toEqual([`fleet-a:Fleet A:${process.cwd()}`]);
  });

  it("session_start ordering keeps connected prompt when existing client is connected", () => {
    const calls: string[] = [];
    (globalThis as any)[GRAND_FLEET_STATE_KEY] = {
      role: "fleet",
      fleetId: "fleet-a",
      designation: "Fleet A",
      socketPath: "/tmp/admiralty.sock",
      connectedFleets: new Map(),
      totalCost: 0,
      activeMissionId: null,
      activeMissionObjective: null,
    };
    const runtime = getFleetRuntime();
    runtime.client = {
      close: () => {},
      getState: () => "connected",
      sendNotification: () => {},
    };
    const ctx = { ui: { notify: () => {} } };
    const pi = { sendUserMessage: () => {} };

    setFleetSessionBindings(pi as any, ctx as any, {
      setBaseOnly: () => calls.push("base"),
      setConnected: (fleetId, designation, operationalZone) => {
        calls.push(`${fleetId}:${designation}:${operationalZone}`);
      },
    });
    connectToAdmiralty("/tmp/admiralty.sock", "fleet-a");
    if (getFleetRuntime().client?.getState() === "connected") {
      getFleetRuntime().promptSync?.setConnected("fleet-a", "Fleet A", process.cwd());
    } else {
      getFleetRuntime().promptSync?.setBaseOnly();
    }

    expect(calls).toEqual([
      `fleet-a:Fleet A:${process.cwd()}`,
      `fleet-a:Fleet A:${process.cwd()}`,
    ]);
    expect(calls).not.toContain("base");
  });
});

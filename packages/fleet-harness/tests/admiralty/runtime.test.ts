import { afterEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../../src/grand-fleet/fleet/client.js", () => {
  class MockFleetClient {
    static instances: MockFleetClient[] = [];
    state: "disconnected" | "connecting" | "connected" = "disconnected";
    onConnected?: () => void;
    requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();

    constructor(readonly socketPath: string) {
      MockFleetClient.instances.push(this);
    }

    onConnect(cb: () => void): void {
      this.onConnected = cb;
    }

    onDisconnect(): void {}

    onRequest(method: string, handler: (params: Record<string, unknown>) => Promise<unknown>): void {
      this.handlers.set(method, handler);
    }

    connect(): void {
      this.state = "connected";
      this.onConnected?.();
    }

    async sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
      this.requests.push({ method, params });
      return { ok: true };
    }

    sendNotification(method: string, params: Record<string, unknown>): void {
      this.notifications.push({ method, params });
    }

    close(): void {
      this.state = "disconnected";
    }

    getState(): "disconnected" | "connecting" | "connected" {
      return this.state;
    }
  }

  return { FleetClient: MockFleetClient };
});

afterEach(() => {
  delete (globalThis as any)[GRAND_FLEET_FLEET_RUNTIME_KEY];
  delete (globalThis as any)[GRAND_FLEET_STATE_KEY];
  vi.clearAllTimers();
});

function makeCtx(sessionId = "pi_session_1"): any {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
    ui: { notify: () => {} },
  };
}

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

  it("bound dispatcher는 generation guard로 stale callback을 무시한다", () => {
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
    const ctx = makeCtx();

    setFleetSessionBindings(stalePi as any, ctx as any);
    const staleDispatcher = getFleetRuntime().dispatcher;
    setFleetSessionBindings(freshPi as any, ctx as any);

    staleDispatcher?.sendMission("old");
    getFleetRuntime().dispatcher?.sendMission("new");

    expect(sent).toEqual(["fresh:new"]);
  });

  it("session_shutdown 후 presenter/dispatcher를 비운다", () => {
    const ctx = makeCtx();
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
    const ctx = makeCtx();
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
    const ctx = makeCtx();
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
    const ctx = makeCtx();
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
    const ctx = makeCtx();
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

  it("fleet.register uses the bound ACP/Pi session ID", async () => {
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
    const ctx = makeCtx("real-pi-session");
    const pi = { sendUserMessage: () => {} };

    setFleetSessionBindings(pi as any, ctx as any);
    connectToAdmiralty("/tmp/admiralty.sock", "fleet-a");
    await Promise.resolve();

    const { FleetClient } = await import("../../src/grand-fleet/fleet/client.js");
    const client = (FleetClient as any).instances.at(-1);
    expect(client.requests[0]).toMatchObject({
      method: "fleet.register",
      params: { sessionId: "real-pi-session" },
    });
    expect(client.requests[0]?.params.sessionId).not.toMatch(new RegExp("^" + "session" + "-\\d+$"));

    shutdownFleetRuntime("fleet-a");
  });

  it("unbound connect defers fleet.register until a real session ID is bound", async () => {
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
    const pi = { sendUserMessage: () => {} };

    connectToAdmiralty("/tmp/admiralty.sock", "fleet-a");
    await Promise.resolve();

    const { FleetClient } = await import("../../src/grand-fleet/fleet/client.js");
    const client = (FleetClient as any).instances.at(-1);
    expect(client.requests).toEqual([]);

    setFleetSessionBindings(pi as any, makeCtx("late-pi-session") as any);
    await Promise.resolve();

    expect(client.requests[0]).toMatchObject({
      method: "fleet.register",
      params: { sessionId: "late-pi-session" },
    });

    shutdownFleetRuntime("fleet-a");
  });

  it("lazy fleet.register suppresses duplicate sends for the same pending session ID", async () => {
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
    const pi = { sendUserMessage: () => {} };
    let releaseRegister!: () => void;

    connectToAdmiralty("/tmp/admiralty.sock", "fleet-a");
    await Promise.resolve();

    const { FleetClient } = await import("../../src/grand-fleet/fleet/client.js");
    const client = (FleetClient as any).instances.at(-1);
    client.sendRequest = async (method: string, params: Record<string, unknown>) => {
      client.requests.push({ method, params });
      await new Promise<void>((release) => {
        releaseRegister = release;
      });
      return { ok: true };
    };

    setFleetSessionBindings(pi as any, makeCtx("same-pending-session") as any);
    setFleetSessionBindings(pi as any, makeCtx("same-pending-session") as any);
    await Promise.resolve();

    expect(client.requests).toHaveLength(1);
    releaseRegister();
    await Promise.resolve();

    shutdownFleetRuntime("fleet-a");
  });

  it("lazy fleet.register ignores stale completion after session rebinding", async () => {
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
    const pi = { sendUserMessage: () => {} };
    const releases: Array<() => void> = [];

    connectToAdmiralty("/tmp/admiralty.sock", "fleet-a");
    await Promise.resolve();

    const { FleetClient } = await import("../../src/grand-fleet/fleet/client.js");
    const client = (FleetClient as any).instances.at(-1);
    client.sendRequest = async (method: string, params: Record<string, unknown>) => {
      client.requests.push({ method, params });
      await new Promise<void>((release) => {
        releases.push(release);
      });
      return { ok: true };
    };

    setFleetSessionBindings(pi as any, makeCtx("old-session") as any);
    await Promise.resolve();
    setFleetSessionBindings(pi as any, makeCtx("new-session") as any);
    await Promise.resolve();

    expect(client.requests.map((request: { params: Record<string, unknown> }) => request.params.sessionId)).toEqual([
      "old-session",
      "new-session",
    ]);

    releases[1]?.();
    await Promise.resolve();
    releases[0]?.();
    await Promise.resolve();

    expect((getFleetRuntime() as any).registeredSessionId).toBe("new-session");

    shutdownFleetRuntime("fleet-a");
  });

  it("re-registers fleet when bound session ID changes after successful initial register", async () => {
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
    const pi = { sendUserMessage: () => {} };

    // 최초 register: first-session 으로 성공 완료
    setFleetSessionBindings(pi as any, makeCtx("first-session") as any);
    connectToAdmiralty("/tmp/admiralty.sock", "fleet-a");
    await Promise.resolve();
    await Promise.resolve();

    const { FleetClient } = await import("../../src/grand-fleet/fleet/client.js");
    const client = (FleetClient as any).instances.at(-1);
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.params.sessionId).toBe("first-session");
    expect((getFleetRuntime() as any).registeredSessionId).toBe("first-session");
    expect((getFleetRuntime() as any).pendingRegisterFleetId).toBeUndefined();

    // 새 PI 세션으로 rebind되면 pending 플래그가 없어도 자동 재등록되어야 한다.
    setFleetSessionBindings(pi as any, makeCtx("second-session") as any);
    await Promise.resolve();
    await Promise.resolve();

    expect(client.requests).toHaveLength(2);
    expect(client.requests[1]?.params.sessionId).toBe("second-session");
    expect((getFleetRuntime() as any).registeredSessionId).toBe("second-session");

    shutdownFleetRuntime("fleet-a");
  });

  it("session handlers reuse the current bound session ID instead of synthetic IDs", async () => {
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
    const ctx = makeCtx("handler-pi-session");
    const pi = { sendUserMessage: () => {} };

    setFleetSessionBindings(pi as any, ctx as any);
    connectToAdmiralty("/tmp/admiralty.sock", "fleet-a");
    await Promise.resolve();

    const { FleetClient } = await import("../../src/grand-fleet/fleet/client.js");
    const client = (FleetClient as any).instances.at(-1);
    const sessionNew = await client.handlers.get("session.new")?.({});
    const sessionSuspend = await client.handlers.get("session.suspend")?.({});

    expect(sessionNew).toEqual({ sessionId: "handler-pi-session" });
    expect(sessionSuspend).toEqual({ suspended: true, sessionId: "handler-pi-session" });

    shutdownFleetRuntime("fleet-a");
  });
});

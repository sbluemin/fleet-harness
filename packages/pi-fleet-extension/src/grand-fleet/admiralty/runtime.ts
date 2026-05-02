import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  clearAdmiraltyRuntime,
  getAdmiraltyRuntime,
  setAdmiraltyRuntime,
  type AdmiraltyPresenter,
  type AdmiraltyRuntimeState,
  type MissionReportParams,
} from "@sbluemin/fleet-core/admiralty";
import { registerAdmiraltyHandlers } from "./methods.js";
import { AdmiraltyServer } from "./server.js";
import { renderFleetEvent, renderReport } from "./report-renderer.js";
import { FleetRegistry } from "./fleet-registry.js";

const GRAND_FLEET_HOME = path.join(os.homedir(), ".pi", "grand-fleet");
const DEFAULT_SOCKET_FILE = path.join(GRAND_FLEET_HOME, "admiralty.sock");

export function ensureAdmiraltyRuntime(): AdmiraltyRuntimeState {
  const existing = readAdmiraltyRuntime();
  if (existing) {
    return existing;
  }

  const socketPath = process.env.PI_GRAND_FLEET_SOCK ?? DEFAULT_SOCKET_FILE;
  const registry = new FleetRegistry();
  const server = new AdmiraltyServer(socketPath);
  const runtime: AdmiraltyRuntimeState = {
    registry,
    server,
    socketPath,
  };

  registerAdmiraltyHandlers(server, {
    onFleetRegister: async (params, socket) => {
      const result = await registry.register(params, socket);
      runtime.presenter?.onFleetConnected(String(params.fleetId ?? ""));
      return result;
    },
    onFleetDeregister: (params) => {
      const fleetId = String(params.fleetId ?? "");
      registry.deregister(fleetId);
      runtime.presenter?.onFleetDisconnected(fleetId);
    },
    onFleetHeartbeat: (params) => {
      registry.heartbeat(params);
    },
    onFleetStatus: (params) => {
      registry.updateStatus(params);
    },
    onMissionReport: (params) => {
      registry.handleReport(params);
      runtime.presenter?.onMissionReport(params as unknown as MissionReportParams);
    },
  });

  server.onDisconnect((socket, reason) => {
    const fleetId = registry.deregisterBySocket(socket, reason);
    if (fleetId) {
      runtime.presenter?.onFleetDisconnected(fleetId);
    }
  });

  setAdmiraltyRuntime(runtime);
  return runtime;
}

export function readAdmiraltyRuntime(): AdmiraltyRuntimeState | null {
  return getAdmiraltyRuntime();
}

export function getAdmiraltyRegistry(): FleetRegistry {
  const runtime = readAdmiraltyRuntime();
  if (!runtime) {
    throw new Error("Admiralty registry가 초기화되지 않았습니다.");
  }
  return runtime.registry as FleetRegistry;
}

export function getAdmiraltyServer(): AdmiraltyServer {
  const runtime = readAdmiraltyRuntime();
  if (!runtime) {
    throw new Error("Admiralty server가 초기화되지 않았습니다.");
  }
  return runtime.server as AdmiraltyServer;
}

export function setAdmiraltyPresenter(pi: ExtensionAPI): void {
  const runtime = ensureAdmiraltyRuntime();
  runtime.presenter = createPresenter(pi, runtime);
}

export function clearAdmiraltyRuntimePresenter(): void {
  const runtime = readAdmiraltyRuntime();
  if (runtime) {
    runtime.presenter = undefined;
  }
}

export function setRosterListenerDisposer(disposer: (() => void) | null): void {
  const runtime = ensureAdmiraltyRuntime();
  runtime.rosterListenerDisposer?.();
  runtime.rosterListenerDisposer = disposer ?? undefined;
}

export function disposeRosterListener(): void {
  const runtime = readAdmiraltyRuntime();
  runtime?.rosterListenerDisposer?.();
  if (runtime) {
    runtime.rosterListenerDisposer = undefined;
  }
}

export function disposeAdmiraltyRuntime(): void {
  clearAdmiraltyRuntime();
}

function createPresenter(
  pi: ExtensionAPI,
  runtime: AdmiraltyRuntimeState,
): AdmiraltyPresenter {
  return {
    onFleetConnected(fleetId: string): void {
      renderFleetEvent(pi, fleetId, "connected", {
        designation: lookupDesignation(runtime, fleetId),
      });
    },
    onFleetDisconnected(fleetId: string): void {
      renderFleetEvent(pi, fleetId, "disconnected", {
        designation: lookupDesignation(runtime, fleetId),
      });
    },
    onMissionReport(params: MissionReportParams): void {
      renderReport(pi, params, {
        designation: lookupDesignation(runtime, params.fleetId),
      });
    },
  };
}

function lookupDesignation(
  runtime: AdmiraltyRuntimeState,
  fleetId: string,
): string | undefined {
  return runtime.registry.getConnectedFleet?.(fleetId)?.designation;
}

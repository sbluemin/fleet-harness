import type { Socket } from "node:net";

import type { AdmiraltyServer } from "./server.js";
interface FleetClientLike {
  onRequest(method: string, handler: (params: Record<string, unknown>) => Promise<unknown>): void;
}

export interface AdmiraltyMethodHandlers {
  onFleetRegister: (
    params: Record<string, unknown>,
    fleetSocket: Socket,
  ) => Promise<unknown>;
  onFleetDeregister: (
    params: Record<string, unknown>,
    fleetSocket: Socket,
  ) => void;
  onFleetHeartbeat: (
    params: Record<string, unknown>,
    fleetSocket: Socket,
  ) => void;
  onFleetStatus: (
    params: Record<string, unknown>,
    fleetSocket: Socket,
  ) => void;
  onMissionReport: (
    params: Record<string, unknown>,
    fleetSocket: Socket,
  ) => void;
}

export interface FleetMethodHandlers {
  onMissionAssign: (params: Record<string, unknown>) => Promise<unknown>;
  onMissionAbort: (params: Record<string, unknown>) => Promise<unknown>;
  onSessionNew: (params: Record<string, unknown>) => Promise<unknown>;
  onSessionResume: (params: Record<string, unknown>) => Promise<unknown>;
  onSessionSuspend: (params: Record<string, unknown>) => Promise<unknown>;
  onFleetPing: (params: Record<string, unknown>) => Promise<unknown>;
}

export function registerAdmiraltyHandlers(
  server: AdmiraltyServer,
  handlers: AdmiraltyMethodHandlers,
): void {
  server.onRequest("fleet.register", handlers.onFleetRegister);
  server.onNotification("fleet.deregister", handlers.onFleetDeregister);
  server.onNotification("fleet.heartbeat", handlers.onFleetHeartbeat);
  server.onNotification("fleet.status", handlers.onFleetStatus);
  server.onNotification("mission.report", handlers.onMissionReport);
}

export function registerFleetHandlers(
  client: FleetClientLike,
  handlers: FleetMethodHandlers,
): void {
  client.onRequest("mission.assign", handlers.onMissionAssign);
  client.onRequest("mission.abort", handlers.onMissionAbort);
  client.onRequest("session.new", handlers.onSessionNew);
  client.onRequest("session.resume", handlers.onSessionResume);
  client.onRequest("session.suspend", handlers.onSessionSuspend);
  client.onRequest("fleet.ping", handlers.onFleetPing);
}

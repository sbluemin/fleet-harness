import type { ExtensionAPI, ExtensionContext } from "@sbluemin/fleet-coding-agent";

import { infra } from "@sbluemin/fleet-core";
import { getState } from "../state.js";
import { FleetClient } from "./client.js";
import { registerFleetHandlers } from "../admiralty/methods.js";
import {
  getFleetRuntime as getCoreFleetRuntime,
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  setFleetRuntime as setCoreFleetRuntime,
  type FleetId,
  type FleetRuntimeState,
} from "@sbluemin/fleet-core/admiralty";
import { buildFleetPingPayload } from "./status-source.js";

interface FleetRegisterPayload {
  fleetId: FleetId;
  designation: string;
  operationalZone: string;
  sessionId: string;
  protocolVersion: string;
  carriers: ReturnType<typeof buildFleetPingPayload>["carriers"];
}

interface FleetRegisterInFlight {
  readonly fleetId: FleetId;
  readonly sessionId: string;
  readonly generation: number;
}

type FleetRuntimeSessionState = FleetRuntimeState & {
  currentSessionId?: string;
  inFlightRegister?: FleetRegisterInFlight;
  pendingRegisterFleetId?: FleetId;
  registeredFleetId?: FleetId;
  registeredSessionId?: string;
};

const LOG_SOURCE = "grand-fleet";
const STATUS_SYNC_INTERVAL_MS = 1_000;

export function getFleetRuntime(): FleetRuntimeState {
  const existing = getCoreFleetRuntime();
  if (existing) {
    return existing;
  }

  const runtime: FleetRuntimeState = {
    client: null,
    heartbeatTimer: null,
    lastHeartbeatAt: null,
    lastStatusSignature: null,
    missionTexts: [],
    sessionGeneration: 0,
    statusSyncTimer: null,
  };
  setCoreFleetRuntime(runtime);
  return runtime;
}

export function getFleetClient(): FleetClient | null {
  return getFleetRuntime().client as FleetClient | null;
}

export function setFleetSessionBindings(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  promptSync?: {
    setBaseOnly(): void;
    setConnected(fleetId: FleetId, designation: string, operationalZone: string): void;
  },
): void {
  const runtime = getFleetRuntime() as FleetRuntimeSessionState;
  const generation = runtime.sessionGeneration + 1;
  runtime.sessionGeneration = generation;
  runtime.currentSessionId = ctx.sessionManager.getSessionId();
  runtime.presenter = {
    generation,
    notify(message, level) {
      if (getFleetRuntime().presenter?.generation !== generation) return;
      ctx.ui.notify(message, level);
    },
  };
  runtime.dispatcher = {
    generation,
    sendMission(objective) {
      if (getFleetRuntime().dispatcher?.generation !== generation) return;
      pi.sendUserMessage(objective, { deliverAs: "followUp" });
    },
  };
  runtime.promptSync = promptSync
    ? {
      generation,
      setBaseOnly() {
        if (getFleetRuntime().promptSync?.generation !== generation) return;
        promptSync.setBaseOnly();
      },
      setConnected(fleetId, designation, operationalZone) {
        if (getFleetRuntime().promptSync?.generation !== generation) return;
        promptSync.setConnected(fleetId, designation, operationalZone);
      },
    }
    : undefined;
  // connected 상태에서 PI 세션이 rebind되면 pending 또는 already-registered fleetId를 사용해
  // 자동 재등록한다. registerCurrentFleet은 sessionId가 동일하면 idempotent하게 early-return한다.
  const rebindFleetId = runtime.pendingRegisterFleetId ?? runtime.registeredFleetId;
  if (runtime.client?.getState() === "connected" && rebindFleetId) {
    void registerCurrentFleet(rebindFleetId);
  }
}

export function clearFleetSessionBindings(): void {
  const runtime = getFleetRuntime() as FleetRuntimeSessionState;
  runtime.sessionGeneration += 1;
  runtime.currentSessionId = undefined;
  runtime.presenter = undefined;
  runtime.dispatcher = undefined;
  runtime.promptSync = undefined;
}

export function connectToAdmiralty(
  socketPath: string,
  fleetIdToUse: string,
): void {
  const runtime = getFleetRuntime() as FleetRuntimeSessionState;
  const state = getState();
  const log = infra.log.getLogAPI();

  if (runtime.client) {
    if (runtime.client.getState() === "connected") {
      syncConnectedPrompt(fleetIdToUse);
    }
    notifyCurrentSession("[Grand Fleet] 이미 연결되어 있습니다.", "warning");
    return;
  }

  const client = new FleetClient(socketPath);
  runtime.client = client;

  client.onConnect(async () => {
    log.info(LOG_SOURCE, "Admiralty 접속 완료");
    notifyCurrentSession("[Grand Fleet] Admiralty 접속 완료", "info");

    const registered = await registerCurrentFleet(fleetIdToUse);
    if (registered) {
      startHeartbeat(fleetIdToUse);
      startFleetStatusSync(fleetIdToUse);
    }
  });

  client.onDisconnect(() => {
    log.warn(LOG_SOURCE, "Admiralty 연결 끊김");
    notifyCurrentSession("[Grand Fleet] Admiralty 연결 끊김", "warning");
    stopHeartbeat();
    stopFleetStatusSync();
    // Admiralty가 연결 단위로 register 상태를 보관하므로, auto-reconnect 이후의
    // registerCurrentFleet이 idempotent early-return으로 skip되지 않도록 reset한다.
    runtime.registeredFleetId = undefined;
    runtime.registeredSessionId = undefined;
  });

  registerFleetHandlers(client, {
    onMissionAssign: async (params) => {
      const objective = String(params.objective ?? "");
      const missionId = String(params.missionId ?? "");
      log.info(
        LOG_SOURCE,
        `작전 수령: missionId=${missionId}, objective=${objective.slice(0, 80)}`,
      );
      state.activeMissionId = missionId;
      state.activeMissionObjective = objective || null;
      clearMissionBuffer();
      flushFleetStatus(fleetIdToUse, true);
      dispatchMissionToCurrentSession(objective);
      return { accepted: true, missionId };
    },
    onMissionAbort: async (params) => {
      log.warn(LOG_SOURCE, `작전 중단 수신: missionId=${String(params.missionId ?? "")}`);
      state.activeMissionId = null;
      state.activeMissionObjective = null;
      clearMissionBuffer();
      flushFleetStatus(fleetIdToUse, true);
      return { aborted: true, missionId: String(params.missionId ?? "") };
    },
    onSessionNew: async () => {
      const sessionId = getCurrentBoundSessionId();
      if (!sessionId) return { unavailable: true, reason: "session_not_bound" };
      return { sessionId };
    },
    onSessionResume: async (params) => {
      const sessionId = getCurrentBoundSessionId() ?? String(params.sessionId ?? "");
      return { resumed: true, sessionId };
    },
    onSessionSuspend: async () => {
      state.activeMissionId = null;
      state.activeMissionObjective = null;
      clearMissionBuffer();
      flushFleetStatus(fleetIdToUse, true);
      return { suspended: true, sessionId: getCurrentBoundSessionId() ?? "" };
    },
    onFleetPing: async () => {
      return buildFleetPingPayload(fleetIdToUse);
    },
  });

  client.connect();
}

export function disconnectFromAdmiralty(
  fleetId: string,
  options: { resetPrompt?: () => void } = {},
): void {
  const runtime = getFleetRuntime() as FleetRuntimeSessionState;
  const state = getState();
  stopHeartbeat();
  stopFleetStatusSync();
  runtime.client?.sendNotification("fleet.deregister", {
    fleetId,
    sessionId: runtime.currentSessionId ?? runtime.registeredSessionId ?? "",
    reason: "user_request",
  });
  runtime.client?.close();
  runtime.client = null;
  state.activeMissionId = null;
  state.activeMissionObjective = null;
  clearMissionBuffer();
  runtime.lastHeartbeatAt = null;
  runtime.lastStatusSignature = null;
  runtime.pendingRegisterFleetId = undefined;
  runtime.inFlightRegister = undefined;
  runtime.registeredFleetId = undefined;
  runtime.registeredSessionId = undefined;
  options.resetPrompt?.();
  if (!options.resetPrompt) {
    syncBasePrompt();
  }
}

export function shutdownFleetRuntime(
  fleetId: string,
  options: { resetPrompt?: () => void } = {},
): void {
  const runtime = getFleetRuntime() as FleetRuntimeSessionState;
  stopHeartbeat();
  stopFleetStatusSync();
  if (!runtime.client) {
    clearMissionBuffer();
    options.resetPrompt?.();
    if (!options.resetPrompt) {
      syncBasePrompt();
    }
    return;
  }

  infra.log.getLogAPI().info(LOG_SOURCE, "Fleet 종료: deregister 전송");
  runtime.client.sendNotification("fleet.deregister", {
    fleetId,
    sessionId: runtime.currentSessionId ?? runtime.registeredSessionId ?? "",
    reason: "shutdown",
  });
  runtime.client.close();
  runtime.client = null;
  runtime.lastHeartbeatAt = null;
  runtime.lastStatusSignature = null;
  runtime.pendingRegisterFleetId = undefined;
  runtime.inFlightRegister = undefined;
  runtime.registeredFleetId = undefined;
  runtime.registeredSessionId = undefined;
  clearMissionBuffer();
  options.resetPrompt?.();
  if (!options.resetPrompt) {
    syncBasePrompt();
  }
}

export function clearMissionBuffer(): void {
  getFleetRuntime().missionTexts = [];
}

export function flushFleetStatus(fleetId: FleetId, force = false): void {
  const runtime = getFleetRuntime() as FleetRuntimeSessionState;
  if (!runtime.client || runtime.client.getState() !== "connected") {
    return;
  }

  const payload = buildFleetPingPayload(fleetId);
  const signature = JSON.stringify(payload);
  if (!force && signature === runtime.lastStatusSignature) {
    return;
  }

  runtime.lastStatusSignature = signature;
  runtime.client.sendNotification("fleet.status", payload as unknown as Record<string, unknown>);
}

async function registerCurrentFleet(fleetId: FleetId): Promise<boolean> {
  const runtime = getFleetRuntime() as FleetRuntimeSessionState;
  const client = runtime.client as FleetClient | null;
  const sessionId = getCurrentBoundSessionId();
  const log = infra.log.getLogAPI();
  if (!client || client.getState() !== "connected") return false;
  if (!sessionId) {
    runtime.pendingRegisterFleetId = fleetId;
    log.warn(LOG_SOURCE, "fleet.register 지연: 바인딩된 ACP 세션 ID가 없습니다");
    return false;
  }
  if (runtime.registeredSessionId === sessionId) {
    runtime.pendingRegisterFleetId = undefined;
    syncConnectedPrompt(fleetId);
    return true;
  }
  if (
    runtime.inFlightRegister?.fleetId === fleetId &&
    runtime.inFlightRegister.sessionId === sessionId
  ) {
    return false;
  }

  const registerGeneration = runtime.sessionGeneration;
  const inFlight: FleetRegisterInFlight = { fleetId, sessionId, generation: registerGeneration };
  runtime.inFlightRegister = inFlight;

  try {
    log.debug(LOG_SOURCE, "fleet.register 전송");
    await client.sendRequest(
      "fleet.register",
      buildFleetRegisterPayload(fleetId, sessionId) as unknown as Record<string, unknown>,
    );
    if (runtime.inFlightRegister !== inFlight || runtime.sessionGeneration !== registerGeneration || getCurrentBoundSessionId() !== sessionId) {
      if (runtime.inFlightRegister === inFlight) {
        runtime.inFlightRegister = undefined;
      }
      return false;
    }
    log.info(LOG_SOURCE, "fleet.register 성공");
    runtime.inFlightRegister = undefined;
    runtime.pendingRegisterFleetId = undefined;
    runtime.registeredFleetId = fleetId;
    runtime.registeredSessionId = sessionId;
    runtime.lastStatusSignature = null;
    syncConnectedPrompt(fleetId);
    flushFleetStatus(fleetId, true);
    startHeartbeat(fleetId);
    startFleetStatusSync(fleetId);
    return true;
  } catch (err) {
    if (runtime.inFlightRegister !== inFlight) {
      return false;
    }
    runtime.inFlightRegister = undefined;
    const message = err instanceof Error ? err.message : String(err);
    log.error(LOG_SOURCE, `fleet.register 실패: ${message}`);
    notifyCurrentSession(`[Grand Fleet] 등록 실패: ${message}`, "error");
    return false;
  }
}

function buildFleetRegisterPayload(fleetId: FleetId, sessionId: string): FleetRegisterPayload {
  const state = getState();
  const ping = buildFleetPingPayload(fleetId);
  return {
    fleetId,
    designation: state.designation ?? fleetId,
    operationalZone: process.cwd(),
    sessionId,
    protocolVersion: PROTOCOL_VERSION,
    carriers: ping.carriers,
  };
}

function getCurrentBoundSessionId(): string | undefined {
  const sessionId = (getFleetRuntime() as FleetRuntimeSessionState).currentSessionId;
  return sessionId && sessionId.trim() ? sessionId : undefined;
}

function startHeartbeat(fleetId: FleetId): void {
  const runtime = getFleetRuntime() as FleetRuntimeSessionState;
  stopHeartbeat();
  runtime.heartbeatTimer = setInterval(() => {
    runtime.lastHeartbeatAt = Date.now();
    infra.log.getLogAPI().debug(
      LOG_SOURCE,
      `heartbeat 전송: fleetId=${fleetId}`,
      { hideFromFooter: true },
    );
    runtime.client?.sendNotification("fleet.heartbeat", {
      fleetId,
      uptime: Math.floor(process.uptime()),
      activeMissionId: getState().activeMissionId,
      activeMissionObjective: getState().activeMissionObjective,
      cost: 0,
    });
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  const runtime = getFleetRuntime() as FleetRuntimeSessionState;
  if (!runtime.heartbeatTimer) {
    return;
  }

  clearInterval(runtime.heartbeatTimer);
  runtime.heartbeatTimer = null;
  runtime.lastHeartbeatAt = null;
}

function startFleetStatusSync(fleetId: FleetId): void {
  const runtime = getFleetRuntime();
  stopFleetStatusSync();
  runtime.statusSyncTimer = setInterval(() => {
    flushFleetStatus(fleetId);
  }, STATUS_SYNC_INTERVAL_MS);
}

function stopFleetStatusSync(): void {
  const runtime = getFleetRuntime();
  if (!runtime.statusSyncTimer) {
    return;
  }

  clearInterval(runtime.statusSyncTimer);
  runtime.statusSyncTimer = null;
  runtime.lastStatusSignature = null;
}

function notifyCurrentSession(
  message: string,
  level: "info" | "warning" | "error",
): void {
  const presenter = getFleetRuntime().presenter;
  presenter?.notify(message, level);
}

function dispatchMissionToCurrentSession(objective: string): void {
  const dispatcher = getFleetRuntime().dispatcher;
  dispatcher?.sendMission(objective);
}

function syncConnectedPrompt(fleetId: FleetId): void {
  const state = getState();
  getFleetRuntime().promptSync?.setConnected(
    fleetId,
    state.designation ?? fleetId,
    process.cwd(),
  );
}

function syncBasePrompt(): void {
  getFleetRuntime().promptSync?.setBaseOnly();
}

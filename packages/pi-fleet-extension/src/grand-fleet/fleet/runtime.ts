import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

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

const LOG_SOURCE = "grand-fleet";
const STATUS_SYNC_INTERVAL_MS = 1_000;

interface FleetRegisterPayload {
  fleetId: FleetId;
  designation: string;
  operationalZone: string;
  sessionId: string;
  protocolVersion: string;
  carriers: ReturnType<typeof buildFleetPingPayload>["carriers"];
}

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
  const runtime = getFleetRuntime();
  const generation = runtime.sessionGeneration + 1;
  runtime.sessionGeneration = generation;
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
}

export function clearFleetSessionBindings(): void {
  const runtime = getFleetRuntime();
  runtime.sessionGeneration += 1;
  runtime.presenter = undefined;
  runtime.dispatcher = undefined;
  runtime.promptSync = undefined;
}

export function connectToAdmiralty(
  socketPath: string,
  fleetIdToUse: string,
): void {
  const runtime = getFleetRuntime();
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

    try {
      log.debug(LOG_SOURCE, "fleet.register 전송");
      await client.sendRequest(
        "fleet.register",
        buildFleetRegisterPayload(fleetIdToUse) as unknown as Record<string, unknown>,
      );
      log.info(LOG_SOURCE, "fleet.register 성공");
      runtime.lastStatusSignature = null;
      syncConnectedPrompt(fleetIdToUse);
      flushFleetStatus(fleetIdToUse, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(LOG_SOURCE, `fleet.register 실패: ${message}`);
      notifyCurrentSession(`[Grand Fleet] 등록 실패: ${message}`, "error");
    }

    startHeartbeat(fleetIdToUse);
    startFleetStatusSync(fleetIdToUse);
  });

  client.onDisconnect(() => {
    log.warn(LOG_SOURCE, "Admiralty 연결 끊김");
    notifyCurrentSession("[Grand Fleet] Admiralty 연결 끊김", "warning");
    stopHeartbeat();
    stopFleetStatusSync();
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
      return { sessionId: `session-${Date.now()}` };
    },
    onSessionResume: async (params) => {
      return { resumed: true, sessionId: String(params.sessionId ?? "") };
    },
    onSessionSuspend: async () => {
      state.activeMissionId = null;
      state.activeMissionObjective = null;
      clearMissionBuffer();
      flushFleetStatus(fleetIdToUse, true);
      return { suspended: true, sessionId: "current" };
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
  const runtime = getFleetRuntime();
  const state = getState();
  stopHeartbeat();
  stopFleetStatusSync();
  runtime.client?.sendNotification("fleet.deregister", {
    fleetId,
    reason: "user_request",
  });
  runtime.client?.close();
  runtime.client = null;
  state.activeMissionId = null;
  state.activeMissionObjective = null;
  clearMissionBuffer();
  runtime.lastHeartbeatAt = null;
  runtime.lastStatusSignature = null;
  options.resetPrompt?.();
  if (!options.resetPrompt) {
    syncBasePrompt();
  }
}

export function shutdownFleetRuntime(
  fleetId: string,
  options: { resetPrompt?: () => void } = {},
): void {
  const runtime = getFleetRuntime();
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
    reason: "shutdown",
  });
  runtime.client.close();
  runtime.client = null;
  runtime.lastHeartbeatAt = null;
  runtime.lastStatusSignature = null;
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
  const runtime = getFleetRuntime();
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

function buildFleetRegisterPayload(fleetId: FleetId): FleetRegisterPayload {
  const state = getState();
  const ping = buildFleetPingPayload(fleetId);
  return {
    fleetId,
    designation: state.designation ?? fleetId,
    operationalZone: process.cwd(),
    sessionId: `session-${Date.now()}`,
    protocolVersion: PROTOCOL_VERSION,
    carriers: ping.carriers,
  };
}

function startHeartbeat(fleetId: FleetId): void {
  const runtime = getFleetRuntime();
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
  const runtime = getFleetRuntime();
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

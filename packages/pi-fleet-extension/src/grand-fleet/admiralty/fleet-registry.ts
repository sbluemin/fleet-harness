/**
 * Admiralty가 연결된 함대의 등록/해제,
 * heartbeat, 상태, 소켓 참조를 관리한다.
 */
import type { Socket } from "node:net";

import { infra } from "@sbluemin/fleet-core";
import type { FleetId, ConnectedFleet, CarrierMap } from "@sbluemin/fleet-core/admiralty";
import {
  PROTOCOL_VERSION,
  HEARTBEAT_TIMEOUT_MS,
  GRAND_FLEET_ERRORS,
} from "@sbluemin/fleet-core/admiralty";
import { getState } from "../state.js";

type RegisterParams = Record<string, unknown>;
type HeartbeatParams = Record<string, unknown>;
type StatusParams = Record<string, unknown>;
type ReportParams = Record<string, unknown>;

const HEARTBEAT_INTERVAL_SECONDS = 30;
const LOG_SOURCE = "grand-fleet";

export class FleetRegistry {
  /** fleetId → Socket 매핑 (소켓 참조 보관) */
  private sockets = new Map<FleetId, Socket>();

  /** heartbeat 타이머 */
  private heartbeatTimers = new Map<FleetId, ReturnType<typeof setTimeout>>();

  private changeListeners: Array<() => void> = [];

  /** 함대 등록 (fleet.register 핸들러) */
  async register(params: RegisterParams, socket: Socket): Promise<unknown> {
    const fleetId = params.fleetId as FleetId;
    const designation = normalizeDesignation(params.designation, fleetId);
    const state = getState();
    const log = infra.log.getLogAPI();

    try {
      if (!fleetId) {
        throw createRegistryError(
          GRAND_FLEET_ERRORS.FLEET_NOT_REGISTERED.code,
          "Fleet ID is required",
        );
      }

      if (params.protocolVersion !== PROTOCOL_VERSION) {
        log.warn(
          LOG_SOURCE,
          `Fleet ${fleetId} 프로토콜 버전 검사 실패 (expected=${PROTOCOL_VERSION}, actual=${String(params.protocolVersion)})`,
        );
        throw createRegistryError(
          GRAND_FLEET_ERRORS.PROTOCOL_VERSION_MISMATCH.code,
          GRAND_FLEET_ERRORS.PROTOCOL_VERSION_MISMATCH.message,
        );
      }

      const previousSocket = this.sockets.get(fleetId);
      const wasTakeover = previousSocket !== undefined;
      if (previousSocket && previousSocket !== socket) {
        log.warn(LOG_SOURCE, `Fleet ${fleetId} 재연결 감지 — 기존 소켓 교체`);
        previousSocket.destroy();
      }

      const fleet: ConnectedFleet = {
        id: fleetId,
        designation,
        operationalZone: params.operationalZone as string,
        sessionId: params.sessionId as string,
        protocolVersion: params.protocolVersion as string,
        carriers: ((params.carriers ?? {}) as CarrierMap),
        status: "idle",
        activeMissionId: null,
        activeMissionObjective: null,
        cost: 0,
        lastHeartbeat: Date.now(),
      };

      state.connectedFleets.set(fleetId, fleet);
      this.sockets.set(fleetId, socket);
      this.startHeartbeatTimer(fleetId);

      log.info(
        LOG_SOURCE,
        `Fleet ${fleetId} 등록 완료 (designation=${designation}, zone=${fleet.operationalZone})`,
      );

      this.notifyChange();
      return {
        registered: true,
        takeover: wasTakeover,
        protocolVersion: PROTOCOL_VERSION,
        heartbeatInterval: HEARTBEAT_INTERVAL_SECONDS,
      };
    } catch (error) {
      log.error(LOG_SOURCE, `Fleet ${fleetId} 등록 실패: ${toErrorMessage(error)}`);
      throw error;
    }
  }

  /** 함대 해제 */
  deregister(fleetId: FleetId): void {
    const state = getState();
    const hadFleet = state.connectedFleets.delete(fleetId);
    const socket = this.sockets.get(fleetId);
    this.sockets.delete(fleetId);
    this.clearHeartbeatTimer(fleetId);
    if (socket && !socket.destroyed) {
      socket.destroy();
    }
    infra.log.getLogAPI().info(LOG_SOURCE, `Fleet ${fleetId} 등록 해제`);
    if (!hadFleet) {
      return;
    }
    this.notifyChange();
  }

  deregisterBySocket(socket: Socket, reason = "socket_closed"): FleetId | null {
    const fleetId = this.findFleetIdBySocket(socket);
    if (!fleetId) return null;
    infra.log.getLogAPI().warn(LOG_SOURCE, `Fleet ${fleetId} 연결 종료 감지 (${reason})`);
    this.deregister(fleetId);
    return fleetId;
  }

  shutdown(): void {
    for (const fleetId of this.sockets.keys()) {
      this.clearHeartbeatTimer(fleetId);
    }
    this.sockets.clear();
    getState().connectedFleets.clear();
    this.notifyChange();
  }

  /** heartbeat 수신 */
  heartbeat(params: HeartbeatParams): void {
    const fleetId = params.fleetId as FleetId;
    const state = getState();
    const fleet = state.connectedFleets.get(fleetId);
    if (!fleet) return;

    fleet.lastHeartbeat = Date.now();
    fleet.cost = (params.cost as number | undefined) ?? fleet.cost;

    if (params.activeMissionId !== undefined) {
      fleet.activeMissionId = params.activeMissionId as string | null;
    }

    if (params.activeMissionObjective !== undefined) {
      fleet.activeMissionObjective = params.activeMissionObjective as string | null;
    }

    state.totalCost = calculateTotalCost();
    this.resetHeartbeatTimer(fleetId);
    infra.log.getLogAPI().debug(LOG_SOURCE, `Fleet ${fleetId} heartbeat (cost=${fleet.cost})`);
    this.notifyChange();
  }

  /** Carrier 상태 업데이트 */
  updateStatus(params: StatusParams): void {
    const fleetId = params.fleetId as FleetId;
    const state = getState();
    const fleet = state.connectedFleets.get(fleetId);
    if (!fleet) return;

    fleet.status =
      (params.fleetStatus as ConnectedFleet["status"] | undefined) ??
      fleet.status;

    if (params.carriers) {
      Object.assign(fleet.carriers, params.carriers as CarrierMap);
    }

    if (params.activeMissionId !== undefined) {
      fleet.activeMissionId = params.activeMissionId as string | null;
    }

    if (params.activeMissionObjective !== undefined) {
      fleet.activeMissionObjective = params.activeMissionObjective as string | null;
    }

    infra.log.getLogAPI().debug(LOG_SOURCE, `Fleet ${fleetId} 상태 변경: ${fleet.status}`);
    this.notifyChange();
  }

  /** 작전 보고 처리 */
  handleReport(params: ReportParams): void {
    const fleetId = params.fleetId as FleetId;
    const state = getState();
    const fleet = state.connectedFleets.get(fleetId);
    if (!fleet) return;

    const type = params.type as string;
    infra.log.getLogAPI().info(LOG_SOURCE, `Fleet ${fleetId} 보고: ${type}`);
    if (type === "complete" || type === "failed") {
      fleet.activeMissionId = null;
      fleet.activeMissionObjective = null;
      fleet.status = "idle";
    }
    this.notifyChange();
  }

  /** 함대 소켓 참조 조회 */
  getSocket(fleetId: FleetId): Socket | undefined {
    return this.sockets.get(fleetId);
  }

  /** 프롬프트용 로스터 생성 */
  getRoster(): Array<{ id: FleetId; designation: string; zone: string; status: string }> {
    const state = getState();
    return Array.from(state.connectedFleets.values()).map((fleet) => ({
      id: fleet.id,
      designation: fleet.designation,
      zone: fleet.operationalZone,
      status: fleet.status,
    }));
  }

  getFleetByDirectory(directory: string): ConnectedFleet | undefined {
    const state = getState();
    return Array.from(state.connectedFleets.values()).find(
      (fleet) => fleet.operationalZone === directory,
    );
  }

  getConnectedFleet(fleetId: FleetId): ConnectedFleet | undefined {
    return getState().connectedFleets.get(fleetId);
  }

  hasDesignationConflict(designation: string, fleetId?: FleetId): ConnectedFleet | null {
    const normalized = designation.trim();
    if (!normalized) return null;

    for (const fleet of getState().connectedFleets.values()) {
      if (fleet.id === fleetId) continue;
      if (fleet.designation === normalized) {
        return fleet;
      }
    }

    return null;
  }

  /** 상태 변경 리스너 등록 */
  onChange(listener: () => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter((item) => item !== listener);
    };
  }

  /** 등록된 리스너들에게 변경 알림 */
  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      listener();
    }
  }

  /** heartbeat 감시 타이머를 시작한다. */
  private startHeartbeatTimer(fleetId: FleetId): void {
    this.heartbeatTimers.set(
      fleetId,
      setTimeout(() => {
        infra.log.getLogAPI().warn(LOG_SOURCE, `Fleet ${fleetId} heartbeat 타임아웃 — 등록 해제`);
        this.deregister(fleetId);
      }, HEARTBEAT_TIMEOUT_MS),
    );
  }

  /** heartbeat 감시 타이머를 재시작한다. */
  private resetHeartbeatTimer(fleetId: FleetId): void {
    this.clearHeartbeatTimer(fleetId);
    this.startHeartbeatTimer(fleetId);
  }

  /** heartbeat 감시 타이머를 정리한다. */
  private clearHeartbeatTimer(fleetId: FleetId): void {
    const timer = this.heartbeatTimers.get(fleetId);
    if (!timer) return;

    clearTimeout(timer);
    this.heartbeatTimers.delete(fleetId);
  }

  private findFleetIdBySocket(target: Socket): FleetId | null {
    for (const [fleetId, socket] of this.sockets.entries()) {
      if (socket === target) {
        return fleetId;
      }
    }

    return null;
  }
}

function calculateTotalCost(): number {
  const state = getState();
  return Array.from(state.connectedFleets.values()).reduce(
    (sum, fleet) => sum + fleet.cost,
    0,
  );
}

function createRegistryError(
  code: number,
  message: string,
  data?: Record<string, unknown>,
): Error & { code: number; data?: Record<string, unknown> } {
  return Object.assign(new Error(message), { code, data });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeDesignation(value: unknown, fleetId: FleetId): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return fleetId;
}

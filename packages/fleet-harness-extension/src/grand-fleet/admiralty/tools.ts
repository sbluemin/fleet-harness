import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { Socket } from "node:net";
import * as path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  GRAND_FLEET_BROADCAST_DESCRIPTION,
  GRAND_FLEET_BROADCAST_LABEL,
  GRAND_FLEET_BROADCAST_NAME,
  GRAND_FLEET_DEPLOY_DESCRIPTION,
  GRAND_FLEET_DEPLOY_LABEL,
  GRAND_FLEET_DEPLOY_NAME,
  GRAND_FLEET_DISPATCH_DESCRIPTION,
  GRAND_FLEET_DISPATCH_LABEL,
  GRAND_FLEET_DISPATCH_NAME,
  GRAND_FLEET_RECALL_DESCRIPTION,
  GRAND_FLEET_RECALL_LABEL,
  GRAND_FLEET_RECALL_NAME,
  GRAND_FLEET_STATUS_DESCRIPTION,
  GRAND_FLEET_STATUS_LABEL,
  GRAND_FLEET_STATUS_NAME,
  GrandFleetBroadcastParams,
  GrandFleetDeployParams,
  GrandFleetDispatchParams,
  GrandFleetRecallParams,
  GrandFleetStatusParams,
  normalizePriority,
  type CarrierMap,
  type ConnectedFleet,
  type FleetStatus,
  type MissionId,
} from "@sbluemin/fleet-core/admiralty";

import { infra } from "@sbluemin/fleet-core";
import { getState } from "../state.js";
import type { FleetRegistry } from "./fleet-registry.js";
import { getAdmiraltyRegistry, getAdmiraltyServer } from "./runtime.js";
import type { AdmiraltyServer } from "./server.js";
import { syncRosterWidget } from "./roster-widget.js";

interface DeployParams {
  designation: string;
  directory: string;
}

interface DeployResult {
  designation: string;
  directory: string;
  fleetId: string;
  reused: boolean;
}

interface DispatchParams {
  fleetId: string;
  directive: string;
  priority?: string;
}

interface RecallParams {
  fleetId: string;
}

interface BroadcastParams {
  directive: string;
  priority?: string;
}

interface StatusParams {
  fleetId?: string;
}

interface RegistryFleetRecord {
  cost: number;
  carriers: CarrierMap;
  connected: boolean;
  designation: string;
  directory: string;
  id: string;
  activeMissionId: MissionId | null;
  socket?: Socket;
  status: FleetStatus | string;
}

interface RegistryLike {
  getSocket?(fleetId: string): Socket | undefined;
}

interface MissionAck {
  acknowledgement: unknown;
  designation: string;
  fleetId: string;
  missionId: string;
  priority: string;
}

interface FleetStatusView {
  activeMissionId: string | null;
  connected: boolean;
  cost: number;
  designation: string;
  directory: string;
  fleetId: string;
  carrierStatus: CarrierMap;
  status: string;
}

interface RecallSnapshot {
  activeMissionId: string | null;
  activeMissionObjective: string | null;
  designation: string;
  directory: string;
  fleetId: string;
  status: string;
}

const LOG_SOURCE = "grand-fleet";
const FORMATION_DEPLOY_REMOVED_MESSAGE =
  "Grand Fleet formation/tmux 기반 배치는 제거되었습니다. 이미 연결된 Fleet만 재사용할 수 있습니다.";

export function registerAdmiraltyTools(
  pi: ExtensionAPI,
): void {
  pi.registerTool({
    name: GRAND_FLEET_DEPLOY_NAME,
    label: GRAND_FLEET_DEPLOY_LABEL,
    description: GRAND_FLEET_DEPLOY_DESCRIPTION,
    parameters: GrandFleetDeployParams as any,
    async execute(_toolCallId: string, params: DeployParams) {
      const log = infra.log.getLogAPI();
      const { registry } = requireRuntime();

      log.info(
        LOG_SOURCE,
        `deploy: ${params.designation} ← ${params.directory}`,
      );

      const result = await deployFleet(registry, params);
      syncRosterWidget();

      return {
        content: [{
          type: "text" as const,
          text: result.reused
            ? `Fleet 재사용: ${result.designation} (${result.fleetId})`
            : `Fleet 파견 완료: ${result.designation} (${result.fleetId})`,
        }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: GRAND_FLEET_DISPATCH_NAME,
    label: GRAND_FLEET_DISPATCH_LABEL,
    description: GRAND_FLEET_DISPATCH_DESCRIPTION,
    parameters: GrandFleetDispatchParams as any,
    async execute(_toolCallId: string, params: DispatchParams) {
      const log = infra.log.getLogAPI();
      const { registry, server } = requireRuntime();
      const priority = normalizePriority(params.priority);
      const missionId = createMissionId();
      log.info(
        LOG_SOURCE,
        `dispatch: Fleet ${params.fleetId} ← ${summarizeDirective(params.directive)}`,
      );

      try {
        const fleet = requireFleetRecord(registry, params.fleetId);
        const socket = requireFleetSocket(fleet);

        const acknowledgement = await server.sendRequest(
          socket,
          "mission.assign",
          {
            missionId,
            objective: params.directive,
            priority,
          },
          Date.now(),
        );

        const fleetState = getState().connectedFleets.get(params.fleetId);
        if (fleetState) {
          fleetState.activeMissionId = missionId;
          fleetState.activeMissionObjective = params.directive.slice(0, 40);
          syncRosterWidget();
        }

        log.debug(LOG_SOURCE, `dispatch 완료: ${missionId}`);

        const result: MissionAck = {
          acknowledgement,
          designation: fleet.designation,
          fleetId: fleet.id,
          missionId,
          priority,
        };

        return {
          content: [{
            type: "text" as const,
            text: `작전 수령 확인: ${fleet.designation} (${fleet.id}) <- ${missionId} (${priority})`,
          }],
          details: result,
        };
      } catch (error) {
        log.error(
          LOG_SOURCE,
          `dispatch 실패: Fleet ${params.fleetId} — ${toErrorMessage(error)}`,
        );
        throw error;
      }
    },
  });

  pi.registerTool({
    name: GRAND_FLEET_RECALL_NAME,
    label: GRAND_FLEET_RECALL_LABEL,
    description: GRAND_FLEET_RECALL_DESCRIPTION,
    parameters: GrandFleetRecallParams as any,
    async execute(_toolCallId: string, params: RecallParams) {
      const log = infra.log.getLogAPI();
      const { registry } = requireRuntime();
      const fleet = requireFleetRecord(registry, params.fleetId);
      const snapshot = createRecallSnapshot(fleet);

      log.warn(
        LOG_SOURCE,
        `recall: ${snapshot.designation} (${snapshot.fleetId})`,
      );

      registry.deregister(params.fleetId);
      syncRosterWidget();

      return {
        content: [{
          type: "text" as const,
          text: `함대 철수 명령 전송: ${snapshot.designation} (${snapshot.fleetId})`,
        }],
        details: {
          recalled: true,
          snapshot,
        },
      };
    },
  });

  pi.registerTool({
    name: GRAND_FLEET_BROADCAST_NAME,
    label: GRAND_FLEET_BROADCAST_LABEL,
    description: GRAND_FLEET_BROADCAST_DESCRIPTION,
    parameters: GrandFleetBroadcastParams as any,
    async execute(_toolCallId: string, params: BroadcastParams) {
      const log = infra.log.getLogAPI();
      const { registry, server } = requireRuntime();
      const priority = normalizePriority(params.priority);
      const missionId = createMissionId();
      const fleets = listConnectedFleetRecords(registry);

      log.info(LOG_SOURCE, `broadcast: ${fleets.length}개 함대에 작전 하달`);

      const acknowledgements = await Promise.all(
        fleets.map(async (fleet, index) => {
          const socket = requireFleetSocket(fleet);
          const acknowledgement = await server.sendRequest(
            socket,
            "mission.assign",
            {
              missionId,
              objective: params.directive,
              priority,
            },
            Date.now() + index,
          );

          return {
            acknowledgement,
            designation: fleet.designation,
            fleetId: fleet.id,
          };
        }),
      );

      const objectivePreview = params.directive.slice(0, 40);
      for (const ack of acknowledgements) {
        const fleetState = getState().connectedFleets.get(ack.fleetId);
        if (fleetState) {
          fleetState.activeMissionId = missionId;
          fleetState.activeMissionObjective = objectivePreview;
        }
      }
      syncRosterWidget();

      return {
        content: [{
          type: "text" as const,
          text: `전 함대 동시 하달 완료: ${acknowledgements.length}개 함대, ${missionId} (${priority})`,
        }],
        details: {
          acknowledgements,
          missionId,
          priority,
        },
      };
    },
  });

  pi.registerTool({
    name: GRAND_FLEET_STATUS_NAME,
    label: GRAND_FLEET_STATUS_LABEL,
    description: GRAND_FLEET_STATUS_DESCRIPTION,
    parameters: GrandFleetStatusParams as any,
    async execute(_toolCallId: string, params: StatusParams) {
      const log = infra.log.getLogAPI();
      const { registry } = requireRuntime();
      const fleets = params.fleetId
        ? [requireFleetRecord(registry, params.fleetId)]
        : listAllFleetRecords(registry);
      const status = fleets.map(toFleetStatusView);

      log.debug(
        LOG_SOURCE,
        `status 조회: ${params.fleetId ? `Fleet ${params.fleetId}` : `${status.length}개 함대 전체`}`,
      );

      return {
        content: [{
          type: "text" as const,
          text: formatStatusSummary(status),
        }],
        details: {
          fleets: status,
        },
      };
    },
  });
}

function requireRuntime(): { registry: FleetRegistry; server: AdmiraltyServer } {
  return { registry: getAdmiraltyRegistry(), server: getAdmiraltyServer() };
}

async function deployFleet(
  registry: FleetRegistry,
  params: DeployParams,
): Promise<DeployResult> {
  if (!getState().socketPath) {
    throw new Error("Admiralty 소켓 경로가 초기화되지 않았습니다.");
  }

  const designation = normalizeDesignation(params.designation);
  const directory = resolveFleetDirectory(params.directory);
  const fleetId = createFleetId(directory);
  const existingFleet = registry.getFleetByDirectory(directory);
  const designationConflict = registry.hasDesignationConflict(designation, fleetId);

  if (designationConflict) {
    throw new Error(
      `이미 다른 함대가 designation을 사용 중입니다: ${designation} (${designationConflict.id})`,
    );
  }

  if (existingFleet && registry.getSocket(existingFleet.id)) {
    return {
      designation: existingFleet.designation,
      directory,
      fleetId: existingFleet.id,
      reused: true,
    };
  }

  throw new Error(FORMATION_DEPLOY_REMOVED_MESSAGE);
}


function normalizeDesignation(designation: string): string {
  const normalized = designation.trim();
  if (!normalized) {
    throw new Error("designation은 비어 있을 수 없습니다.");
  }
  return normalized;
}

function resolveFleetDirectory(inputDirectory: string): string {
  const projectRoot = fs.realpathSync.native(process.cwd());
  const candidatePath = path.resolve(projectRoot, inputDirectory);

  let directory: string;
  try {
    directory = fs.realpathSync.native(candidatePath);
  } catch {
    throw new Error(`대상 디렉토리가 존재하지 않습니다: ${inputDirectory}`);
  }

  const stat = fs.statSync(directory);
  if (!stat.isDirectory()) {
    throw new Error(`대상 경로가 디렉토리가 아닙니다: ${inputDirectory}`);
  }

  const relative = path.relative(projectRoot, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("directory는 현재 프로젝트 루트의 하위 디렉토리여야 합니다.");
  }

  return directory;
}

function createFleetId(directory: string): string {
  const hash = crypto.createHash("sha256").update(directory).digest("hex").slice(0, 12);
  const base = path.basename(directory).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const safeBase = base || "fleet";
  return `${safeBase}-${hash}`;
}

function createMissionId(): string {
  return `mission-${Date.now()}`;
}

function summarizeDirective(directive: string): string {
  const normalized = directive.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 50);
}

function requireFleetRecord(
  registry: FleetRegistry,
  fleetId: string,
): RegistryFleetRecord {
  const directMatch = getState().connectedFleets.get(fleetId);
  const normalized = normalizeFleetRecord(directMatch, fleetId);

  if (!normalized) {
    infra.log.getLogAPI().warn(LOG_SOURCE, `함대 미등록: ${fleetId}`);
    throw new Error(`등록되지 않은 함대입니다: ${fleetId}`);
  }

  return attachFleetSocket(registry, normalized);
}

function listConnectedFleetRecords(registry: FleetRegistry): RegistryFleetRecord[] {
  return Array.from(getState().connectedFleets.values())
    .map((fleet) => normalizeFleetRecord(fleet, fleet.id))
    .filter((fleet): fleet is RegistryFleetRecord => Boolean(fleet))
    .map((fleet) => attachFleetSocket(registry, fleet))
    .filter((fleet) => fleet.connected);
}

function listAllFleetRecords(registry: FleetRegistry): RegistryFleetRecord[] {
  return Array.from(getState().connectedFleets.values())
    .map((fleet) => normalizeFleetRecord(fleet, fleet.id))
    .filter((fleet): fleet is RegistryFleetRecord => Boolean(fleet))
    .map((fleet) => attachFleetSocket(registry, fleet));
}

function normalizeFleetRecord(
  value: unknown,
  fallbackId: string,
): RegistryFleetRecord | null {
  if (!value || typeof value !== "object") return null;

  const candidate = value as Partial<ConnectedFleet> & Record<string, unknown>;
  const socket = pickSocket(candidate);
  const carriers = isCarrierMap(candidate.carriers) ? candidate.carriers : {};
  const status = typeof candidate.status === "string" ? candidate.status : "idle";
  const cost = typeof candidate.cost === "number" ? candidate.cost : 0;
  const activeMissionId =
    typeof candidate.activeMissionId === "string" ? candidate.activeMissionId : null;
  const id = typeof candidate.id === "string" && candidate.id.length > 0
    ? candidate.id
    : fallbackId;
  const designation =
    typeof candidate.designation === "string" && candidate.designation.trim()
      ? candidate.designation
      : id;
  const directory =
    typeof candidate.operationalZone === "string" && candidate.operationalZone.length > 0
      ? candidate.operationalZone
      : "";
  const connected =
    typeof candidate.connected === "boolean"
      ? candidate.connected
      : socket !== undefined;

  return {
    activeMissionId,
    carriers,
    connected,
    cost,
    designation,
    directory,
    id,
    status,
    socket,
  };
}

function pickSocket(candidate: Record<string, unknown>): Socket | undefined {
  const socketCandidate =
    candidate.socket ??
    candidate.fleetSocket ??
    candidate.connection;

  return isSocket(socketCandidate) ? socketCandidate : undefined;
}

function isSocket(value: unknown): value is Socket {
  return Boolean(
    value &&
    typeof value === "object" &&
    "write" in value &&
    typeof (value as Socket).write === "function",
  );
}

function isCarrierMap(value: unknown): value is CarrierMap {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireFleetSocket(fleet: RegistryFleetRecord): Socket {
  if (fleet.socket) return fleet.socket;
  throw new Error(`연결되지 않은 함대입니다: ${fleet.designation} (${fleet.id})`);
}

function attachFleetSocket(
  registry: FleetRegistry,
  fleet: RegistryFleetRecord,
): RegistryFleetRecord {
  const registryLike = registry as unknown as RegistryLike;
  const socket = registryLike.getSocket?.(fleet.id) ?? fleet.socket;

  return {
    ...fleet,
    connected: socket !== undefined,
    socket,
  };
}

function toFleetStatusView(fleet: RegistryFleetRecord): FleetStatusView {
  return {
    activeMissionId: fleet.activeMissionId,
    connected: fleet.connected,
    cost: fleet.cost,
    designation: fleet.designation,
    directory: fleet.directory,
    fleetId: fleet.id,
    carrierStatus: fleet.carriers,
    status: fleet.status,
  };
}

function createRecallSnapshot(fleet: RegistryFleetRecord): RecallSnapshot {
  return {
    activeMissionId: fleet.activeMissionId,
    activeMissionObjective:
      getState().connectedFleets.get(fleet.id)?.activeMissionObjective ?? null,
    designation: fleet.designation,
    directory: fleet.directory,
    fleetId: fleet.id,
    status: fleet.status,
  };
}

function formatStatusSummary(fleets: FleetStatusView[]): string {
  if (fleets.length === 0) {
    return "조회 가능한 함대가 없습니다.";
  }

  return fleets
    .map((fleet) => {
      const carrierCount = Object.keys(fleet.carrierStatus).length;
      const mission = fleet.activeMissionId ?? "-";
      return `${fleet.designation} (${fleet.fleetId}): status=${fleet.status}, connected=${fleet.connected}, carriers=${carrierCount}, cost=${fleet.cost}, mission=${mission}, dir=${fleet.directory}`;
    })
    .join("\n");
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { CLI_BACKENDS, type CliType } from "@sbluemin/unified-agent";

import type {
  CarrierInfo,
  CarrierMap,
  CarrierStatus,
  FleetId,
  FleetStatus,
} from "./types.js";

export interface FleetPingPayload {
  activeMissionId: string | null;
  activeMissionObjective: string | null;
  carriers: CarrierMap;
  cost: number;
  fleetId: FleetId;
  fleetStatus: FleetStatus;
  uptime: number;
}

export interface FleetFrameworkLikeConfig {
  cliType?: string;
  displayName?: string;
}

export interface FleetFrameworkLikeMode {
  config?: FleetFrameworkLikeConfig;
}

export interface FleetFrameworkLikeState {
  modes?: Map<string, FleetFrameworkLikeMode>;
  registeredOrder?: string[];
  sortieDisabledCarriers?: Set<string>;
  squadronEnabledCarriers?: Set<string>;
  taskforceConfiguredCarriers?: Set<string>;
}

export interface GrandFleetMissionState {
  activeMissionId: string | null;
  activeMissionObjective: string | null;
}

export interface StreamRunLikeState {
  error?: string;
  requestPreview?: string;
  status?: string;
}

export interface StreamStoreLikeState {
  runs?: Map<string, StreamRunLikeState>;
  visibleRunIdByCli?: Map<string, string>;
}

export function buildFleetPingPayloadFromState(input: {
  fleetId: FleetId;
  framework: FleetFrameworkLikeState;
  mission: GrandFleetMissionState;
  streams: StreamStoreLikeState;
  uptime: number;
}): FleetPingPayload {
  const carriers = collectCarrierMap(input.framework, input.streams);
  return {
    fleetId: input.fleetId,
    fleetStatus: deriveFleetStatus(carriers, input.mission),
    activeMissionId: input.mission.activeMissionId,
    activeMissionObjective: input.mission.activeMissionObjective,
    uptime: input.uptime,
    cost: 0,
    carriers,
  };
}

export function collectCarrierMap(
  framework: FleetFrameworkLikeState,
  _streams: StreamStoreLikeState,
): CarrierMap {
  const carriers: CarrierMap = {};
  const order = framework.registeredOrder ?? [];

  for (const carrierId of order) {
    const mode = framework.modes?.get(carrierId);
    const cli = normalizeCliBackend(mode?.config?.cliType);
    const isUnavailable = framework.sortieDisabledCarriers?.has(carrierId) ?? false;
    const isStandby = framework.squadronEnabledCarriers?.has(carrierId) ?? false;
    const status = deriveCarrierStatus(undefined, isUnavailable, isStandby);
    const info: CarrierInfo = {
      status,
    };

    if (cli) {
      info.cli = cli;
    }

    if (framework.taskforceConfiguredCarriers?.has(carrierId)) {
      info.tfConfigured = true;
    }

    carriers[carrierId] = info;
  }

  return carriers;
}

export function deriveFleetStatus(
  carriers: CarrierMap,
  mission: GrandFleetMissionState,
): FleetStatus {
  if (mission.activeMissionId) {
    return "active";
  }

  const carrierStatuses = Object.values(carriers).map((carrier) => carrier.status);
  if (carrierStatuses.some((status) => status === "error")) {
    return "error";
  }
  if (carrierStatuses.some((status) => status === "active")) {
    return "active";
  }
  return "idle";
}

function deriveCarrierStatus(
  runStatus: string | undefined,
  isUnavailable: boolean,
  isStandby: boolean,
): CarrierStatus {
  if (runStatus === "conn" || runStatus === "stream") {
    return "active";
  }
  if (runStatus === "err") {
    return "error";
  }
  if (runStatus === "done") {
    return "done";
  }
  if (isUnavailable) {
    return "unavailable";
  }
  if (isStandby) {
    return "standby";
  }
  return "idle";
}

function deriveCarrierTask(run: StreamRunLikeState | undefined): string | undefined {
  const requestPreview = run?.requestPreview?.trim();
  if (requestPreview) {
    return sanitizeTaskText(requestPreview);
  }
  const error = run?.error?.trim();
  return error ? sanitizeTaskText(error) : undefined;
}

function normalizeCliBackend(value: string | undefined): CliType | undefined {
  return value !== undefined && value in CLI_BACKENDS ? value as CliType : undefined;
}

function sanitizeTaskText(value: string): string {
  const masked = value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_][0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/sk-[a-zA-Z0-9]{20,}/g, "[REDACTED]")
    .replace(/ghp_[a-zA-Z0-9]{36,}/g, "[REDACTED]")
    .replace(/xox[bpras]-[a-zA-Z0-9-]+/g, "[REDACTED]")
    .replace(/\b[a-zA-Z0-9_-]{40,}\b/g, "[REDACTED]");

  return masked.slice(0, 80);
}

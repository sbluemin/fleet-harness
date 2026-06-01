import * as fs from "node:fs";
import * as path from "node:path";

import {
  getEffort,
  getProviderModels,
  type CliType,
} from "@dotobokuri/fleet-unified-agent";

import {
  sanitizeAgentCli,
  sanitizeAgentCliType,
  sanitizeCarriersMap,
  sanitizeGeneration,
  sanitizeTaskforce,
} from "./sanitize.js";
import { withStoreDirectoryLock } from "./store-lock.js";
import type { CarrierModelDefaults } from "./models.js";
import type {
  AgentCliSelection,
  FleetCarriers,
  FleetStoreSnapshot,
  FleetStoreWriteFingerprint,
  ResolvedCarrierState,
} from "./types.js";

interface StateIoRuntimeState {
  storeDir: string | null;
  lastLocalWriteGeneration: number;
  lastLocalWriteFingerprint: FleetStoreWriteFingerprint | null;
}

const FILENAME = "carriers.json";
const STALE_SUBAGENT_MODE_FILENAME = "carrier-subagent.json";

const runtimeState: StateIoRuntimeState = {
  storeDir: null,
  lastLocalWriteGeneration: 0,
  lastLocalWriteFingerprint: null,
};

export function initStore(dir: string): void {
  runtimeState.storeDir = dir;
  fs.mkdirSync(dir, { recursive: true });
  withStoreDirectoryLock(dir, () => {
    unlinkStaleSubagentModeFile(dir);
  });
}

export function resetStoreForTests(): void {
  runtimeState.storeDir = null;
  runtimeState.lastLocalWriteGeneration = 0;
  runtimeState.lastLocalWriteFingerprint = null;
}

export function readCarriersSnapshot(
  defaultsByCarrier: Record<string, CliType | CarrierModelDefaults> = {},
): FleetStoreSnapshot {
  const raw = readCarriers();
  const carrierIds = new Set([
    ...Object.keys(raw.carriers ?? {}),
    ...Object.keys(defaultsByCarrier),
  ]);
  return {
    generation: sanitizeGeneration(raw._meta?.generation),
    carriers: Object.fromEntries([...carrierIds].map((carrierId) => [
      carrierId,
      resolveSnapshotCarrierState(raw.carriers?.[carrierId] ?? {}, normalizeDefaults(defaultsByCarrier[carrierId])),
    ])),
  };
}

export function readRawCarriers(): FleetCarriers {
  return readCarriers();
}

export function getLastLocalCarriersGeneration(): number {
  return runtimeState.lastLocalWriteGeneration;
}

/** `writeCarriers` 직후 동기 stat으로 기록된 최신 로컬 write 지문(없으면 null) */
export function getLastLocalWriteFingerprint(): FleetStoreWriteFingerprint | null {
  return runtimeState.lastLocalWriteFingerprint;
}

export function getCarriersFilePath(): string | null {
  if (!runtimeState.storeDir) return null;
  return path.join(runtimeState.storeDir, FILENAME);
}

export function updateCarriers(mutator: (states: FleetCarriers) => void): void {
  if (!runtimeState.storeDir) return;
  withStoreLock(() => {
    const carriers = readCarriers();
    const snapshot = structuredClone(carriers);
    mutator(carriers);
    if (JSON.stringify(snapshot) === JSON.stringify(carriers)) return;
    // read-modify-write 전체가 directory lock 내부라 별도 CAS retry 없이 generation만 증가시킵니다.
    writeCarriers(carriers);
  });
}

export function withStoreLock<T>(operation: () => T): T {
  return withStoreDirectoryLock(runtimeState.storeDir, operation);
}

function readCarriers(): FleetCarriers {
  if (!runtimeState.storeDir) return {};
  const filePath = path.join(runtimeState.storeDir, FILENAME);
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return sanitizeFleetCarriers(parsed);
  } catch {
    return {};
  }
}

function recordLastLocalWriteFingerprint(filePath: string, generation: number): void {
  try {
    const st = fs.statSync(filePath);
    runtimeState.lastLocalWriteFingerprint = { generation, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    runtimeState.lastLocalWriteFingerprint = { generation, mtimeMs: 0, size: 0 };
  }
}

function writeCarriers(s: FleetCarriers): void {
  if (!runtimeState.storeDir) throw new Error("Fleet store is not initialized.");
  fs.mkdirSync(runtimeState.storeDir, { recursive: true });
  const filePath = path.join(runtimeState.storeDir, FILENAME);
  const tmpPath = buildTempPath(filePath);
  const next = serializeFleetCarriers(s);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
    runtimeState.lastLocalWriteGeneration = next._meta?.generation ?? 0;
    recordLastLocalWriteFingerprint(filePath, runtimeState.lastLocalWriteGeneration);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw error;
  }
}

function serializeFleetCarriers(states: FleetCarriers): FleetCarriers {
  const next: FleetCarriers = {
    _meta: { generation: sanitizeGeneration(states._meta?.generation) + 1 },
  };
  const carriers = sanitizeCarriersMap(states.carriers);
  if (Object.keys(carriers).length > 0) next.carriers = carriers;
  return next;
}

function sanitizeFleetCarriers(value: unknown): FleetCarriers {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as FleetCarriers;
  return {
    _meta: { generation: sanitizeGeneration(record._meta?.generation) },
    carriers: sanitizeCarriersMap(record.carriers),
  };
}

function normalizeDefaults(value: CliType | CarrierModelDefaults | undefined): CarrierModelDefaults | undefined {
  if (!value) return undefined;
  return typeof value === "string" ? { cliType: value } : value;
}

function resolveSnapshotCarrierState(
  state: NonNullable<FleetCarriers["carriers"]>[string],
  defaults?: CarrierModelDefaults,
): ResolvedCarrierState {
  const agentCliType = sanitizeAgentCliType(state.agentCliType) ?? defaults?.cliType ?? "claude";
  const agentCli = sanitizeAgentCli(state.agentCli);
  return {
    agentMode: state.agentMode ?? defaults?.defaultAgentMode ?? "cli",
    agentCliType,
    agentCli: {
      ...agentCli,
      [agentCliType]: resolveSelectionForCliType(agentCli[agentCliType], agentCliType, defaults),
    },
    taskforce: sanitizeTaskforce(state.taskforce),
    ...(state.displayName ? { displayName: state.displayName } : {}),
  };
}

function resolveSelectionForCliType(
  stored: AgentCliSelection | undefined,
  cliType: CliType,
  defaults?: CarrierModelDefaults,
): AgentCliSelection {
  const provider = getProviderModels(cliType);
  const allowedModels = new Set(provider.models.map((model) => model.modelId));
  const defaultModelIsValid = !!defaults?.defaultModel && allowedModels.has(defaults.defaultModel);
  const storedModelIsValid = !!stored?.model && allowedModels.has(stored.model);
  const model = storedModelIsValid
    ? stored!.model
    : defaultModelIsValid
      ? defaults!.defaultModel!
      : provider.defaultModel;
  const modelEffort = getEffort(cliType, model);
  if (!modelEffort.supported) return { model };
  const effort = storedModelIsValid && stored?.effort && modelEffort.levels.includes(stored.effort)
    ? stored.effort
    : defaults?.defaultEffort && modelEffort.levels.includes(defaults.defaultEffort)
      ? defaults.defaultEffort
      : modelEffort.default;
  return { model, effort };
}

function buildTempPath(filePath: string): string {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  return `${filePath}.${suffix}.tmp`;
}

function unlinkStaleSubagentModeFile(dir: string): void {
  try {
    fs.unlinkSync(path.join(dir, STALE_SUBAGENT_MODE_FILENAME));
  } catch {
    // 미출시 파일 잔여물 정리만 시도합니다.
  }
}

/**
 * fleet/carrier/framework.ts — Carrier 프레임워크
 *
 * 외부 확장(feature, experimentals 등)이 커스텀 Carrier를
 * 등록하는 데 사용하는 공개 SDK입니다.
 *
 * 프레임워크가 자동 관리하는 것:
 *  - Carrier 상태 관리
 *  - 등록 순서/메타데이터 보관
 *  - slot 기반 등록 순서 관리
 */

import { getEffort, type CliType } from "@dotobokuri/fleet-unified-agent";
import { CLI_DISPLAY_NAMES } from "../constants.js";
import {
  loadCarrierDisplayNameOverrides,
  resolveAgentCliType as resolveAgentCliTypeFromStore,
  sanitizeCarrierDisplayName,
} from "../store/index.js";

import type {
  CarrierConfig,
  CarrierFrameworkState,
  CarrierJobStatus,
  CarrierJobStreamEvent,
  CarrierJobStreamHandler,
  ModelEffort,
  TrackStatus,
} from "./types.js";
import {
  CARRIER_ID_FORMAT_REGEX,
  RESERVED_CARRIER_IDS,
} from "./types.js";

// 공개 타입 re-export — consumer가 fleet/index.ts를 통해 접근
export type { CarrierConfig };

// ─── 상수 ─────────────────────────────────────────────────

// ─── 공개 API ────────────────────────────────────────────

export class CarrierRegistry {
  private readonly state: CarrierFrameworkState = {
    modes: new Map(),
    registeredOrder: [],
    statusUpdateCallbacks: [],
    streamHandlers: new Set(),
    taskforceConfiguredCarriers: new Set(),
  };

  getState(): CarrierFrameworkState {
    return this.state;
  }

  clear(): void {
    this.state.modes.clear();
    this.state.registeredOrder.splice(0);
    this.state.statusUpdateCallbacks.splice(0);
    this.state.streamHandlers.clear();
    this.state.taskforceConfiguredCarriers.clear();
  }
}

export function createCarrierRegistry(): CarrierRegistry {
  return new CarrierRegistry();
}

/**
 * 커스텀 Carrier를 등록합니다.
 *
 * 프레임워크가 자동으로:
 *  - 에이전트 패널 칼럼 등록
 *  - 메시지 렌더러 등록
 */
export function registerCarrier(
  registry: CarrierRegistry,
  config: CarrierConfig,
): void {
  // carrier ID 형식 및 예약어 검증 (상태 변경 전 fail-fast)
  if (!CARRIER_ID_FORMAT_REGEX.test(config.id)) {
    throw new Error(
      `Invalid carrier ID "${config.id}": must match ${CARRIER_ID_FORMAT_REGEX.source}`,
    );
  }
  if (RESERVED_CARRIER_IDS.has(config.id)) {
    throw new Error(
      `Reserved carrier ID "${config.id}" is not allowed.`,
    );
  }

  const gs = registry.getState();
  const existingState = gs.modes.get(config.id);

  // Carrier 상태 등록
  if (existingState) {
    const existing = existingState.config;
    existing.displayName = config.displayName;
    existing.slot = config.slot;
    existing.defaultCliType = config.defaultCliType;
    existing.defaultModel = config.defaultModel;
    existing.defaultEffort = config.defaultEffort;
    existing.carrierMetadata = config.carrierMetadata;
    existing.subagent = config.subagent;
  } else {
    gs.modes.set(config.id, { config });
  }

  // registeredOrder에 slot 순으로 삽입 (resume 시 중복 방지: 기존 항목 먼저 제거)
  const existingIdx = gs.registeredOrder.indexOf(config.id);
  if (existingIdx !== -1) gs.registeredOrder.splice(existingIdx, 1);

  const idx = gs.registeredOrder.findIndex((existingId) => {
    const existing = gs.modes.get(existingId);
    return existing != null && existing.config.slot > config.slot;
  });
  if (idx === -1) {
    gs.registeredOrder.push(config.id);
  } else {
    gs.registeredOrder.splice(idx, 0, config.id);
  }

}

/**
 * 상태바 갱신 콜백을 등록합니다.
 */
export function onStatusUpdate(registry: CarrierRegistry, callback: () => void): void {
  const gs = registry.getState();
  gs.statusUpdateCallbacks.push(callback);
}

/**
 * 등록된 모든 상태바 갱신 콜백을 호출합니다.
 */
export function notifyStatusUpdate(registry: CarrierRegistry): void {
  const gs = registry.getState();
  for (const cb of gs.statusUpdateCallbacks) {
    try { cb(); } catch { /* 무시 */ }
  }
}

/**
 * Carrier job stream 이벤트 핸들러를 등록합니다.
 */
export function registerStreamHandler(registry: CarrierRegistry, handler: CarrierJobStreamHandler): () => void {
  const gs = registry.getState();
  gs.streamHandlers.add(handler);
  return () => {
    unregisterStreamHandler(registry, handler);
  };
}

/**
 * Carrier job stream 이벤트 핸들러를 해제합니다.
 */
export function unregisterStreamHandler(registry: CarrierRegistry, handler: CarrierJobStreamHandler): void {
  registry.getState().streamHandlers.delete(handler);
}

/**
 * 등록된 모든 Carrier job stream 이벤트 핸들러를 호출합니다.
 */
export function emitStreamEvent(registry: CarrierRegistry, event: CarrierJobStreamEvent): void {
  for (const handler of registry.getState().streamHandlers) {
    handler(event);
  }
}

/**
 * slot 순으로 정렬된 carrierId 배열을 반환합니다.
 */
export function getRegisteredOrder(registry: CarrierRegistry): string[] {
  return [...registry.getState().registeredOrder];
}

// ─── Task Force 설정 변경 관리 ──────────────────────────

/**
 * Task Force 설정이 완료된 carrier ID 목록을 반환합니다.
 */
export function getTaskForceConfiguredIds(registry: CarrierRegistry): string[] {
  return [...registry.getState().taskforceConfiguredCarriers];
}

/** Task Force 설정 carrier ID 목록을 registeredOrder 순서로 반환합니다. */
export function getActiveTaskForceIds(registry: CarrierRegistry): string[] {
  const gs = registry.getState();
  return gs.registeredOrder.filter(
    (id) => gs.taskforceConfiguredCarriers.has(id),
  );
}

/**
 * Task Force 설정 완료 carrier ID 목록을 일괄 설정합니다.
 */
export function setTaskForceConfiguredCarriers(registry: CarrierRegistry, ids: string[]): void {
  const gs = registry.getState();
  gs.taskforceConfiguredCarriers = new Set(ids);
}

/**
 * 지정 carrier의 cliType을 동적으로 변경합니다.
 * carrier CLI 타입 변경을 알리고 상태바를 업데이트합니다.
 */
export function updateCarrierCliType(registry: CarrierRegistry, carrierId: string, newType: CliType): void {
  const gs = registry.getState();
  const state = gs.modes.get(carrierId);
  if (!state) return;
  void newType;
  notifyStatusUpdate(registry);
}

/**
 * carrierId에 해당하는 CarrierConfig를 반환합니다.
 */
export function getRegisteredCarrierConfig(registry: CarrierRegistry, carrierId: string): CarrierConfig | undefined {
  return registry.getState().modes.get(carrierId)?.config;
}

export const getCarrierConfig = getRegisteredCarrierConfig;

export function resolveAgentCliType(carrierId: string, defaultCliType: CliType): CliType {
  return resolveAgentCliTypeFromStore(carrierId, defaultCliType);
}

/**
 * 등록된 전체 carrierId를 순회하여 cliType Set으로 수집하고,
 * 중복 제거 후 배열로 반환합니다.
 */
export function getAllCliTypes(registry: CarrierRegistry): CliType[] {
  const gs = registry.getState();
  const types = new Set<string>();
  for (const id of gs.registeredOrder) {
    const config = gs.modes.get(id)?.config;
    const cliType = config ? resolveAgentCliTypeFromStore(id, config.defaultCliType) : undefined;
    if (cliType) types.add(cliType);
  }
  return [...types] as CliType[];
}

/** carrierId 기준으로 carrier 표시 이름을 반환합니다. */
export function resolveCarrierDisplayName(registry: CarrierRegistry, carrierId: string): string {
  const persistedDisplayName = loadCarrierDisplayNameOverrides()[carrierId];
  if (persistedDisplayName) return persistedDisplayName;
  return getCarrierSourceDisplayName(registry, carrierId);
}

/** carrierId 기준으로 persisted override를 제외한 source-default 표시 이름을 반환합니다. */
export function getCarrierSourceDisplayName(registry: CarrierRegistry, carrierId: string): string {
  const carrierConfig = getRegisteredCarrierConfig(registry, carrierId);
  return sanitizeCarrierDisplayName(carrierConfig?.displayName)
    ?? sanitizeCarrierDisplayName(CLI_DISPLAY_NAMES[carrierId])
    ?? sanitizeCarrierDisplayName(carrierId)
    ?? carrierId;
}

/** carrierId 기준으로 실제 CLI 표시 이름을 반환합니다. */
export function resolveCarrierCliDisplayName(registry: CarrierRegistry, carrierId: string): string {
  const config = getRegisteredCarrierConfig(registry, carrierId);
  const cliType = config ? resolveAgentCliTypeFromStore(carrierId, config.defaultCliType) : carrierId;
  return CLI_DISPLAY_NAMES[cliType] ?? cliType;
}

// ─── 내부 헬퍼 ───────────────────────────────────────────

/**
 * 등록된 모든 캐리어 상태를 초기화합니다 (테스트용).
 */
export function clearRegisteredCarriers(registry: CarrierRegistry): void {
  registry.clear();
}

export function resetCarrierRegistryForTests(registry: CarrierRegistry): void {
  clearRegisteredCarriers(registry);
}

export function resolveValidatedEffort(
  cliType: CliType,
  modelId: string | undefined,
  effort: string | undefined,
): string | undefined {
  if (!modelId || !effort) return undefined;
  const modelEffort = getModelEffort(cliType, modelId);
  if (!modelEffort?.levels?.includes(effort)) return undefined;
  return effort;
}

export function toCarrierJobStatus(status: TrackStatus): CarrierJobStatus {
  if (status === "done") return "done";
  if (status === "aborted") return "aborted";
  return "error";
}

export function toTrackFinalStatus(status: CarrierJobStatus): TrackStatus {
  if (status === "done") return "done";
  if (status === "aborted") return "aborted";
  return "err";
}


function getModelEffort(
  cliType: CliType,
  modelId: string,
): ModelEffort | null {
  return normalizeEffort(getEffort(cliType, modelId));
}

function normalizeEffort(
  effort: ModelEffort,
): ModelEffort | null {
  if (!effort.supported) return null;
  const levels = effort.levels ?? [];
  if (levels.length === 0) return null;
  return {
    supported: true,
    levels,
    default: effort.default && levels.includes(effort.default) ? effort.default : levels[0],
  };
}

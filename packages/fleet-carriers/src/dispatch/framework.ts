/**
 * dispatch/framework.ts — Carrier 프레임워크
 *
 * 외부 확장(feature, experimentals 등)이 커스텀 Carrier를
 * 등록하는 데 사용하는 공개 SDK입니다.
 *
 * 프레임워크가 자동 관리하는 것:
 *  - Carrier 상태 관리
 *  - 등록 순서/메타데이터 보관
 *  - slot 기반 등록 순서 관리
 */

import { getEffort, type CliType } from "@dotobokuri/core-unified-agent";
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
  };

  getState(): CarrierFrameworkState {
    return this.state;
  }

  clear(): void {
    this.state.modes.clear();
    this.state.registeredOrder.splice(0);
    this.state.statusUpdateCallbacks.splice(0);
    this.state.streamHandlers.clear();
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
  // Re-registration replaces the source-owned config wholesale. In particular,
  // an omitted readonly capability marker must clear an earlier opt-in.
  gs.modes.set(config.id, { config });

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

/**
 * carrier CLI 타입 변경을 상태바에 알립니다.
 *
 * 알림 전용 — 실제 CLI 타입 변경(영속)은 store(updateAgentCliTypeOverride /
 * applyAgentCliTypeSelectionUpdate)가 소유한다. newType 인자는 변경을 적용하지 않는다.
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

/** @deprecated 신규 코드는 getRegisteredCarrierConfig를 사용한다 — 기존 소비처 호환을 위한 별칭. */
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

/** effort 메타데이터를 정규화합니다 — 미지원이거나 level이 없으면 null. */
export function normalizeEffort(
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

function getModelEffort(
  cliType: CliType,
  modelId: string,
): ModelEffort | null {
  return normalizeEffort(getEffort(cliType, modelId));
}

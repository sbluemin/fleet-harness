/**
 * fleet/carrier/framework.ts — Carrier 프레임워크
 *
 * 외부 확장(feature, experimentals 등)이 커스텀 Carrier를
 * 등록하는 데 사용하는 공개 SDK입니다.
 *
 * 프레임워크가 자동 관리하는 것:
 *  - Carrier 상태 관리
 *  - 등록 순서/메타데이터 보관
 *  - 렌더러 등록 (커스텀 or 기본)
 */

import type { CliType } from "@sbluemin/fleet-unified-agent";
import {
  CARRIER_BG_COLORS,
  CARRIER_COLORS,
  CARRIER_RGBS,
  CLI_DISPLAY_NAMES,
  CLI_TYPE_DISPLAY_ORDER,
} from "../constants.js";
import { loadCarrierDisplayNames, resolveCarrierCliType as resolveCarrierCliTypeFromStore } from "../store/index.js";

import type {
  CarrierConfig,
  CarrierFrameworkState,
} from "./types.js";
import {
  CARRIER_ID_FORMAT_REGEX,
  RESERVED_CARRIER_IDS,
} from "./types.js";

// 공개 타입 re-export — consumer가 fleet/index.ts를 통해 접근
export type { CarrierConfig };

// ─── 상수 ─────────────────────────────────────────────────

const DEFAULT_CARRIER_RGB: [number, number, number] = [180, 160, 220];

// ─── 공개 API ────────────────────────────────────────────

export class CarrierRegistry {
  private readonly state: CarrierFrameworkState = {
    modes: new Map(),
    registeredOrder: [],
    statusUpdateCallbacks: [],
    taskforceConfiguredCarriers: new Set(),
  };

  getState(): CarrierFrameworkState {
    return this.state;
  }

  clear(): void {
    this.state.modes.clear();
    this.state.registeredOrder.splice(0);
    this.state.statusUpdateCallbacks.splice(0);
    this.state.taskforceConfiguredCarriers.clear();
  }
}

export const defaultRegistry = new CarrierRegistry();

/**
 * 커스텀 Carrier를 등록합니다.
 *
 * 프레임워크가 자동으로:
 *  - 에이전트 패널 칼럼 등록
 *  - 메시지 렌더러 등록
 */
export function registerCarrier(
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

  const gs = getState();
  const existingState = gs.modes.get(config.id);
  const resolvedCliType = resolveCarrierCliTypeFromStore(config.id, config.defaultCliType);

  // Carrier 상태 등록
  if (existingState) {
    const existing = existingState.config;
    existing.displayName = config.displayName;
    existing.slot = config.slot;
    existing.defaultCliType = config.defaultCliType;
    existing.renderResponse = config.renderResponse;
    existing.renderUser = config.renderUser;
    existing.carrierMetadata = config.carrierMetadata;
    existing.defaultModel = config.defaultModel;
    existing.defaultEffort = config.defaultEffort;
    existing.color = config.color;
    existing.bgColor = config.bgColor;
    existing.color = CARRIER_COLORS[resolvedCliType] ?? "";
    existing.bgColor = CARRIER_BG_COLORS[resolvedCliType];
  } else {
    config.color = CARRIER_COLORS[resolvedCliType] ?? "";
    config.bgColor = CARRIER_BG_COLORS[resolvedCliType];
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
export function onStatusUpdate(callback: () => void): void {
  const gs = getState();
  gs.statusUpdateCallbacks.push(callback);
}

/**
 * 등록된 모든 상태바 갱신 콜백을 호출합니다.
 */
export function notifyStatusUpdate(): void {
  const gs = getState();
  for (const cb of gs.statusUpdateCallbacks) {
    try { cb(); } catch { /* 무시 */ }
  }
}

/**
 * slot 순으로 정렬된 carrierId 배열을 반환합니다.
 */
export function getRegisteredOrder(): string[] {
  return [...getState().registeredOrder];
}

// ─── Task Force 설정 변경 관리 ──────────────────────────

/**
 * Task Force 설정이 완료된 carrier ID 목록을 반환합니다.
 */
export function getTaskForceConfiguredIds(): string[] {
  return [...getState().taskforceConfiguredCarriers];
}

/** Task Force 설정 carrier ID 목록을 registeredOrder 순서로 반환합니다. */
export function getActiveTaskForceIds(): string[] {
  const gs = getState();
  return gs.registeredOrder.filter(
    (id) => gs.taskforceConfiguredCarriers.has(id),
  );
}

/**
 * Task Force 설정 완료 carrier ID 목록을 일괄 설정합니다.
 */
export function setTaskForceConfiguredCarriers(ids: string[]): void {
  const gs = getState();
  gs.taskforceConfiguredCarriers = new Set(ids);
}

/**
 * 지정 carrier의 cliType을 동적으로 변경합니다.
 * 색상·배경색을 새 cliType에 맞게 갱신하고 정렬 + 상태바를 업데이트합니다.
 */
export function updateCarrierCliType(carrierId: string, newType: CliType): void {
  const gs = getState();
  const state = gs.modes.get(carrierId);
  if (!state) return;
  const config = state.config;
  config.color = CARRIER_COLORS[newType] ?? "";
  config.bgColor = CARRIER_BG_COLORS[newType];
  reorderRegisteredByCliType();
  notifyStatusUpdate();
}

/** registeredOrder를 SSoT 기반 CliType 우선순위로 재정렬합니다. */
export function reorderRegisteredByCliType(): void {
  const gs = getState();
  gs.registeredOrder.sort((a, b) => {
    const configA = gs.modes.get(a)?.config;
    const configB = gs.modes.get(b)?.config;
    const typeA = configA ? resolveCarrierCliTypeFromStore(a, configA.defaultCliType) : undefined;
    const typeB = configB ? resolveCarrierCliTypeFromStore(b, configB.defaultCliType) : undefined;
    const orderA = typeA ? CLI_TYPE_DISPLAY_ORDER[typeA] : 99;
    const orderB = typeB ? CLI_TYPE_DISPLAY_ORDER[typeB] : 99;
    if (orderA !== orderB) return orderA - orderB;
    // 같은 CliType 내에서는 slot 순 유지
    return (configA?.slot ?? 99) - (configB?.slot ?? 99);
  });
}

/**
 * carrierId에 해당하는 CarrierConfig를 반환합니다.
 */
export function getRegisteredCarrierConfig(carrierId: string): CarrierConfig | undefined {
  return getState().modes.get(carrierId)?.config;
}

export function resolveCarrierCliType(carrierId: string, defaultCliType: CliType): CliType {
  return resolveCarrierCliTypeFromStore(carrierId, defaultCliType);
}

/**
 * 등록된 전체 carrierId를 순회하여 cliType Set으로 수집하고,
 * 중복 제거 후 배열로 반환합니다.
 */
export function getAllCliTypes(): CliType[] {
  const gs = getState();
  const types = new Set<string>();
  for (const id of gs.registeredOrder) {
    const config = gs.modes.get(id)?.config;
    const cliType = config ? resolveCarrierCliTypeFromStore(id, config.defaultCliType) : undefined;
    if (cliType) types.add(cliType);
  }
  return [...types] as CliType[];
}

/** carrierId 기준으로 전경(프레임) 색상을 반환합니다. */
export function resolveCarrierColor(carrierId: string): string {
  const config = getRegisteredCarrierConfig(carrierId);
  const cliType = config ? resolveCarrierCliTypeFromStore(carrierId, config.defaultCliType) : carrierId;
  return CARRIER_COLORS[cliType] ?? "";
}

/** carrierId 기준으로 배경색을 반환합니다. */
export function resolveCarrierBgColor(carrierId: string): string {
  const config = getRegisteredCarrierConfig(carrierId);
  const cliType = config ? resolveCarrierCliTypeFromStore(carrierId, config.defaultCliType) : carrierId;
  return CARRIER_BG_COLORS[cliType] ?? "";
}

/** carrierId 기준으로 파도 그라데이션용 RGB를 반환합니다. */
export function resolveCarrierRgb(carrierId: string): [number, number, number] {
  const config = getRegisteredCarrierConfig(carrierId);
  const cliType = config ? resolveCarrierCliTypeFromStore(carrierId, config.defaultCliType) : carrierId;
  return CARRIER_RGBS[cliType] ?? DEFAULT_CARRIER_RGB;
}

/** carrierId 기준으로 carrier 표시 이름을 반환합니다. */
export function resolveCarrierDisplayName(carrierId: string): string {
  const persistedDisplayName = loadCarrierDisplayNames()[carrierId];
  if (persistedDisplayName) return persistedDisplayName;
  return getCarrierSourceDisplayName(carrierId);
}

/** carrierId 기준으로 persisted override를 제외한 source-default 표시 이름을 반환합니다. */
export function getCarrierSourceDisplayName(carrierId: string): string {
  const carrierConfig = getRegisteredCarrierConfig(carrierId);
  return carrierConfig?.displayName
    ?? CLI_DISPLAY_NAMES[carrierId]
    ?? carrierId;
}

/** carrierId 기준으로 실제 CLI 표시 이름을 반환합니다. */
export function resolveCarrierCliDisplayName(carrierId: string): string {
  const config = getRegisteredCarrierConfig(carrierId);
  const cliType = config ? resolveCarrierCliTypeFromStore(carrierId, config.defaultCliType) : carrierId;
  return CLI_DISPLAY_NAMES[cliType] ?? cliType;
}

// ─── 내부 헬퍼 ───────────────────────────────────────────

/**
 * 등록된 모든 캐리어 상태를 초기화합니다 (테스트용).
 */
export function clearRegisteredCarriers(): void {
  defaultRegistry.clear();
}

export function resetCarrierRegistryForTests(): void {
  clearRegisteredCarriers();
}

/** module singleton 기반 공유 상태를 반환합니다. */
function getState(): CarrierFrameworkState {
  return defaultRegistry.getState();
}

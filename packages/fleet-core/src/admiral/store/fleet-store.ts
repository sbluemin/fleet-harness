/**
 * fleet/shipyard/store.ts — Fleet 통합 영속 스토어
 *
 * 모든 fleet 영속 상태를 `states.json` 단일 파일로 일원화합니다.
 * - 모델 선택 (기존 model-config.ts)
 * - Offline carrier 상태 (기존 sortie-store.ts)
 * - cliType 오버라이드 (기존 sortie-store.ts)
 *
 * 단일 게이트 I/O 패턴으로 race condition을 방지합니다.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CLI_BACKENDS,
  getEffort,
  getProviderModels,
  type CliType,
} from "@sbluemin/fleet-unified-agent";
import { CLI_DISPLAY_NAMES } from "../../constants.js";
import { disconnect } from "../agent/connections.js";
import { flushSessionMappings, getCarrierSessionStore } from "../agent/internal/session-runtime.js";
import { TASKFORCE_CLI_TYPES, type TaskForceCliType } from "../taskforce/types.js";

// ─── 타입 정의 ──────────────────────────────────────────

/** CLI별 설정 캐시 (CLI 변경 시 이전 설정 복원용) */
type PerCliSettings = {
  model?: string;
  effort?: string;
  direct?: boolean;
};

/** 각 carrier별 모델 선택 설정 */
export interface ModelSelection {
  /** 선택된 모델 ID */
  model: string;
  /** Direct 모드 사용 여부 (codex 전용, ACP 우회) */
  direct?: boolean;
  /** Reasoning effort (codex, claude — SDK의 effort.levels 기반) */
  effort?: string;
  /** Task Force 백엔드별 커스텀 설정 (cliType → 모델 선택) */
  taskforce?: TaskForceConfig;
  /** CLI 변경 시 이전 설정 복원을 위한 CLI별 설정 캐시 */
  perCliSettings?: Partial<Record<string, PerCliSettings>>;
}

/** states.json의 models 키 전체 구조 */
export type SelectedModelsConfig = Record<string, ModelSelection>;

type TaskForceSelection = Omit<ModelSelection, "taskforce">;
type TaskForceConfig = Partial<Record<TaskForceCliType, TaskForceSelection>>;

/** states.json 통합 스키마 */
interface FleetStates {
  /** 모델 선택 설정 */
  models?: SelectedModelsConfig;
  /** offline carrier ID 목록 */
  offline?: string[];
  /** squadron 활성화된 carrier ID 목록 */
  squadronEnabled?: string[];
  /** carrier별 cliType 오버라이드 (defaultCliType과 다를 때만 저장) */
  cliTypeOverrides?: Record<string, string>;
  /** carrier별 사용자 지정 표시 이름 오버라이드 */
  carrierDisplayNames?: Record<string, string>;
}

interface StoreLockOwner {
  pid: number;
  hostname: string;
  startedAt: number;
}

// ─── 상수 ──────────────────────────────────────────────

/** 통합 영속화 파일명 */
const FILENAME = "states.json";

const LOCK_DIRNAME = "states.json.lock";

const LOCK_OWNER_FILENAME = "owner.json";

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const DISPLAY_NAME_BIDI_CONTROL_PATTERN = /[\u202A-\u202E\u2066-\u2069]/g;
const DISPLAY_NAME_ZERO_WIDTH_PATTERN = /[\u200B-\u200D\uFEFF]/g;
const DISPLAY_NAME_MAX_LENGTH = 50;

const LOCK_RETRY_MS = 25;

const LOCK_TIMEOUT_MS = 5000;

const STALE_LOCK_MS = 30000;

/** 유효한 cliType 값 집합 */
const VALID_CLI_TYPES = new Set(Object.keys(CLI_BACKENDS));

// ─── 내부 상태 ─────────────────────────────────────────

/** 스토어 데이터 디렉토리 */
let storeDir: string | null = null;

// ─── 초기화 ─────────────────────────────────────────────

/**
 * Fleet 통합 스토어를 초기화합니다.
 * index.ts에서 initRuntime() 직후 1회 호출합니다.
 */
export function initStore(dir: string): void {
  storeDir = dir;
  fs.mkdirSync(dir, { recursive: true });
}

// ─── 모델 설정 영속화 ──────────────────────────────────

/** 현재 모델 설정을 로드합니다. */
export function loadModels(): SelectedModelsConfig {
  const states = readStates();
  return sanitizeSelectedModelsConfig(states.models) ?? {};
}

/** 모델 설정을 저장합니다. */
export function saveModels(config: SelectedModelsConfig): void {
  updateStates((states) => {
    states.models = sanitizeSelectedModelsConfig(config);
  });
}

/**
 * states.json에 모델 엔트리가 없는 캐리어에 대해 defaultModel로 초기 시딩합니다.
 * 세션 무효화는 수행하지 않습니다 (부팅 시 1회만 실행).
 *
 * @returns 실제로 states.json이 갱신되었는지 여부
 */
export function seedDefaultModels(
  defaultsByCarrier: Record<string, { cliType: CliType; defaultModel?: string; defaultEffort?: string }>,
): boolean {
  const entries = Object.entries(defaultsByCarrier);
  if (entries.length === 0) return false;

  let changed = false;
  updateStates((states) => {
    const models = sanitizeSelectedModelsConfig(states.models);

    for (const [carrierId, { cliType, defaultModel, defaultEffort }] of entries) {
      const existing = models[carrierId];
      if (existing && existing.model) continue;
      const model = defaultModel ?? getProviderModels(cliType)?.defaultModel;
      if (!model) continue;
      const next: ModelSelection = { ...existing, model };
      if (defaultEffort && !existing?.effort) next.effort = defaultEffort;
      models[carrierId] = next;
      changed = true;
    }

    if (changed) states.models = models;
  });
  return changed;
}

/**
 * Carrier의 모델 설정을 변경하고 세션을 무효화합니다.
 * 원자적 연산: save → session clear → disconnect
 * clear 먼저: executor가 stale sessionId로 resume 시도하는 창 제거
 */
export async function updateModelSelection(
  carrierId: string,
  selection: ModelSelection,
): Promise<void> {
  updateStates((states) => {
    const existing = states.models?.[carrierId];
    const merged: ModelSelection = {
      ...selection,
      taskforce: selection.taskforce ?? existing?.taskforce,
      perCliSettings: selection.perCliSettings ?? existing?.perCliSettings,
    };
    states.models = { ...states.models, [carrierId]: merged };
  });
  getCarrierSessionStore().clear(carrierId);
  flushSessionMappings();
  await disconnect(carrierId);
}

/**
 * 전체 모델 설정을 교체하고 변경된 키의 세션을 무효화합니다.
 * 원자적 연산: save → session clear all → disconnect all
 */
export async function updateAllModelSelections(
  config: SelectedModelsConfig,
): Promise<void> {
  saveModels(config);
  const keys = Object.keys(config);
  const sessionStore = getCarrierSessionStore();
  for (const key of keys) {
    sessionStore.clear(key);
  }
  flushSessionMappings();
  await Promise.allSettled(keys.map((key) => disconnect(key)));
}

/**
 * 현재 carrier별 cliType에 맞춰 활성 모델 선택을 재정렬합니다.
 *
 * /reload 후 carrier의 cliType이 복원되어도 top-level models 엔트리가
 * 이전 CLI 기준 값으로 남아 있을 수 있으므로, 현재 cliType 기준 유효한
 * model/effort/budget/direct 조합으로 정규화합니다.
 *
 * - 현재 top-level 선택이 새 cliType에 유효하면 그대로 유지
 * - 아니면 perCliSettings[cliType]를 사용
 * - 그것도 없으면 provider 기본값으로 폴백
 *
 * taskforce/perCliSettings는 보존하며 세션 무효화는 수행하지 않습니다.
 *
 * @returns 실제로 states.json이 갱신되었는지 여부
 */
export function reconcileActiveModelSelections(
  cliTypesByCarrier: Record<string, CliType>,
): boolean {
  if (Object.keys(cliTypesByCarrier).length === 0) return false;

  let changed = false;
  updateStates((states) => {
    const models = sanitizeSelectedModelsConfig(states.models);

    for (const [carrierId, cliType] of Object.entries(cliTypesByCarrier)) {
      const current = models[carrierId];
      if (!current) continue;

      const resolved = resolveSelectionForCliType(current, cliType);
      if (!resolved) continue;

      if (!isSameResolvedSelection(current, resolved)) {
        const next: ModelSelection = { model: resolved.model };
        if (resolved.direct !== undefined) next.direct = resolved.direct;
        if (resolved.effort !== undefined) next.effort = resolved.effort;
        if (current.taskforce) next.taskforce = current.taskforce;
        if (current.perCliSettings) next.perCliSettings = current.perCliSettings;
        models[carrierId] = next;
        changed = true;
      }
    }

    if (changed) states.models = models;
  });
  return changed;
}

// ─── CLI별 설정 캐시 ────────────────────────────────────

/**
 * CLI별 설정 캐시에서 특정 CLI 타입의 설정을 반환합니다.
 */
export function getPerCliSettings(
  carrierId: string,
  cliType: string,
): PerCliSettings | undefined {
  const config = loadModels();
  const perCli = config[carrierId]?.perCliSettings;
  if (!perCli) return undefined;
  return sanitizePerCliSettings(perCli[cliType]);
}

/**
 * 현재 설정을 CLI별 설정 캐시에 저장합니다.
 * 원자적: read → merge → write (세션 무효화 없음)
 */
export function savePerCliSettings(
  carrierId: string,
  cliType: string,
  settings: PerCliSettings,
): void {
  // 모든 필드가 undefined면 저장 스킵
  if (
    settings.model === undefined &&
    settings.effort === undefined &&
    settings.direct === undefined
  ) {
    return;
  }

  const sanitizedKey = sanitizeConfigKey(cliType);
  if (!sanitizedKey) return;

  updateStates((states) => {
    if (!states.models) states.models = {};
    if (!states.models[carrierId]) states.models[carrierId] = { model: "" };

    const carrier = states.models[carrierId]!;
    if (!carrier.perCliSettings) carrier.perCliSettings = {};
    carrier.perCliSettings[sanitizedKey] = {
      model: settings.model,
      effort: settings.effort,
      direct: settings.direct,
    };
  });
}

// ─── Task Force 모델 설정 ───────────────────────────────

/**
 * Task Force 백엔드별 모델 설정을 반환합니다.
 * 명시적 설정이 없으면 undefined를 반환합니다 (auto 폴백 없음).
 */
export function getTaskForceModelConfig(
  carrierId: string,
  cliType: string,
): TaskForceSelection | undefined {
  const resolvedCliType = toTaskForceCliType(cliType);
  const config = loadModels();
  const taskforceConfig = getSanitizedTaskForceConfig(config, carrierId);
  return taskforceConfig?.[resolvedCliType];
}

/**
 * Task Force 백엔드별 모델 설정을 저장합니다.
 */
export function updateTaskForceModelSelection(
  carrierId: string,
  cliType: string,
  selection: TaskForceSelection,
): void {
  const resolvedCliType = toTaskForceCliType(cliType);
  const sanitizedSelection = sanitizeTaskForceSelection(resolvedCliType, selection);
  if (!sanitizedSelection) {
    throw new Error(`Invalid Task Force model selection for ${resolvedCliType}.`);
  }

  updateStates((states) => {
    const models = sanitizeSelectedModelsConfig(states.models);
    ensureTaskForceConfig(models, carrierId)[resolvedCliType] = sanitizedSelection;
    states.models = models;
  });
}

/**
 * Task Force 백엔드별 모델 설정을 초기화합니다 (origin으로 되돌림).
 */
export function resetTaskForceModelSelection(
  carrierId: string,
  cliType: string,
): void {
  const resolvedCliType = toTaskForceCliType(cliType);
  updateStates((states) => {
    const models = sanitizeSelectedModelsConfig(states.models);
    const carrierConfig = models[carrierId];
    if (!carrierConfig?.taskforce) return;

    delete carrierConfig.taskforce[resolvedCliType];
    pruneEmptyTaskForceConfig(carrierConfig);
    states.models = models;
  });
}

/**
 * 지정 캐리어에 대해 Task Force 실행 가능한 백엔드 목록을 반환합니다.
 */
export function getConfiguredTaskForceBackends(carrierId: string): TaskForceCliType[] {
  return getConfiguredTaskForceBackendsInConfig(loadModels(), carrierId);
}

/**
 * 등록된 전체 캐리어 중 Task Force 편성이 가능한 캐리어 ID 목록을 반환합니다.
 */
export function getConfiguredTaskForceCarrierIds(registeredIds: string[]): string[] {
  const config = loadModels();
  return registeredIds.filter((id) => isTaskForceFormableInConfig(config, id));
}

// ─── Offline 상태 ───────────────────────────────────────

/**
 * 디스크에서 offline carrier ID 목록을 로드합니다.
 * 유효한 carrier ID만 필터링하여 반환합니다.
 */
export function loadOfflineCarriers(validIds?: Set<string>): string[] {
  const states = readStates();
  const ids = states.offline;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string =>
    typeof id === "string" && (!validIds || validIds.has(id)),
  );
}

/**
 * offline carrier ID 목록을 디스크에 저장합니다.
 */
export function saveOfflineCarriers(ids: string[]): void {
  updateStates((states) => {
    states.offline = ids;
  });
}

// ─── Squadron 상태 ──────────────────────────────────────

/**
 * 디스크에서 squadron 활성화된 carrier ID 목록을 로드합니다.
 * 유효한 carrier ID만 필터링하여 반환합니다.
 */
export function loadSquadronEnabled(validIds?: Set<string>): string[] {
  const states = readStates();
  const ids = states.squadronEnabled;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string =>
    typeof id === "string" && (!validIds || validIds.has(id)),
  );
}

/**
 * squadron 활성화 carrier ID 목록을 디스크에 저장합니다.
 */
export function saveSquadronEnabled(ids: string[]): void {
  updateStates((states) => {
    states.squadronEnabled = ids;
  });
}

// ─── cliType 오버라이드 ─────────────────────────────────

/**
 * 디스크에서 cliType 오버라이드 맵을 로드합니다.
 * 유효한 carrier ID와 cliType 값만 필터링하여 반환합니다.
 */
export function loadCliTypeOverrides(validIds?: Set<string>): Record<string, string> {
  const states = readStates();
  const overrides = sanitizeCliTypeOverrides(states.cliTypeOverrides);
  if (!validIds) return overrides;
  return Object.fromEntries(
    Object.entries(overrides).filter(([id]) => validIds.has(id)),
  );
}

/** 디스크의 carrier별 cliType override를 읽어 현재 등록에 사용할 CLI를 결정합니다. */
export function resolveCarrierCliType(carrierId: string, defaultCliType: CliType): CliType {
  const overrides = sanitizeCliTypeOverrides(readStates().cliTypeOverrides);
  return (overrides[carrierId] as CliType | undefined) ?? defaultCliType;
}

/**
 * 단일 carrier의 cliType 오버라이드를 저장하거나 기본값이면 제거합니다.
 */
export function updateCliTypeOverride(
  carrierId: string,
  cliType: string,
  defaultCliType: string,
): void {
  const sanitizedCarrierId = sanitizeConfigKey(carrierId);
  if (!sanitizedCarrierId) return;
  if (!VALID_CLI_TYPES.has(cliType) || !VALID_CLI_TYPES.has(defaultCliType)) return;

  updateStates((states) => {
    const overrides = sanitizeCliTypeOverrides(states.cliTypeOverrides);
    if (cliType === defaultCliType) {
      delete overrides[sanitizedCarrierId];
    } else {
      overrides[sanitizedCarrierId] = cliType;
    }
    if (Object.keys(overrides).length > 0) {
      states.cliTypeOverrides = overrides;
    } else {
      delete states.cliTypeOverrides;
    }
  });
}

/**
 * 디스크에서 carrier displayName 오버라이드 맵을 로드합니다.
 * 유효한 carrier ID와 displayName 값만 필터링하여 반환합니다.
 */
export function loadCarrierDisplayNames(validIds?: Set<string>): Record<string, string> {
  const states = readStates();
  const displayNames = sanitizeCarrierDisplayNames(states.carrierDisplayNames);
  if (!validIds) return displayNames;
  return Object.fromEntries(
    Object.entries(displayNames).filter(([id]) => validIds.has(id)),
  );
}

/**
 * 단일 carrier의 displayName 오버라이드를 저장하거나 기본값이면 제거합니다.
 */
export function updateCarrierDisplayName(
  carrierId: string,
  displayName: string,
  sourceDefaultDisplayName: string,
): void {
  const sanitizedCarrierId = sanitizeConfigKey(carrierId);
  if (!sanitizedCarrierId) return;

  const sanitizedDisplayName = sanitizeCarrierDisplayName(displayName);
  const sanitizedSourceDefault = sanitizeCarrierDisplayName(sourceDefaultDisplayName)
    ?? CLI_DISPLAY_NAMES[sanitizedCarrierId]
    ?? sanitizedCarrierId;

  updateStates((states) => {
    const displayNames = sanitizeCarrierDisplayNames(states.carrierDisplayNames);
    if (!sanitizedDisplayName || sanitizedDisplayName === sanitizedSourceDefault) {
      delete displayNames[sanitizedCarrierId];
    } else {
      displayNames[sanitizedCarrierId] = sanitizedDisplayName;
    }

    if (Object.keys(displayNames).length > 0) {
      states.carrierDisplayNames = displayNames;
    } else {
      delete states.carrierDisplayNames;
    }
  });
}

// ─── 내부 헬퍼 ──────────────────────────────────────────

function readStates(): FleetStates {
  if (!storeDir) return {};
  const filePath = path.join(storeDir, FILENAME);
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as FleetStates;
  } catch {
    return {};
  }
}

function writeStates(s: FleetStates): void {
  if (!storeDir) throw new Error("Fleet store is not initialized.");
  fs.mkdirSync(storeDir, { recursive: true });
  const filePath = path.join(storeDir, FILENAME);
  const tmpPath = buildTempPath(filePath);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(s, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw error;
  }
}

function updateStates(mutator: (states: FleetStates) => void): void {
  if (!storeDir) return;
  withStoreLock(() => {
    const states = readStates();
    const snapshot = structuredClone(states);
    mutator(states);
    if (JSON.stringify(snapshot) === JSON.stringify(states)) return;
    writeStates(states);
  });
}

function withStoreLock<T>(operation: () => T): T {
  if (!storeDir) return operation();
  fs.mkdirSync(storeDir, { recursive: true });
  const lockDir = path.join(storeDir, LOCK_DIRNAME);
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      writeLockOwner(lockDir);
      try {
        return operation();
      } finally {
        releaseStoreLock(lockDir);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      recoverStaleStoreLock(lockDir);
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for fleet store lock: ${lockDir}`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function releaseStoreLock(lockDir: string): void {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // 다른 프로세스의 stale-lock 복구와 경합할 수 있으므로 해제 실패는 무시합니다.
  }
}

function recoverStaleStoreLock(lockDir: string): void {
  try {
    const owner = readLockOwner(lockDir);
    if (!owner || !isRecoverableLockOwner(owner)) return;
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

function writeLockOwner(lockDir: string): void {
  const owner: StoreLockOwner = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: Date.now(),
  };
  const ownerPath = path.join(lockDir, LOCK_OWNER_FILENAME);
  try {
    fs.writeFileSync(ownerPath, JSON.stringify(owner), "utf-8");
  } catch (error) {
    releaseStoreLock(lockDir);
    throw error;
  }
}

function readLockOwner(lockDir: string): StoreLockOwner | null {
  const ownerPath = path.join(lockDir, LOCK_OWNER_FILENAME);
  try {
    return sanitizeLockOwner(JSON.parse(fs.readFileSync(ownerPath, "utf-8")));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

function isRecoverableLockOwner(owner: StoreLockOwner): boolean {
  if (owner.hostname !== os.hostname()) return false;
  if (Date.now() - owner.startedAt < STALE_LOCK_MS) return false;
  return !isProcessAlive(owner.pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
}

function sanitizeLockOwner(value: unknown): StoreLockOwner | null {
  if (!isRecord(value)) return null;
  const pid = value.pid;
  const hostname = value.hostname;
  const startedAt = value.startedAt;
  if (!Number.isInteger(pid) || (pid as number) <= 0) return null;
  if (typeof hostname !== "string" || !hostname) return null;
  if (!Number.isFinite(startedAt) || (startedAt as number) <= 0) return null;
  return {
    pid: pid as number,
    hostname,
    startedAt: startedAt as number,
  };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function buildTempPath(filePath: string): string {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  return `${filePath}.${suffix}.tmp`;
}

function sanitizeSelectedModelsConfig(raw: unknown): SelectedModelsConfig {
  if (!isRecord(raw)) return {};

  const result: SelectedModelsConfig = {};

  for (const [key, value] of Object.entries(raw)) {
    const sanitizedKey = sanitizeConfigKey(key);
    if (!sanitizedKey) continue;

    if (typeof value === "string") {
      const legacyModel = sanitizeFreeformText(value);
      if (!legacyModel) continue;
      result[sanitizedKey] = { model: legacyModel };
      continue;
    }

    const sanitizedSelection = sanitizeModelSelection(value);
    if (sanitizedSelection) {
      result[sanitizedKey] = sanitizedSelection;
    }
  }

  return result;
}

function sanitizeModelSelection(value: unknown): ModelSelection | null {
  if (!isRecord(value)) return null;

  const taskforce = sanitizeTaskforceConfig(value.taskforce);
  const perCliSettings = sanitizeAllPerCliSettings(value.perCliSettings);
  const model = sanitizeFreeformText(value.model);
  if (!model && !taskforce && !perCliSettings) return null;

  const result: ModelSelection = { model: model ?? "" };

  if (typeof value.direct === "boolean") {
    result.direct = value.direct;
  }

  const effort = sanitizeFreeformText(value.effort);
  if (effort) {
    result.effort = effort;
  }

  if (taskforce) {
    result.taskforce = taskforce;
  }

  if (perCliSettings) {
    result.perCliSettings = perCliSettings;
  }

  return result;
}

function sanitizePerCliSettings(value: unknown): PerCliSettings | undefined {
  if (!isRecord(value)) return undefined;
  const result: PerCliSettings = {};
  let hasField = false;

  const model = sanitizeFreeformText(value.model);
  if (model) { result.model = model; hasField = true; }

  const effort = sanitizeFreeformText(value.effort);
  if (effort) { result.effort = effort; hasField = true; }

  if (typeof value.direct === "boolean") { result.direct = value.direct; hasField = true; }

  return hasField ? result : undefined;
}

function sanitizeAllPerCliSettings(
  value: unknown,
): Partial<Record<string, PerCliSettings>> | undefined {
  if (!isRecord(value)) return undefined;

  const result: Partial<Record<string, PerCliSettings>> = {};
  let hasEntry = false;

  for (const [key, entry] of Object.entries(value)) {
    const sanitizedKey = sanitizeConfigKey(key);
    if (!sanitizedKey) continue;
    const sanitized = sanitizePerCliSettings(entry);
    if (sanitized) {
      result[sanitizedKey] = sanitized;
      hasEntry = true;
    }
  }

  return hasEntry ? result : undefined;
}

function sanitizeTaskforceConfig(value: unknown): TaskForceConfig | undefined {
  if (!isRecord(value)) return undefined;

  const taskforce: TaskForceConfig = {};
  for (const [cliKey, cliValue] of Object.entries(value)) {
    if (!isTaskForceCliType(cliKey)) continue;
    const sanitizedTaskforceSelection = sanitizeTaskForceSelection(cliKey, cliValue);
    if (sanitizedTaskforceSelection) {
      taskforce[cliKey] = sanitizedTaskforceSelection;
    }
  }

  return Object.keys(taskforce).length > 0 ? taskforce : undefined;
}

function sanitizeCliTypeOverrides(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [id, cliType] of Object.entries(value)) {
    const sanitizedId = sanitizeConfigKey(id);
    if (!sanitizedId || typeof cliType !== "string" || !VALID_CLI_TYPES.has(cliType)) continue;
    result[sanitizedId] = cliType;
  }
  return result;
}

function sanitizeCarrierDisplayNames(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [id, displayName] of Object.entries(value)) {
    const sanitizedId = sanitizeConfigKey(id);
    const sanitizedDisplayName = sanitizeCarrierDisplayName(displayName);
    if (!sanitizedId || !sanitizedDisplayName) continue;
    result[sanitizedId] = sanitizedDisplayName;
  }
  return result;
}

function resolveSelectionForCliType(
  current: ModelSelection,
  cliType: CliType,
): ModelSelection | null {
  const provider = getProviderModels(cliType);
  const allowedModels = new Set(provider.models.map((model) => model.modelId));
  const saved = sanitizePerCliSettings(current.perCliSettings?.[cliType]);

  const currentModelIsValid = allowedModels.has(current.model);
  const savedModelIsValid = !!saved?.model && allowedModels.has(saved.model);
  const model = currentModelIsValid
    ? current.model
    : savedModelIsValid
      ? saved.model!
      : provider.defaultModel;

  const result: ModelSelection = { model };
  const modelEffort = getEffort(cliType, model);

  if (modelEffort.supported) {
    const effort = currentModelIsValid && current.effort && modelEffort.levels.includes(current.effort)
      ? current.effort
      : !currentModelIsValid && savedModelIsValid && saved?.effort && modelEffort.levels.includes(saved.effort)
        ? saved.effort
        : modelEffort.default;

    result.effort = effort;
  }

  if (current.direct !== undefined) {
    result.direct = current.direct;
  } else if (saved?.direct !== undefined) {
    result.direct = saved.direct;
  }

  return result;
}

function isSameResolvedSelection(
  current: ModelSelection,
  resolved: ModelSelection,
): boolean {
  return current.model === resolved.model
    && current.effort === resolved.effort
    && current.direct === resolved.direct;
}

function getSanitizedTaskForceConfig(
  config: SelectedModelsConfig,
  carrierId: string,
): TaskForceConfig | undefined {
  return sanitizeTaskforceConfig(config[carrierId]?.taskforce);
}

function getConfiguredTaskForceBackendsInConfig(
  config: SelectedModelsConfig,
  carrierId: string,
): TaskForceCliType[] {
  const taskforceConfig = getSanitizedTaskForceConfig(config, carrierId);
  if (!taskforceConfig) return [];
  return TASKFORCE_CLI_TYPES.filter((cli) => taskforceConfig[cli as TaskForceCliType] != null) as TaskForceCliType[];
}

function isTaskForceFormableInConfig(
  config: SelectedModelsConfig,
  carrierId: string,
): boolean {
  return getConfiguredTaskForceBackendsInConfig(config, carrierId).length >= 2;
}

function sanitizeTaskForceSelection(cliType: CliType, value: unknown): TaskForceSelection | null {
  if (!isRecord(value)) return null;

  const provider = getProviderModels(cliType);
  const allowedModels = new Set(provider.models.map((model) => model.modelId));
  const model = sanitizeFreeformText(value.model);
  if (!model || !allowedModels.has(model)) return null;

  const result: TaskForceSelection = { model };
  const modelEffort = getEffort(cliType, model);
  const effort = sanitizeFreeformText(value.effort);

  if (modelEffort.supported) {
    result.effort = effort && modelEffort.levels.includes(effort)
      ? effort
      : modelEffort.default;
  }

  return result;
}

function ensureTaskForceConfig(
  config: SelectedModelsConfig,
  carrierId: string,
): TaskForceConfig {
  if (!config[carrierId]) {
    config[carrierId] = { model: "" };
  }

  if (!config[carrierId]!.taskforce) {
    config[carrierId]!.taskforce = {};
  }

  return config[carrierId]!.taskforce!;
}

function pruneEmptyTaskForceConfig(carrierConfig: ModelSelection): void {
  if (carrierConfig.taskforce && Object.keys(carrierConfig.taskforce).length === 0) {
    delete carrierConfig.taskforce;
  }
}

function toTaskForceCliType(value: string): TaskForceCliType {
  if (isTaskForceCliType(value)) {
    return value;
  }
  throw new Error(`Unsupported Task Force backend: ${value}`);
}

function isTaskForceCliType(value: string): value is TaskForceCliType {
  return TASKFORCE_CLI_TYPES.includes(value as CliType);
}

function sanitizeConfigKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || CONTROL_CHAR_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function sanitizeFreeformText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || CONTROL_CHAR_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function normalizeCarrierDisplayNameInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (CONTROL_CHAR_PATTERN.test(value)) return null;

  const normalized = value
    .replace(DISPLAY_NAME_BIDI_CONTROL_PATTERN, "")
    .replace(DISPLAY_NAME_ZERO_WIDTH_PATTERN, "")
    .slice(0, DISPLAY_NAME_MAX_LENGTH);

  return normalized;
}

export function sanitizeCarrierDisplayName(value: unknown): string | null {
  const normalized = normalizeCarrierDisplayNameInput(value);
  if (normalized == null) return null;

  const trimmed = normalized.trim();
  if (!trimmed) return null;
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

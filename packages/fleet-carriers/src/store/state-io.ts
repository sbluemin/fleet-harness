/**
 * fleet/shipyard/store.ts — Fleet 통합 영속 스토어
 *
 * 모든 fleet 영속 상태를 `states.json` 단일 파일로 일원화합니다.
 * 단일 게이트 I/O 패턴으로 race condition을 방지합니다.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  isRecord,
  sanitizeCarrierModes,
  sanitizeConfigKey,
  sanitizeFreeformText,
  sanitizeGeneration,
} from "./sanitize.js";
import { withStoreDirectoryLock } from "./store-lock.js";
import type {
  FleetStates,
  FleetStoreSnapshot,
  FleetStoreWriteFingerprint,
  SelectedModelsConfig,
} from "./types.js";

interface StateIoRuntimeState {
  storeDir: string | null;
  lastLocalWriteGeneration: number;
  lastLocalWriteFingerprint: FleetStoreWriteFingerprint | null;
}

/** 통합 영속화 파일명 */
const FILENAME = "states.json";
const STALE_SUBAGENT_MODE_FILENAME = "carrier-subagent.json";

/** 스토어 데이터 디렉토리 */
const runtimeState: StateIoRuntimeState = {
  storeDir: null,
  lastLocalWriteGeneration: 0,
  lastLocalWriteFingerprint: null,
};

/**
 * Fleet 통합 스토어를 초기화합니다.
 * index.ts에서 initRuntime() 직후 1회 호출합니다.
 */
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

export function readStatesSnapshot(): FleetStoreSnapshot {
  const states = readStates();
  return {
    generation: sanitizeGeneration(states._generation),
    models: sanitizeModelsMap(states.models),
    cliTypeOverrides: sanitizeStringMap(states.cliTypeOverrides),
    carrierDisplayNames: sanitizeStringMap(states.carrierDisplayNames),
    carrierModes: sanitizeCarrierModes(states.carrierModes),
  };
}

export function getLastLocalStatesGeneration(): number {
  return runtimeState.lastLocalWriteGeneration;
}

/** `writeStates` 직후 동기 stat으로 기록된 최신 로컬 write 지문(없으면 null) */
export function getLastLocalWriteFingerprint(): FleetStoreWriteFingerprint | null {
  return runtimeState.lastLocalWriteFingerprint;
}

export function getStatesFilePath(): string | null {
  if (!runtimeState.storeDir) return null;
  return path.join(runtimeState.storeDir, FILENAME);
}

export function updateStates(mutator: (states: FleetStates) => void): void {
  if (!runtimeState.storeDir) return;
  withStoreLock(() => {
    const states = readStates();
    const snapshot = structuredClone(states);
    mutator(states);
    if (JSON.stringify(snapshot) === JSON.stringify(states)) return;
    writeStates(states);
  });
}

export function withStoreLock<T>(operation: () => T): T {
  return withStoreDirectoryLock(runtimeState.storeDir, operation);
}

function readStates(): FleetStates {
  if (!runtimeState.storeDir) return {};
  const filePath = path.join(runtimeState.storeDir, FILENAME);
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as FleetStates;
  } catch {
    return {};
  }
}

/**
 * writeStates rename 직후 동기 stat으로 (generation, mtime, size) 지문을 기록합니다.
 * mtime 정밀도 한계는 size와 함께 사용해 구분합니다.
 */
function recordLastLocalWriteFingerprint(filePath: string, generation: number): void {
  try {
    const st = fs.statSync(filePath);
    runtimeState.lastLocalWriteFingerprint = { generation, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    runtimeState.lastLocalWriteFingerprint = { generation, mtimeMs: 0, size: 0 };
  }
}

function writeStates(s: FleetStates): void {
  if (!runtimeState.storeDir) throw new Error("Fleet store is not initialized.");
  fs.mkdirSync(runtimeState.storeDir, { recursive: true });
  const filePath = path.join(runtimeState.storeDir, FILENAME);
  const tmpPath = buildTempPath(filePath);
  const next = serializeFleetStates(s);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
    runtimeState.lastLocalWriteGeneration = next._generation ?? 0;
    recordLastLocalWriteFingerprint(filePath, runtimeState.lastLocalWriteGeneration);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw error;
  }
}

function serializeFleetStates(states: FleetStates): FleetStates {
  const next: FleetStates = { _generation: sanitizeGeneration(states._generation) + 1 };
  if (states.models !== undefined) next.models = states.models;
  if (states.cliTypeOverrides !== undefined) next.cliTypeOverrides = states.cliTypeOverrides;
  if (states.carrierDisplayNames !== undefined) next.carrierDisplayNames = states.carrierDisplayNames;
  if (states.carrierModes !== undefined) next.carrierModes = sanitizeCarrierModes(states.carrierModes);
  return next;
}

function buildTempPath(filePath: string): string {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  return `${filePath}.${suffix}.tmp`;
}

function sanitizeModelsMap(value: unknown): SelectedModelsConfig {
  if (!isRecord(value)) return {};
  return value as SelectedModelsConfig;
}

function sanitizeStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const sanitizedKey = sanitizeConfigKey(key);
    const sanitizedValue = sanitizeFreeformText(entry);
    if (sanitizedKey && sanitizedValue) result[sanitizedKey] = sanitizedValue;
  }
  return result;
}

function unlinkStaleSubagentModeFile(dir: string): void {
  try {
    fs.unlinkSync(path.join(dir, STALE_SUBAGENT_MODE_FILENAME));
  } catch {
    // 미출시 파일 잔여물 정리만 시도합니다.
  }
}

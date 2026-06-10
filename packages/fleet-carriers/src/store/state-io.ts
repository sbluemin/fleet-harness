import * as fs from "node:fs";
import * as path from "node:path";

import { ensureSafeDirectory, NOFOLLOW_FLAG, withDirectoryLock, writeAtomicSync } from "@dotobokuri/fleet-infra/fs-store";

import {
  sanitizeCarriersMap,
  sanitizeGeneration,
} from "./sanitize.js";
import type {
  FleetCarriers,
  FleetStoreWriteFingerprint,
} from "./types.js";

interface StateIoRuntimeState {
  storeDir: string | null;
  lastLocalWriteGeneration: number;
  lastLocalWriteFingerprint: FleetStoreWriteFingerprint | null;
}

const FILENAME = "carriers.json";
const STALE_SUBAGENT_MODE_FILENAME = "carrier-subagent.json";
const LOCK_DIRNAME = "carriers.json.lock";
const LOCK_OWNER_FILENAME = "owner.json";

const runtimeState: StateIoRuntimeState = {
  storeDir: null,
  lastLocalWriteGeneration: 0,
  lastLocalWriteFingerprint: null,
};

export function initStore(dir: string): void {
  runtimeState.storeDir = dir;
  // [LOW #10] ensureSafeDirectory로 0o700 보장 — 심볼릭링크 방어
  ensureSafeDirectory(dir);
  withStoreLock(() => {
    unlinkStaleSubagentModeFile(dir);
  });
}

export function resetStoreForTests(): void {
  runtimeState.storeDir = null;
  runtimeState.lastLocalWriteGeneration = 0;
  runtimeState.lastLocalWriteFingerprint = null;
}

export function readRawCarriers(): FleetCarriers {
  return readCarriers();
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
  if (!runtimeState.storeDir) return operation();
  fs.mkdirSync(runtimeState.storeDir, { recursive: true });
  const lockDir = path.join(runtimeState.storeDir, LOCK_DIRNAME);
  return withDirectoryLock(
    { lockDir, ownerFileName: LOCK_OWNER_FILENAME },
    operation,
  );
}

function readCarriers(): FleetCarriers {
  if (!runtimeState.storeDir) return {};
  const filePath = path.join(runtimeState.storeDir, FILENAME);
  let fd: number | undefined;
  try {
    // fd 기반 심링크 방어: lstatSync isFile + O_RDONLY|O_NOFOLLOW + fstatSync isFile
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return {};
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW_FLAG);
    if (!fs.fstatSync(fd).isFile()) return {};
    return sanitizeFleetCarriers(JSON.parse(fs.readFileSync(fd, "utf-8")));
  } catch {
    return {};
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
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
  const next = serializeFleetCarriers(s);
  // 동작 보존: 현행 무fsync 유지 (atomic write + rename, fsync 없음)
  // carriers.json은 비민감 데이터 — 0o644 명시로 sensitivity 모델 정합
  writeAtomicSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { fsync: false, mode: 0o644 });
  runtimeState.lastLocalWriteGeneration = next._meta?.generation ?? 0;
  recordLastLocalWriteFingerprint(filePath, runtimeState.lastLocalWriteGeneration);
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

function unlinkStaleSubagentModeFile(dir: string): void {
  try {
    fs.unlinkSync(path.join(dir, STALE_SUBAGENT_MODE_FILENAME));
  } catch {
    // 미출시 파일 잔여물 정리만 시도합니다.
  }
}

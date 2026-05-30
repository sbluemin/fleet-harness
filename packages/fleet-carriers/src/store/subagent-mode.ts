import * as fs from "node:fs";
import * as path from "node:path";

import { withStoreDirectoryLock } from "./store-lock.js";

export type CarrierSubagentMode = "subagent";

export interface CarrierSubagentModeSnapshot {
  readonly carrierModes: Record<string, CarrierSubagentMode>;
  readonly generation: number;
}

interface SubagentModeFile {
  readonly _generation?: number;
  readonly carrierModes?: Record<string, unknown>;
}

interface SubagentModeRuntimeState {
  storeDir: string | null;
}

const FILENAME = "carrier-subagent.json";
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const runtimeState: SubagentModeRuntimeState = {
  storeDir: null,
};

export function initSubagentModeStore(dir: string): void {
  runtimeState.storeDir = dir;
  fs.mkdirSync(dir, { recursive: true });
}

export function resetSubagentModeStoreForTests(): void {
  runtimeState.storeDir = null;
}

export function getSubagentModeFilePath(): string | null {
  return runtimeState.storeDir ? path.join(runtimeState.storeDir, FILENAME) : null;
}

export function readCarrierSubagentModeSnapshot(): CarrierSubagentModeSnapshot {
  return sanitizeSnapshot(readFile());
}

export function isCarrierSubagentModeEnabled(carrierId: string): boolean {
  return readCarrierSubagentModeSnapshot().carrierModes[carrierId] === "subagent";
}

export function setCarrierSubagentMode(carrierId: string, enabled: boolean): void {
  const sanitizedCarrierId = sanitizeKey(carrierId);
  if (!sanitizedCarrierId || !runtimeState.storeDir) return;
  withStoreDirectoryLock(runtimeState.storeDir, () => {
    const current = sanitizeSnapshot(readFile());
    const carrierModes = { ...current.carrierModes };
    if (enabled) carrierModes[sanitizedCarrierId] = "subagent";
    else delete carrierModes[sanitizedCarrierId];
    writeFile({
      carrierModes,
      generation: current.generation + 1,
    });
  });
}

export function filterCarrierSubagentModesToRegisteredIds(
  snapshot: CarrierSubagentModeSnapshot,
  registeredCarrierIds: readonly string[],
): CarrierSubagentModeSnapshot {
  const allowed = new Set(registeredCarrierIds);
  return {
    carrierModes: Object.fromEntries(
      Object.entries(snapshot.carrierModes).filter(([carrierId]) => allowed.has(carrierId)),
    ),
    generation: snapshot.generation,
  };
}

export function getEnabledCarrierSubagentIds(
  snapshot: CarrierSubagentModeSnapshot,
  registeredCarrierIds?: readonly string[],
): string[] {
  const filtered = registeredCarrierIds
    ? filterCarrierSubagentModesToRegisteredIds(snapshot, registeredCarrierIds)
    : snapshot;
  return Object.keys(filtered.carrierModes).sort();
}

function readFile(): SubagentModeFile {
  const filePath = getSubagentModeFilePath();
  if (!filePath) return {};
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as SubagentModeFile;
  } catch {
    return {};
  }
}

function writeFile(snapshot: CarrierSubagentModeSnapshot): void {
  if (!runtimeState.storeDir) return;
  fs.mkdirSync(runtimeState.storeDir, { recursive: true });
  const filePath = path.join(runtimeState.storeDir, FILENAME);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw error;
  }
}

function sanitizeSnapshot(value: unknown): CarrierSubagentModeSnapshot {
  if (!isRecord(value)) return { carrierModes: {}, generation: 0 };
  return {
    carrierModes: sanitizeCarrierModes(value.carrierModes),
    generation: sanitizeGeneration(value._generation ?? value.generation),
  };
}

function sanitizeCarrierModes(value: unknown): Record<string, CarrierSubagentMode> {
  if (!isRecord(value)) return {};
  const result: Record<string, CarrierSubagentMode> = {};
  for (const [carrierId, mode] of Object.entries(value)) {
    const sanitizedCarrierId = sanitizeKey(carrierId);
    if (sanitizedCarrierId && mode === "subagent") result[sanitizedCarrierId] = "subagent";
  }
  return result;
}

function sanitizeGeneration(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) return 0;
  return value as number;
}

function sanitizeKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || CONTROL_CHAR_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

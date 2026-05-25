import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getFleetDataDir } from "../data-dir/paths.js";
import type { FleetCliPreset, FleetPresetData, FleetPresetValidationResult, PresetStore } from "./types.js";

interface CreatePresetStoreDeps {
  readonly dataDir?: string;
  readonly now?: () => number;
  readonly staleLockMs?: number;
  readonly timeoutMs?: number;
}

interface PresetLockOwner {
  readonly hostname: string;
  readonly pid: number;
  readonly startedAt: number;
}

const PRESET_VERSION = 1;
const PRESET_FILE_NAME = "presets.json";
const LOCK_DIR_NAME = "presets.json.lock";
const LOCK_OWNER_FILE_NAME = "owner";
const TEMP_FILE_PREFIX = `.tmp-${PRESET_FILE_NAME}-`;
const SECURE_DIR_MODE = 0o700;
const SECURE_FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const TEMP_FILE_MIN_AGE_MS = 60_000;
const NOFOLLOW_FLAG = fs.constants.O_NOFOLLOW ?? 0;

export function createPresetStore(deps: CreatePresetStoreDeps = {}): PresetStore {
  const dataDir = deps.dataDir ?? getFleetDataDir();
  const presetPath = path.join(dataDir, PRESET_FILE_NAME);
  const lockPath = path.join(dataDir, LOCK_DIR_NAME);
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleLockMs = deps.staleLockMs ?? DEFAULT_STALE_LOCK_MS;

  return {
    path: presetPath,
    load: () => readPresetFile(presetPath),
    save: (data) => withPresetLock({ dataDir, lockPath, now, staleLockMs, timeoutMs }, () => writePresetFile(presetPath, sanitizePresetData(data).data)),
    update: (mutate) =>
      withPresetLock({ dataDir, lockPath, now, staleLockMs, timeoutMs }, () => {
        const current = readPresetFile(presetPath);
        const next = sanitizePresetData(mutate(current)).data;
        writePresetFile(presetPath, next);
        return next;
      }),
  };
}

export function createEmptyPresetData(): FleetPresetData {
  return { version: PRESET_VERSION, byCli: {} };
}

export function sanitizePresetData(value: unknown): FleetPresetValidationResult {
  if (!isRecord(value)) {
    return { data: createEmptyPresetData(), changed: true };
  }

  let changed = value.version !== PRESET_VERSION;
  const defaultCliId = typeof value.defaultCliId === "string" && value.defaultCliId.length > 0
    ? value.defaultCliId
    : undefined;
  if ("defaultCliId" in value && defaultCliId === undefined) {
    changed = true;
  }

  const byCli: Record<string, FleetCliPreset> = Object.create(null) as Record<string, FleetCliPreset>;
  if (isRecord(value.byCli)) {
    for (const [cliId, rawPreset] of Object.entries(value.byCli)) {
      if (!isSafeDictionaryKey(cliId)) {
        changed = true;
        continue;
      }
      const preset = sanitizeCliPreset(rawPreset);
      if (preset.changed) {
        changed = true;
      }
      if (Object.keys(preset.data).length > 0) {
        byCli[cliId] = preset.data;
      }
    }
  } else if ("byCli" in value) {
    changed = true;
  }

  return { data: { version: PRESET_VERSION, ...(defaultCliId ? { defaultCliId } : {}), byCli }, changed };
}

function readPresetFile(presetPath: string): FleetPresetData {
  let fd: number | undefined;
  try {
    const stat = safeLstat(presetPath);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      return createEmptyPresetData();
    }
    fd = fs.openSync(presetPath, fs.constants.O_RDONLY | NOFOLLOW_FLAG);
    if (!fs.fstatSync(fd).isFile()) {
      return createEmptyPresetData();
    }
    return sanitizePresetData(JSON.parse(fs.readFileSync(fd, "utf-8"))).data;
  } catch {
    return createEmptyPresetData();
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function writePresetFile(presetPath: string, data: FleetPresetData): void {
  const dir = path.dirname(presetPath);
  ensureSafeDirectory(dir);
  const tempPath = path.join(dir, `${TEMP_FILE_PREFIX}${process.pid}-${Date.now()}-${randomSuffix()}-${os.hostname()}`);
  try {
    const fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, SECURE_FILE_MODE);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, presetPath);
  } catch (error) {
    removeFileIfExists(tempPath);
    throw error;
  }
}

function withPresetLock<T>(
  options: {
    readonly dataDir: string;
    readonly lockPath: string;
    readonly now: () => number;
    readonly staleLockMs: number;
    readonly timeoutMs: number;
  },
  operation: () => T,
): T {
  ensureSafeDirectory(options.dataDir);
  const startedAt = options.now();
  while (true) {
    try {
      fs.mkdirSync(options.lockPath, { mode: SECURE_DIR_MODE });
      try {
        writeLockOwner(options.lockPath, options.now());
        cleanupPresetTempFiles(options.dataDir, options.now());
        return operation();
      } finally {
        removeLock(options.lockPath);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      recoverStaleLock(options.lockPath, options.now, options.staleLockMs);
      if (options.now() - startedAt >= options.timeoutMs) {
        throw new Error(`Timed out waiting for Fleet preset lock: ${options.lockPath}`);
      }
      sleepSync(10);
    }
  }
}

function sanitizeCliPreset(value: unknown): { readonly data: FleetCliPreset; readonly changed: boolean } {
  if (!isRecord(value)) {
    return { data: {}, changed: true };
  }

  const data: FleetCliPreset = {
    ...(typeof value.model === "string" && value.model.length > 0 ? { model: value.model } : {}),
    ...(typeof value.native === "boolean" ? { native: value.native } : {}),
    ...(typeof value.replaceSystemPrompt === "boolean" ? { replaceSystemPrompt: value.replaceSystemPrompt } : {}),
    ...(typeof value.enableMetaphor === "boolean" ? { enableMetaphor: value.enableMetaphor } : {}),
    ...(typeof value.cursorSync === "boolean" ? { cursorSync: value.cursorSync } : {}),
  };
  const changed = Object.keys(value).some((key) => !(key in data)) ||
    ("model" in value && data.model === undefined) ||
    ("native" in value && data.native === undefined) ||
    ("replaceSystemPrompt" in value && data.replaceSystemPrompt === undefined) ||
    ("enableMetaphor" in value && data.enableMetaphor === undefined) ||
    ("cursorSync" in value && data.cursorSync === undefined);
  return { data, changed };
}

function ensureSafeDirectory(dirPath: string): void {
  const stat = safeLstat(dirPath);
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe Fleet preset directory: ${dirPath}`);
    }
    fs.chmodSync(dirPath, SECURE_DIR_MODE);
    return;
  }
  fs.mkdirSync(dirPath, { recursive: true, mode: SECURE_DIR_MODE });
  const created = safeLstat(dirPath);
  if (!created?.isDirectory() || created.isSymbolicLink()) {
    throw new Error(`Unsafe Fleet preset directory: ${dirPath}`);
  }
  fs.chmodSync(dirPath, SECURE_DIR_MODE);
}

function recoverStaleLock(lockPath: string, now: () => number, staleLockMs: number): void {
  const stat = safeLstat(lockPath);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    return;
  }
  const owner = readLockOwner(lockPath);
  if (owner === undefined && now() - stat.mtimeMs >= staleLockMs) {
    removeLock(lockPath);
    return;
  }
  if (
    owner !== undefined
    && owner.hostname === os.hostname()
    && !isPidAlive(owner.pid)
    && now() - owner.startedAt >= staleLockMs
  ) {
    removeLock(lockPath);
  }
}

function removeLock(lockPath: string): void {
  fs.rmSync(lockPath, { recursive: true, force: true });
}

function writeLockOwner(lockPath: string, now: number): void {
  const owner: PresetLockOwner = { hostname: os.hostname(), pid: process.pid, startedAt: now };
  fs.writeFileSync(path.join(lockPath, LOCK_OWNER_FILE_NAME), `${JSON.stringify(owner)}\n`, { mode: SECURE_FILE_MODE });
}

function readLockOwner(lockPath: string): PresetLockOwner | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(lockPath, LOCK_OWNER_FILE_NAME), "utf-8")) as unknown;
    if (!isRecord(raw) || typeof raw.hostname !== "string" || typeof raw.pid !== "number" || typeof raw.startedAt !== "number") {
      return undefined;
    }
    return { hostname: raw.hostname, pid: raw.pid, startedAt: raw.startedAt };
  } catch {
    return undefined;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function cleanupPresetTempFiles(dataDir: string, now: number): void {
  for (const entry of fs.readdirSync(dataDir)) {
    if (!entry.startsWith(TEMP_FILE_PREFIX)) {
      continue;
    }
    const tempPath = path.join(dataDir, entry);
    const stat = safeLstat(tempPath);
    if (stat?.isFile() && !stat.isSymbolicLink() && now - stat.mtimeMs >= TEMP_FILE_MIN_AGE_MS) {
      removeFileIfExists(tempPath);
    }
  }
}

function removeFileIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function safeLstat(targetPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2);
}

function isSafeDictionaryKey(key: string): boolean {
  return key.length > 0 && key !== "__proto__" && key !== "prototype" && key !== "constructor";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

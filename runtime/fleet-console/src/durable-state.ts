import fs from "node:fs";
import path from "node:path";

import {
  createDurableJsonStore,
  type CreateDurableJsonStoreDeps,
  type DurableJsonStore,
} from "@dotobokuri/fleet-infra";

import { createConsoleDataPaths, type ConsoleDataPaths } from "./paths.js";
import type { TheaterRegistration } from "./theaters.js";

export interface ProviderSession {
  readonly provider: "claude" | "codex";
  readonly sessionId: string;
  readonly transcriptPath?: string;
  readonly source?: string;
  readonly capturedAt: string;
}

export interface DurableOperation {
  readonly sessionId: string;
  readonly theaterId: string;
  readonly cwd: string;
  readonly cwdLabel: string;
  readonly sequence: number;
  readonly label?: string;
  readonly cliId?: string;
  readonly cliLabel?: string;
  readonly createdAt: number;
  readonly providerSession?: ProviderSession;
}

export interface DurableConsoleState {
  readonly version: 1;
  readonly theaters: readonly TheaterRegistration[];
  readonly operations: readonly DurableOperation[];
}

export interface CreateConsoleDurableStateStoreDeps {
  readonly paths?: ConsoleDataPaths;
  readonly createStore?: (deps: CreateDurableJsonStoreDeps<DurableConsoleState>) => DurableJsonStore<DurableConsoleState>;
  readonly now?: () => number;
}

export interface ReadProviderSessionCaptureDeps {
  readonly capturesDir?: string;
}

export interface UnlinkProviderSessionCaptureDeps {
  readonly capturesDir?: string;
}

const STATE_VERSION = 1;
const STATE_LOCK_DIR_NAME = "state.lock";
const STATE_LOCK_OWNER_FILE_NAME = "owner.json";
const STATE_TEMP_PREFIX = ".state.";

export function createConsoleDurableStateStore(deps: CreateConsoleDurableStateStoreDeps = {}): DurableJsonStore<DurableConsoleState> {
  const paths = deps.paths ?? createConsoleDataPaths();
  const createStore = deps.createStore ?? createDurableJsonStore;
  return createStore({
    filePath: paths.stateFile,
    lockDir: path.join(paths.dir, STATE_LOCK_DIR_NAME),
    lockOwnerFileName: STATE_LOCK_OWNER_FILE_NAME,
    now: deps.now,
    sanitize: sanitizeDurableConsoleState,
    sensitivity: "sensitive",
    tempCleanupPrefix: STATE_TEMP_PREFIX,
  });
}

export function sanitizeDurableConsoleState(value: unknown): DurableConsoleState {
  if (!isRecord(value) || value.version !== STATE_VERSION) return emptyDurableConsoleState();
  return {
    version: STATE_VERSION,
    theaters: readTheaterRegistrations(value.theaters),
    operations: readDurableOperations(value.operations),
  };
}

export function emptyDurableConsoleState(): DurableConsoleState {
  return { version: STATE_VERSION, theaters: [], operations: [] };
}

export function readProviderSessionCapture(fleetSessionId: string, deps: ReadProviderSessionCaptureDeps = {}): ProviderSession | null {
  if (!isSafeCaptureId(fleetSessionId)) return null;
  const capturesDir = deps.capturesDir ?? createConsoleDataPaths().capturesDir;
  const filePath = path.join(capturesDir, `${fleetSessionId}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return sanitizeProviderSession(parsed);
  } catch {
    return null;
  }
}

export function mergeProviderSessionCaptures(state: DurableConsoleState, deps: ReadProviderSessionCaptureDeps = {}): DurableConsoleState {
  let changed = false;
  const operations = state.operations.map((operation) => {
    if (operation.providerSession) return operation;
    const providerSession = readProviderSessionCapture(operation.sessionId, deps);
    if (!providerSession) return operation;
    changed = true;
    return { ...operation, providerSession };
  });
  return changed ? { ...state, operations } : state;
}

export function unlinkProviderSessionCapture(fleetSessionId: string, deps: UnlinkProviderSessionCaptureDeps = {}): boolean {
  if (!isSafeCaptureId(fleetSessionId)) return false;
  const capturesDir = deps.capturesDir ?? createConsoleDataPaths().capturesDir;
  try {
    fs.unlinkSync(path.join(capturesDir, `${fleetSessionId}.json`));
    return true;
  } catch {
    return false;
  }
}

export function cleanupProviderSessionCaptures(state: DurableConsoleState, deps: UnlinkProviderSessionCaptureDeps = {}): void {
  for (const operation of state.operations) {
    if (operation.providerSession) unlinkProviderSessionCapture(operation.sessionId, deps);
  }
}

function readTheaterRegistrations(value: unknown): readonly TheaterRegistration[] {
  if (!Array.isArray(value)) return [];
  const registrations: TheaterRegistration[] = [];
  for (const item of value) {
    const registration = sanitizeTheaterRegistration(item);
    if (registration) registrations.push(registration);
  }
  return registrations;
}

function readDurableOperations(value: unknown): readonly DurableOperation[] {
  if (!Array.isArray(value)) return [];
  const operations: DurableOperation[] = [];
  for (const item of value) {
    const operation = sanitizeDurableOperation(item);
    if (operation) operations.push(operation);
  }
  return operations;
}

function sanitizeTheaterRegistration(value: unknown): TheaterRegistration | null {
  if (!isRecord(value)) return null;
  const id = readNonEmptyString(value.id);
  const theaterPath = readNonEmptyString(value.path);
  const realpath = readNonEmptyString(value.realpath);
  const label = readNonEmptyString(value.label);
  const registeredAt = readNonEmptyString(value.registeredAt);
  const lastOpenedAt = readNonEmptyString(value.lastOpenedAt);
  if (!id || !theaterPath || !realpath || !label || !registeredAt || !lastOpenedAt) return null;
  return { id, path: theaterPath, realpath, label, registeredAt, lastOpenedAt };
}

function sanitizeDurableOperation(value: unknown): DurableOperation | null {
  if (!isRecord(value)) return null;
  const sessionId = readNonEmptyString(value.sessionId);
  const theaterId = readNonEmptyString(value.theaterId);
  const cwd = readNonEmptyString(value.cwd);
  const cwdLabel = readNonEmptyString(value.cwdLabel);
  const sequence = readPositiveInteger(value.sequence);
  const createdAt = readFiniteNumber(value.createdAt);
  if (!sessionId || !theaterId || !cwd || !cwdLabel || sequence === null || createdAt === null) return null;
  const providerSession = sanitizeProviderSession(value.providerSession);
  return {
    sessionId,
    theaterId,
    cwd,
    cwdLabel,
    sequence,
    ...(readOptionalString(value.label) ? { label: readOptionalString(value.label) } : {}),
    ...(readOptionalString(value.cliId) ? { cliId: readOptionalString(value.cliId) } : {}),
    ...(readOptionalString(value.cliLabel) ? { cliLabel: readOptionalString(value.cliLabel) } : {}),
    createdAt,
    ...(providerSession ? { providerSession } : {}),
  };
}

function sanitizeProviderSession(value: unknown): ProviderSession | null {
  if (!isRecord(value)) return null;
  const provider = value.provider === "claude" || value.provider === "codex" ? value.provider : null;
  const sessionId = readNonEmptyString(value.sessionId);
  const capturedAt = readNonEmptyString(value.capturedAt);
  if (!provider || !sessionId || !capturedAt) return null;
  return {
    provider,
    sessionId,
    ...(readOptionalString(value.transcriptPath) ? { transcriptPath: readOptionalString(value.transcriptPath) } : {}),
    ...(readOptionalString(value.source) ? { source: readOptionalString(value.source) } : {}),
    capturedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeCaptureId(value: string): boolean {
  return value.length > 0 && path.basename(value) === value && !value.includes(path.sep) && !value.includes(path.posix.sep);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

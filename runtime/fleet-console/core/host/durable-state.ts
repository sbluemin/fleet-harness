import path from "node:path";

import {
  createDurableJsonStore,
  type CreateDurableJsonStoreDeps,
  type DurableJsonStore,
} from "@dotobokuri/core-infra";

import { createConsoleDataPaths, type ConsoleDataPaths } from "./paths.js";
import { MAX_GROUP_NAME_LENGTH, type OperationNode } from "./operations/types.js";
import type { TheaterRegistration } from "./theaters.js";

export interface DurableOperationGroup {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly order: number;
  readonly theaterId: string;
  readonly createdAt: number;
}

export interface DurableConsoleState {
  readonly version: 2;
  readonly theaters: readonly TheaterRegistration[];
  readonly operations: readonly OperationNode[];
  readonly groups?: readonly DurableOperationGroup[];
}

export interface CreateConsoleDurableStateStoreDeps {
  readonly paths?: ConsoleDataPaths;
  readonly createStore?: (deps: CreateDurableJsonStoreDeps<DurableConsoleState>) => DurableJsonStore<DurableConsoleState>;
  readonly now?: () => number;
}

const STATE_VERSION = 2;
const STATE_LOCK_DIR_NAME = "state.lock";
const STATE_LOCK_OWNER_FILE_NAME = "owner.json";
const STATE_TEMP_PREFIX = ".state.";
// 그룹 색상 키 화이트리스트 — 8톤 정체성 팔레트(operation-accent.ts)와 동일 키를 durable에 허용한다.
// 구 16키는 기존 durable state 하위호환용으로만 남는다(클라이언트가 읽기 시점에 8톤으로 매핑).
const VALID_GROUP_COLOR_KEYS = new Set([
  "crimson", "amber", "moss", "teal", "cerulean", "indigo", "plum", "rose",
  "red", "orange", "yellow", "lime", "green",
  "emerald", "cyan", "sky", "blue",
  "violet", "purple", "magenta",
]);

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
  if (!isRecord(value)) return emptyDurableConsoleState();
  const upgraded = migrateToCurrentVersion(value);
  if (upgraded.version !== STATE_VERSION) return emptyDurableConsoleState();
  return {
    version: STATE_VERSION,
    theaters: readTheaterRegistrations(upgraded.theaters),
    operations: readOperations(upgraded.operations),
    groups: readOperationGroups(upgraded.groups),
  };
}

export function emptyDurableConsoleState(): DurableConsoleState {
  return { version: STATE_VERSION, theaters: [], operations: [], groups: [] };
}

// 릴리스된 stable durable state(v1, flat 세션 레코드)을 현재 스키마(OperationNode)로 1회 변환한다.
// 변환 결과는 readOperations의 sanitizeOperationNode가 다시 검증하므로 여기서는 모양만 맞춘다.
// v1만 변환하고, 그 외 STATE_VERSION이 아닌 값은 상위 sanitize에서 empty 폴백된다.
function migrateToCurrentVersion(value: Record<string, unknown>): Record<string, unknown> {
  if (value.version === 1) return migrateV1ToV2(value);
  return value;
}

function migrateV1ToV2(v1: Record<string, unknown>): Record<string, unknown> {
  const operations = Array.isArray(v1.operations) ? v1.operations.map(migrateV1Operation) : [];
  return {
    version: STATE_VERSION,
    theaters: v1.theaters ?? [],
    operations,
    groups: [],
  };
}

function migrateV1Operation(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const sessionId = readNonEmptyString(value.sessionId);
  const theaterId = readNonEmptyString(value.theaterId);
  const cwd = readNonEmptyString(value.cwd);
  const createdAt = readFiniteNumber(value.createdAt);
  if (!sessionId || !theaterId || !cwd || createdAt === null) return null;
  // v1 label(사용자/auto 표시명) → title. 없으면 cwd basename(#N 제거 규칙과 일치).
  const title = readOptionalString(value.label) ?? (path.basename(cwd) || cwd);
  const payload: Record<string, unknown> = { cwd };
  const cliId = readOptionalString(value.cliId);
  const cliLabel = readOptionalString(value.cliLabel);
  const labelSource = readOptionalString(value.labelSource);
  if (cliId) payload.cliId = cliId;
  if (cliLabel) payload.cliLabel = cliLabel;
  if (labelSource) payload.labelSource = labelSource;
  if (isRecord(value.providerSession)) payload.providerSession = value.providerSession;
  // 드롭: sequence(#N 기능 제거), cwdLabel(basename 파생), autoNamePromptSeen(v2 비영속).
  return {
    id: sessionId,
    theaterId,
    type: "agent",
    pluginId: "terminal",
    title,
    payload,
    geometry: null,
    ts: { createdAt, updatedAt: createdAt },
  };
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

function readOperations(value: unknown): readonly OperationNode[] {
  if (!Array.isArray(value)) return [];
  const nodes: OperationNode[] = [];
  for (const item of value) {
    const node = sanitizeOperationNode(item);
    if (node) nodes.push(node);
  }
  return nodes;
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
  const order = readNonNegativeInteger(value.order);
  return {
    id,
    path: theaterPath,
    realpath,
    label,
    registeredAt,
    lastOpenedAt,
    ...(order !== null ? { order } : {}),
  };
}

function sanitizeOperationNode(value: unknown): OperationNode | null {
  if (!isRecord(value)) return null;
  const id = readNonEmptyString(value.id);
  const theaterId = readNonEmptyString(value.theaterId);
  const type = readNonEmptyString(value.type);
  const pluginId = remapTerminalPluginId(readNonEmptyString(value.pluginId));
  const title = readNonEmptyString(value.title);
  const ts = sanitizeOperationTimestamps(value.ts);
  if (!id || !theaterId || !type || !pluginId || !title || !ts) return null;
  const accent = readOptionalAccent(value.accent);
  const groupId = readOptionalGroupId(value.groupId);
  return {
    id,
    theaterId,
    type,
    pluginId,
    title,
    payload: readRecord(value.payload),
    geometry: sanitizeOperationGeometry(value.geometry),
    ...(accent ? { accent } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
    ts,
  };
}

function sanitizeOperationTimestamps(value: unknown): OperationNode["ts"] | null {
  if (!isRecord(value)) return null;
  const createdAt = readFiniteNumber(value.createdAt);
  const updatedAt = readFiniteNumber(value.updatedAt);
  if (createdAt === null || updatedAt === null) return null;
  return { createdAt, updatedAt };
}

function sanitizeOperationGeometry(value: unknown): OperationNode["geometry"] {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  const x = readFiniteNumber(value.x);
  const y = readFiniteNumber(value.y);
  const width = readFiniteNumber(value.width);
  const height = readFiniteNumber(value.height);
  const zIndex = readFiniteNumber(value.zIndex);
  if (x === null || y === null || width === null || height === null || zIndex === null) return null;
  return { x, y, width, height, zIndex };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function remapTerminalPluginId(pluginId: string | null): string | null {
  return pluginId === "agent" || pluginId === "shell" ? "terminal" : pluginId;
}

function readOptionalAccent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 64) : undefined;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function readOptionalGroupId(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 64) : undefined;
  }
  return undefined;
}

function readOperationGroups(value: unknown): readonly DurableOperationGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: DurableOperationGroup[] = [];
  for (const item of value) {
    const group = sanitizeOperationGroup(item);
    if (group) groups.push(group);
  }
  return groups;
}

function sanitizeOperationGroup(value: unknown): DurableOperationGroup | null {
  if (!isRecord(value)) return null;
  const id = readNonEmptyString(value.id);
  const theaterId = readNonEmptyString(value.theaterId);
  const rawName = readNonEmptyString(value.name);
  const color = readNonEmptyString(value.color);
  const order = readNonNegativeInteger(value.order);
  const createdAt = readFiniteNumber(value.createdAt);
  if (!id || !theaterId || !rawName || !color || order === null || createdAt === null) return null;
  if (rawName.length > MAX_GROUP_NAME_LENGTH) return null;
  if (!VALID_GROUP_COLOR_KEYS.has(color)) return null;
  return { id, theaterId, name: rawName, color, order, createdAt };
}

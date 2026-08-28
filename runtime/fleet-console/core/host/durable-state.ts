import fs from "node:fs";
import path from "node:path";

import {
  createDurableJsonStore,
  type CreateDurableJsonStoreDeps,
  type DurableJsonStore,
} from "@dotobokuri/core-infra";

import { createConsoleDataPaths, type ConsoleDataPaths } from "./paths.js";
import { MAX_GROUP_NAME_LENGTH, type OperationNode } from "./operations/operations-domain.js";
import type { TheaterRegistration } from "./theaters/theater-domain.js";

export interface DurableOperationGroup {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly order: number;
  readonly theaterId: string;
  readonly createdAt: number;
}

export interface DurableDeletionBase {
  readonly deletionId: string;
  readonly targetId: string;
  readonly deletedAt: number;
  readonly expiresAt: number;
}

export type DurableDeletionTombstone =
  | (DurableDeletionBase & { readonly kind: "operation"; readonly operation: OperationNode })
  | (DurableDeletionBase & {
      readonly kind: "theater";
      readonly theater: TheaterRegistration;
      readonly operations: readonly OperationNode[];
      readonly groups: readonly DurableOperationGroup[];
    });

export interface DurableConsoleState {
  readonly version: 4;
  readonly theaters: readonly TheaterRegistration[];
  readonly operations: readonly OperationNode[];
  readonly groups?: readonly DurableOperationGroup[];
  readonly deletionTombstones?: readonly DurableDeletionTombstone[];
}

export interface CreateConsoleDurableStateStoreDeps {
  readonly paths?: ConsoleDataPaths;
  readonly createStore?: (deps: CreateDurableJsonStoreDeps<DurableConsoleState>) => DurableJsonStore<DurableConsoleState>;
  readonly now?: () => number;
}

export const STATE_VERSION = 4;
const STATE_LOCK_DIR_NAME = "state.lock";
const STATE_LOCK_OWNER_FILE_NAME = "owner.json";
const STATE_TEMP_PREFIX = ".state.";
const V3_BACKUP_SUFFIX = ".v3-backup";
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
    deletionTombstones: readDeletionTombstones(upgraded.deletionTombstones),
  };
}

export function emptyDurableConsoleState(): DurableConsoleState {
  return { version: STATE_VERSION, theaters: [], operations: [], groups: [], deletionTombstones: [] };
}

export function readDurableStateVersion(stateFilePath: string): number | null {
  try {
    const value = JSON.parse(fs.readFileSync(stateFilePath, "utf8")) as unknown;
    return isRecord(value) && typeof value.version === "number" ? value.version : null;
  } catch {
    return null;
  }
}

/** v3 원본을 첫 v4 저장 전에 한 번만 보존한다. 백업 실패는 복원을 막지 않는다. */
export function backupDurableStateV3(stateFilePath: string): void {
  const backupPath = `${stateFilePath}${V3_BACKUP_SUFFIX}`;
  try {
    if (!fs.existsSync(stateFilePath) || fs.existsSync(backupPath)) return;
    fs.copyFileSync(stateFilePath, backupPath);
  } catch (error) {
    console.warn(`[fleet-console] Durable state v3 backup skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 릴리스된 stable durable state(v1, flat 세션 레코드)을 현재 스키마(OperationNode)로 1회 변환한다.
// 변환 결과는 readOperations의 sanitizeOperationNode가 다시 검증하므로 여기서는 모양만 맞춘다.
// 각 버전 단계를 순서대로 거쳐 단계별 기본값을 보존하고, 최종 sanitizer가 다시 검증한다.
function migrateToCurrentVersion(value: Record<string, unknown>): Record<string, unknown> {
  let current = value;
  if (current.version === 1) current = migrateV1ToV2(current);
  if (current.version === 2) current = migrateV2ToV3(current);
  if (current.version === 3) current = migrateV3ToV4(current);
  return current;
}

function migrateV1ToV2(v1: Record<string, unknown>): Record<string, unknown> {
  const operations = Array.isArray(v1.operations) ? v1.operations.map(migrateV1Operation) : [];
  return {
    version: 2,
    theaters: v1.theaters ?? [],
    operations,
    groups: [],
  };
}

function migrateV2ToV3(v2: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 3,
    theaters: v2.theaters ?? [],
    operations: v2.operations ?? [],
    groups: v2.groups ?? [],
    deletionTombstones: [],
  };
}

function migrateV3ToV4(v3: Record<string, unknown>): Record<string, unknown> {
  return {
    version: STATE_VERSION,
    theaters: v3.theaters ?? [],
    operations: migrateOperationListToV4(v3.operations),
    groups: v3.groups ?? [],
    deletionTombstones: migrateDeletionTombstonesToV4(v3.deletionTombstones),
  };
}

function migrateOperationListToV4(value: unknown): unknown {
  return Array.isArray(value) ? value.map(migrateOperationToV4) : [];
}

function migrateOperationToV4(value: unknown): unknown {
  if (!isRecord(value) || value.pluginId !== "terminal" || value.type !== "agent") return value;
  const payload = isRecord(value.payload) ? value.payload : {};
  const legacyProviderSession = isRecord(payload.providerSession) ? payload.providerSession : undefined;
  const existingSession = isRecord(payload.session) ? payload.session : undefined;
  const legacyHarness = legacyProviderSession?.provider === "codex" ? "codex" : "claude-code";
  const session: Record<string, unknown> = {
    ...(existingSession ?? {}),
    harness: readOptionalString(existingSession?.harness) ?? legacyHarness,
  };
  const model = readOptionalString(existingSession?.model) ?? readOptionalString(payload.launchModel);
  const effort = readOptionalString(existingSession?.effort) ?? readOptionalString(payload.launchEffort);
  const id = readOptionalString(existingSession?.id) ?? readOptionalString(legacyProviderSession?.sessionId);
  const transcriptPath = readOptionalString(existingSession?.transcriptPath) ?? readOptionalString(legacyProviderSession?.transcriptPath);
  const source = readOptionalString(existingSession?.source) ?? readOptionalString(legacyProviderSession?.source);
  const capturedAt = readOptionalString(existingSession?.capturedAt) ?? readOptionalString(legacyProviderSession?.capturedAt);
  if (model) session.model = model;
  if (effort) session.effort = effort;
  if (id) session.id = id;
  if (transcriptPath) session.transcriptPath = transcriptPath;
  if (source) session.source = source;
  if (capturedAt) session.capturedAt = capturedAt;

  const nextPayload: Record<string, unknown> = { ...payload, session };
  for (const key of ["cliId", "launchKindId", "cliLabel", "launchProvider", "launchModel", "launchEffort", "providerSession"]) {
    delete nextPayload[key];
  }
  return { ...value, payload: nextPayload };
}

function migrateDeletionTombstonesToV4(value: unknown): unknown {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!isRecord(item)) return item;
    if (item.kind === "operation") return { ...item, operation: migrateOperationToV4(item.operation) };
    if (item.kind === "theater") return { ...item, operations: migrateOperationListToV4(item.operations) };
    return item;
  });
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
  // Shell은 콘솔 전역 확대 표면으로 옮겨 갔고 더 이상 Operation이 아니다. 예전 상태 파일이
  // 실어 온 Shell 노드는 그릴 종류가 없으므로 복원하지 않고 흘려보낸다 — 남겨 두면 캔버스에
  // 렌더러 없는 패널로 서고, 사용자는 그것을 고장으로 읽는다.
  if (type === "shell") return null;
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

function readDeletionTombstones(value: unknown): readonly DurableDeletionTombstone[] {
  if (!Array.isArray(value)) return [];
  const tombstones: DurableDeletionTombstone[] = [];
  for (const item of value) {
    const tombstone = sanitizeDeletionTombstone(item);
    if (tombstone) tombstones.push(tombstone);
  }
  return tombstones;
}

function sanitizeDeletionTombstone(value: unknown): DurableDeletionTombstone | null {
  if (!isRecord(value)) return null;
  const deletionId = readNonEmptyString(value.deletionId);
  const targetId = readNonEmptyString(value.targetId);
  const deletedAt = readFiniteNumber(value.deletedAt);
  const expiresAt = readFiniteNumber(value.expiresAt);
  if (!deletionId || !targetId || deletedAt === null || expiresAt === null) return null;
  if (value.kind === "operation") {
    const operation = sanitizeOperationNode(value.operation);
    if (!operation || operation.id !== targetId) return null;
    return { deletionId, targetId, deletedAt, expiresAt, kind: "operation", operation };
  }
  if (value.kind === "theater") {
    const theater = sanitizeTheaterRegistration(value.theater);
    if (!theater || theater.id !== targetId || !Array.isArray(value.operations) || !Array.isArray(value.groups)) return null;
    const operations = value.operations
      .map(sanitizeOperationNode)
      .filter((operation): operation is OperationNode => operation !== null);
    const groups = value.groups
      .map(sanitizeOperationGroup)
      .filter((group): group is DurableOperationGroup => group !== null);
    if (operations.length !== value.operations.length
      || groups.length !== value.groups.length
      || operations.some((operation) => operation.theaterId !== targetId)
      || groups.some((group) => group.theaterId !== targetId)) return null;
    return { deletionId, targetId, deletedAt, expiresAt, kind: "theater", theater, operations, groups };
  }
  return null;
}

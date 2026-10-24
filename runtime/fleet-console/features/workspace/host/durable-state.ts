import fs from "node:fs";
import path from "node:path";

import {
  createDurableJsonStore,
  type CreateDurableJsonStoreDeps,
  type DurableJsonStore,
} from "@fleet-console/infra";

import { DEFAULT_OBJECTIVE_GROUP_COLOR, isObjectiveGroupColor } from "../shared/identity-tones.js";

import { createConsoleDataPaths, type ConsoleDataPaths } from "../../../core/host/bootstrap/paths.js";
import { MAX_GROUP_NAME_LENGTH, type ObjectiveRecord } from "../../objectives/host/records/objective-records-domain.js";
import { type TheaterRegistration } from "./theaters/theater-domain.js";

export interface DurableObjectiveGroup {
  readonly commodoreId: string;
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
  /** 삭제 전 보관 위치. undo가 active로 승격시키지 않도록 보존한다. */
  readonly archived?: Readonly<Record<string, { readonly archiveId: string; readonly archivedAt: number }>>;
}

export type DurableDeletionTombstone =
  | (DurableDeletionBase & { readonly kind: "objectiveRecord"; readonly objectiveRecord: ObjectiveRecord; readonly descendants?: readonly ObjectiveRecord[] })
  | (DurableDeletionBase & {
      readonly kind: "theater";
      readonly theater: TheaterRegistration;
      readonly objectiveRecords: readonly ObjectiveRecord[];
      readonly groups: readonly DurableObjectiveGroup[];
    });

export interface DurableConsoleState {
  readonly version: 6;
  readonly revision?: number;
  readonly theaters: readonly TheaterRegistration[];
  readonly objectiveRecords: readonly ObjectiveRecord[];
  readonly groups?: readonly DurableObjectiveGroup[];
  readonly deletionTombstones?: readonly DurableDeletionTombstone[];
}

export interface CreateConsoleDurableStateStoreDeps {
  readonly paths?: ConsoleDataPaths;
  readonly createStore?: (deps: CreateDurableJsonStoreDeps<DurableConsoleState>) => DurableJsonStore<DurableConsoleState>;
  readonly now?: () => number;
}

export const STATE_VERSION = 6;
const STATE_LOCK_DIR_NAME = "state.lock";
const STATE_LOCK_OWNER_FILE_NAME = "owner.json";
const STATE_TEMP_PREFIX = ".state.";
const V3_BACKUP_SUFFIX = ".v3-backup";

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
  const upgraded = value;
  if (upgraded.version !== STATE_VERSION) return emptyDurableConsoleState();
  return {
    version: STATE_VERSION,
    ...(readNonNegativeInteger(upgraded.revision) !== null ? { revision: readNonNegativeInteger(upgraded.revision)! } : {}),
    theaters: readTheaterRegistrations(upgraded.theaters),
    objectiveRecords: readObjectiveRecords(upgraded.objectiveRecords ?? upgraded.operations),
    groups: readObjectiveGroups(upgraded.groups),
    deletionTombstones: readDeletionTombstones(upgraded.deletionTombstones),
  };
}

export function emptyDurableConsoleState(): DurableConsoleState {
  return { version: STATE_VERSION, theaters: [], objectiveRecords: [], groups: [], deletionTombstones: [] };
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

/** 이전 버전의 원본을 덮어쓰지 않는 백업. 승계 저장 실패 시에도 원본을 되찾을 수 있다. */
export function backupDurableStateV4(stateFilePath: string): void {
  if (!fs.existsSync(stateFilePath)) return;
  try { fs.copyFileSync(stateFilePath, `${stateFilePath}.v4-backup`, fs.constants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
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

function readObjectiveRecords(value: unknown): readonly ObjectiveRecord[] {
  if (!Array.isArray(value)) return [];
  const nodes: ObjectiveRecord[] = [];
  for (const item of value) {
    const node = sanitizeObjectiveRecord(item);
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

export function sanitizeObjectiveRecord(value: unknown): ObjectiveRecord | null {
  if (!isRecord(value)) return null;
  const id = readNonEmptyString(value.id);
  const theaterId = readNonEmptyString(value.theaterId);
  const type = readNonEmptyString(value.type);
  const pluginId = remapTerminalPluginId(readNonEmptyString(value.pluginId));
  const title = readNonEmptyString(value.title);
  const ts = sanitizeObjectiveTimestamps(value.ts);
  if (!id || !theaterId || !title || !ts) return null;
  // Shell은 콘솔 전역 확대 표면으로 옮겨 갔고 더 이상 Objective이 아니다. 예전 상태 파일이
  // 실어 온 Shell 노드는 그릴 종류가 없으므로 복원하지 않고 흘려보낸다 — 남겨 두면 캔버스에
  // 렌더러 없는 패널로 서고, 사용자는 그것을 고장으로 읽는다.
  //
  // 종류 이름은 플러그인마다 독립이므로 plugin까지 함께 본다. `type`만 보면 "shell"이라는
  // 흔한 이름을 쓴 남의 플러그인의 Objective이 재시작마다 조용히 지워진다. 예전 `shell`
  // 플러그인 id는 remapTerminalPluginId가 이미 terminal로 옮겨 주므로 옛 상태도 걸린다.
  if (type === "shell" && pluginId === "terminal") return null;
  const accent = readOptionalAccent(value.accent);
  const groupId = readOptionalGroupId(value.groupId);
  const order = readNonNegativeInteger(value.order);
  const childRows = value.sessions ?? value.childSessions;
  const sessions = Array.isArray(childRows) ? childRows.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const childId = readNonEmptyString(entry.id);
    const childTs = sanitizeObjectiveTimestamps(entry.ts);
    return childId && childId !== id && childTs ? [{ id: childId, ...(readRecord(entry.payload ?? entry)), ts: childTs }] : [];
  }) : [];
  return {
    id,
    theaterId,
    commodoreId: readNonEmptyString(value.commodoreId) ?? "",
    title,
    ...(readRecord(value.payload ?? value)),
    ...(accent ? { accent } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
    ...(order !== null ? { order } : {}),
    ...(sessions.length ? { sessions } : {}),
    ts,
  };
}

function sanitizeObjectiveTimestamps(value: unknown): ObjectiveRecord["ts"] | null {
  if (!isRecord(value)) return null;
  const createdAt = readFiniteNumber(value.createdAt);
  const updatedAt = readFiniteNumber(value.updatedAt);
  if (createdAt === null || updatedAt === null) return null;
  return { createdAt, updatedAt };
}

function sanitizeObjectiveGeometry(value: unknown): ObjectiveRecord["geometry"] {
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

function readObjectiveGroups(value: unknown): readonly DurableObjectiveGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: DurableObjectiveGroup[] = [];
  for (const item of value) {
    const group = sanitizeObjectiveGroup(item);
    if (group) groups.push(group);
  }
  return groups;
}

function sanitizeObjectiveGroup(value: unknown): DurableObjectiveGroup | null {
  if (!isRecord(value)) return null;
  const id = readNonEmptyString(value.id);
  const theaterId = readNonEmptyString(value.theaterId);
  const rawName = readNonEmptyString(value.name);
  const rawColor = readNonEmptyString(value.color);
  const color = isObjectiveGroupColor(rawColor) ? rawColor : DEFAULT_OBJECTIVE_GROUP_COLOR;
  const order = readNonNegativeInteger(value.order);
  const createdAt = readFiniteNumber(value.createdAt);
  if (!id || !theaterId || !rawName || order === null || createdAt === null) return null;
  if (rawName.length > MAX_GROUP_NAME_LENGTH) return null;
  return { id, commodoreId: readNonEmptyString(value.commodoreId) ?? "", theaterId, name: rawName, color, order, createdAt };
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

export function deletionObjectiveRecords(value: DurableDeletionTombstone): readonly ObjectiveRecord[] {
  return value.kind === "objectiveRecord" ? [value.objectiveRecord, ...(value.descendants ?? [])] : value.objectiveRecords;
}

export function sanitizeDeletionTombstone(value: unknown): DurableDeletionTombstone | null {
  if (!isRecord(value)) return null;
  const deletionId = readNonEmptyString(value.deletionId);
  const targetId = readNonEmptyString(value.targetId);
  const deletedAt = readFiniteNumber(value.deletedAt);
  const expiresAt = readFiniteNumber(value.expiresAt);
  if (!deletionId || !targetId || deletedAt === null || expiresAt === null) return null;
  const archived: Record<string, { archiveId: string; archivedAt: number }> = {};
  if (value.archived !== undefined) {
    if (!isRecord(value.archived)) return null;
    for (const [id, entry] of Object.entries(value.archived)) {
      if (!isRecord(entry) || !readNonEmptyString(entry.archiveId) || readFiniteNumber(entry.archivedAt) === null) return null;
      Object.defineProperty(archived, id, { value: { archiveId: entry.archiveId, archivedAt: entry.archivedAt }, enumerable: true });
    }
  }
  const location = Object.keys(archived).length ? { archived } : {};
  if (value.kind === "objectiveRecord" || value.kind === "operation") {
    const objectiveRecord = sanitizeObjectiveRecord(value.objectiveRecord ?? value.operation);
    if (!objectiveRecord || objectiveRecord.id !== targetId) return null;
    const descendants = value.descendants === undefined ? [] : readObjectiveRecords(value.descendants);
    if (value.descendants !== undefined && (!Array.isArray(value.descendants) || descendants.length !== value.descendants.length)) return null;
    return { deletionId, targetId, deletedAt, expiresAt, kind: "objectiveRecord", objectiveRecord, ...location, ...(descendants.length ? { descendants } : {}) };
  }
  if (value.kind === "theater") {
    const theater = sanitizeTheaterRegistration(value.theater);
    const records = value.objectiveRecords ?? value.operations;
    if (!theater || theater.id !== targetId || !Array.isArray(records) || !Array.isArray(value.groups)) return null;
    const objectiveRecords = records
      .map(sanitizeObjectiveRecord)
      .filter((objectiveRecord): objectiveRecord is ObjectiveRecord => objectiveRecord !== null);
    const groups = value.groups
      .map(sanitizeObjectiveGroup)
      .filter((group): group is DurableObjectiveGroup => group !== null);
    if (objectiveRecords.length !== records.length
      || groups.length !== value.groups.length
      || objectiveRecords.some((objectiveRecord) => objectiveRecord.theaterId !== targetId)
      || groups.some((group) => group.theaterId !== targetId)) return null;
    return { deletionId, targetId, deletedAt, expiresAt, kind: "theater", theater, objectiveRecords, groups, ...location };
  }
  return null;
}

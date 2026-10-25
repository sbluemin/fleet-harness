import { legacyTheaterAliases, retainRegistrationAliases, type LegacyTheaterAlias } from "../../workspace/host/registration-migration.js";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createDurableJsonStore, ensureSafeDirectory, NOFOLLOW_FLAG, type DurableJsonStore } from "@fleet-console/infra";
import type { ObjectiveRecord } from "./records/objective-records-domain.js";
import { STATE_VERSION, sanitizeDurableConsoleState, deletionObjectiveRecords, type DurableConsoleState, type DurableDeletionTombstone, type DurableObjectiveGroup } from "../../workspace/host/durable-state.js";
import { ObjectiveArchiveError, validateLocations, type ArchivedObjective, type ArchiveLifecycleEvent } from "../../workspace/host/objective-archive-storage.js";
import type { StoredObjective } from "../shared/types.js";
import { assertMinimal, boardFromDocument, documentFromBoard, documentFromObjective, object, objectiveRecordFromDocument, normalizeObjectiveDocument, type ObjectiveDocumentContext, type ObjectiveDocument } from "./storage-codec.js";
import { clearPendingIndex, importMissingObjectives, readPendingIndex, rememberImported } from "./legacy-import.js";

export interface ObjectiveOwner extends ObjectiveDocumentContext { readonly directory: string }
export interface ObjectiveBoardStorage {
  owners(): readonly ObjectiveOwner[];
  unavailable(id: string): boolean;
  directory(commodoreId: string): string | null;
  list(commodoreId: string): readonly StoredObjective[];
  save(commodoreId: string, board: StoredObjective): void;
  forget(commodoreId: string, id: string): void;
}
type Group = Omit<DurableObjectiveGroup, "commodoreId">;
// 그룹과 사건의 Theater는 표시용 위치 메타데이터이지 소유자가 아니다.
function minimalGroups(groups: readonly Group[]): readonly object[] {
  return groups.map(({ theaterId: _location, ...group }) => group);
}

interface Deletion {
  deletionId: string; targetId: string; deletedAt: number; expiresAt: number;
  kind: "objective" | "theater";
  objectiveIds: readonly string[];
  groups?: readonly Group[];
  archived?: DurableDeletionTombstone["archived"];
}
type EventIndex = Pick<ArchiveLifecycleEvent, "eventId" | "channel" | "objectiveId" | "sessionIds"> & { readonly theaterId?: string };
interface Quarantine { id: string | null; sourceHash: string; location: string; reason: string; theaterId?: string }
interface Archive {
  revision: number;
  entries: readonly { archiveId: string; archivedAt: number; objectiveId: string }[];
  deletions: readonly Deletion[];
  events: readonly EventIndex[];
  /** 충돌 원문은 migration backup에 남긴다. 이 ID는 읽기·쓰기·재발급에서 제외한다. */
  unavailable?: readonly string[];
  quarantine?: readonly Quarantine[];
  transaction?: string;
}
interface Transaction {
  documents: readonly ObjectiveDocument[]; groups: readonly Group[]; archive: Archive;
  state: DurableConsoleState; purgeIds: readonly string[];
}
interface Scope { owner: ObjectiveOwner; documents: Map<string, ObjectiveDocument>; groups: readonly Group[]; archive: Archive; unreadable: Set<string>; journalDeferred?: boolean; indexUnread?: boolean; unmerged?: boolean }
const emptyArchive = (): Archive => ({ revision: 0, entries: [], deletions: [], events: [] });
const failure = () => new ObjectiveArchiveError(503, "archive_recovery_required");
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
function segment(id: unknown): string {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw failure();
  return id;
}
/** 링크를 따라가지 않는다. 원본 바이트 보존도 같은 읽기 경계를 지난다. */
function readBytes(file: string): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw failure();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW_FLAG);
  try { if (!fs.fstatSync(fd).isFile()) throw failure(); return fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
}
function readJson(file: string): unknown { return JSON.parse(readBytes(file).toString("utf8")); }
function safeDir(dir: string): void {
  ensureSafeDirectory(dir);
  if (fs.realpathSync(dir) !== path.resolve(dir)) throw failure();
}
function readDocument(value: unknown, owner: ObjectiveOwner): ObjectiveDocument {
  if (!object(value) || typeof value.id !== "string" || typeof value.title !== "string" || !object(value.ts)
    || !Number.isFinite(value.ts.createdAt) || !Number.isFinite(value.ts.updatedAt) || (value.pending !== undefined && value.pending !== true)) throw failure();
  segment(value.id);
  const doc = normalizeObjectiveDocument(value as ObjectiveDocument, owner);
  assertMinimal(doc);
  return doc;
}
function ids(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw failure();
  const result = value.map(segment);
  if (new Set(result).size !== result.length) throw failure();
  return result;
}
const channels = new Set(["objective:archived", "objective:restored", "objective:deleted", "objective:purged"]);
function archiveShape(value: unknown): asserts value is Record<string, unknown> & { entries: Record<string, unknown>[]; deletions: Record<string, unknown>[]; events: Record<string, unknown>[] } {
  if (!object(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || !Array.isArray(value.entries) || !Array.isArray(value.deletions) || !Array.isArray(value.events)
    || ![...value.entries, ...value.deletions, ...value.events].every(object)) throw failure();
}
/** 색인은 허용한 키만 저장한다. 구형 본문을 실수로 섞어 쓸 수 없다. */
function readArchive(value: unknown): Archive {
  archiveShape(value);
  const entries = value.entries.map((row) => {
    if (typeof row.archiveId !== "string" || !row.archiveId || !Number.isFinite(row.archivedAt) || "objective" in row) throw failure();
    return { archiveId: row.archiveId, archivedAt: row.archivedAt as number, objectiveId: segment(row.objectiveId) };
  });
  const deletions = value.deletions.map((row): Deletion => {
    if (typeof row.deletionId !== "string" || !row.deletionId || typeof row.targetId !== "string" || !Number.isFinite(row.deletedAt) || !Number.isFinite(row.expiresAt)
      || !["objective", "theater"].includes(String(row.kind)) || "objective" in row || "objectives" in row) throw failure();
    const objectiveIds = ids(row.objectiveIds);
    if (row.kind === "objective" && !objectiveIds.includes(row.targetId)) throw failure();
    if (row.kind === "theater" && !Array.isArray(row.groups)) throw failure();
    if (row.archived !== undefined && (!object(row.archived) || Object.entries(row.archived).some(([id, entry]) => !objectiveIds.includes(id)
      || !object(entry) || typeof entry.archiveId !== "string" || !Number.isFinite(entry.archivedAt) || Object.keys(entry).some((key) => !["archiveId", "archivedAt"].includes(key))))) throw failure();
    return { deletionId: row.deletionId, targetId: row.targetId, deletedAt: row.deletedAt as number, expiresAt: row.expiresAt as number,
      kind: row.kind as Deletion["kind"], objectiveIds, ...(row.groups ? { groups: row.groups as Group[] } : {}),
      ...(row.archived ? { archived: row.archived as Deletion["archived"] } : {}),
    };
  });
  const events = value.events.map((row): EventIndex => {
    if (typeof row.eventId !== "string" || !channels.has(String(row.channel)) || "objective" in row) throw failure();
    if (row.theaterId !== undefined && typeof row.theaterId !== "string") throw failure();
    return { eventId: row.eventId, channel: row.channel as EventIndex["channel"], objectiveId: segment(row.objectiveId), sessionIds: ids(row.sessionIds), ...(typeof row.theaterId === "string" ? { theaterId: row.theaterId } : {}) };
  });
  const quarantine = value.quarantine === undefined ? [] : value.quarantine;
  if (!Array.isArray(quarantine) || quarantine.some((row) => !object(row) || (row.id !== null && typeof row.id !== "string")
    || typeof row.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(row.sourceHash) || typeof row.location !== "string" || typeof row.reason !== "string"
    || (row.theaterId !== undefined && typeof row.theaterId !== "string")
    || Object.keys(row).some((key) => !["id", "sourceHash", "location", "reason", "theaterId"].includes(key)))) throw failure();
  const archive: Archive = { revision: Number(value.revision), entries, deletions, events,
    ...(quarantine.length ? { quarantine: quarantine as Quarantine[] } : {}),
    ...(value.unavailable !== undefined ? { unavailable: ids(value.unavailable) } : {}),
    ...(value.transaction !== undefined ? { transaction: segment(value.transaction) } : {}),
  };
  assertMinimal({ ...archive,
    deletions: archive.deletions.map((row) => ({ ...row, ...(row.groups ? { groups: minimalGroups(row.groups) } : {}) })),
    events: archive.events.map(({ theaterId: _location, ...row }) => row),
    quarantine: archive.quarantine?.map(({ theaterId: _location, ...row }) => row),
  });
  const located = [...entries.map((row) => row.objectiveId), ...deletions.flatMap((row) => row.objectiveIds)];
  if (new Set(located).size !== located.length) throw failure();
  return archive;
}
function readRegistrations(raw: unknown, recovering = false): DurableConsoleState {
  if (!object(raw) || raw.version !== STATE_VERSION || !Array.isArray(raw.theaters)) throw failure();
  const tombstones = Array.isArray(raw.deletionTombstones) ? raw.deletionTombstones.map((row) => object(row) && row.kind === "theater" ? { ...row, objectiveRecords: row.objectiveRecords ?? [], groups: row.groups ?? [] } : row) : [];
  const state = sanitizeDurableConsoleState({ ...raw, deletionTombstones: tombstones });
  if (state.theaters.length !== raw.theaters.length || state.deletionTombstones?.length !== tombstones.length) throw failure();
  return recovering ? retainRegistrationAliases(raw, state as unknown as Record<string, unknown>) as unknown as DurableConsoleState : state;
}
function withoutOwner(group: DurableObjectiveGroup): Group { const { commodoreId: _owner, ...rest } = group; return rest; }
function inactive(scope: Scope): Set<string> {
  return new Set([...scope.archive.entries.map((row) => row.objectiveId), ...scope.archive.deletions.flatMap((row) => row.objectiveIds),
    ...scope.archive.events.filter((row) => row.channel === "objective:purged").map((row) => row.objectiveId), ...scope.archive.unavailable ?? []]);
}
function unavailable(scope: Scope, id: string): boolean { return (scope.archive.unavailable?.includes(id) ?? false) || scope.unreadable.has(id); }
function renameOwnerOperationId(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renameOwnerOperationId);
  if (!object(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = key === "ownerOperationId" ? "ownerObjectiveId" : key;
    if (next === "ownerObjectiveId" && Object.hasOwn(out, "ownerObjectiveId")) continue;
    out[next] = renameOwnerOperationId(item);
  }
  return out;
}
function document(scope: Scope, id: string): ObjectiveDocument {
  const doc = scope.documents.get(id);
  if (!doc || unavailable(scope, id)) throw failure();
  return doc;
}
const eventIndex = (row: ArchiveLifecycleEvent): EventIndex => ({ eventId: row.eventId, channel: row.channel, objectiveId: row.objectiveId, sessionIds: row.sessionIds, theaterId: row.theaterId });

/** 본문은 목표 파일에, 위치와 사건은 색인에 둔다. 외부 서비스에는 기존 메모리 뷰를 합성한다. */
export function createObjectiveStorage(deps: {
  directory: string;
  stateStore: DurableJsonStore<DurableConsoleState>;
  owners: () => readonly ObjectiveOwner[];
  initializeOwners?: (state: DurableConsoleState) => void;
  /** 복구한 명부의 별칭을 소유 저장소에 커밋한다. 커밋하지 못한 별칭은 명부에 남기고, 기동은 중단하지 않는다. 반환은 명부에서 거둬도 되는 theaterId. */
  migrateRegistrationAliases?: (entries: readonly LegacyTheaterAlias[]) => readonly string[] | void;
  createStore?: typeof createDurableJsonStore;
}) {
  const scopes = new Map<string, Scope>();
  // 저장한 문서는 바꾸지 않고 교체한다. 같은 문서의 깊은 정규화와 cwd 판정을 조회마다 반복하지 않는다.
  const decoded = new WeakMap<ObjectiveDocument, { readonly owner: ObjectiveOwner; readonly record: ObjectiveRecord }>();
  function recordOf(scope: Scope, doc: ObjectiveDocument): ObjectiveRecord {
    let hit = decoded.get(doc);
    if (hit?.owner !== scope.owner) { hit = { owner: scope.owner, record: objectiveRecordFromDocument(doc, scope.owner) }; decoded.set(doc, hit); }
    return { ...hit.record };
  }
  const createStore = deps.createStore ?? createDurableJsonStore;
  let ready = false, blocked = false;
  let state: DurableConsoleState = { version: STATE_VERSION, theaters: [], objectiveRecords: [] };
  let baseline: DurableConsoleState = state;
  let previousRaw: Record<string, unknown> = {};
  const unavailableOwners = new Set<string>();
  const deferredAliasOwners = new Set<string>();
  const archiveStore = (scope: Scope) => createStore<Archive>({ filePath: path.join(scope.owner.directory, "archive.json"), lockDir: null, sensitivity: "sensitive", sanitize: readArchive });
  const journalPath = (scope: Scope, id: string) => path.join(scope.owner.directory, ".transactions", `${segment(id)}.json`);
  function writeJson(file: string, value: unknown): void {
    safeDir(path.dirname(file));
    if (exists(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw failure();
    createStore<unknown>({ filePath: file, lockDir: null, sensitivity: "sensitive", sanitize: (raw) => raw }).save(value);
  }
  function objectiveDir(scope: Scope, id: string): string {
    const dir = path.join(scope.owner.directory, segment(id));
    safeDir(scope.owner.directory);
    if (exists(dir) && (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(dir) !== dir)) throw failure();
    return dir;
  }
  function writeDocuments(scope: Scope, documents: readonly ObjectiveDocument[], groups: readonly Group[]): void {
    for (const doc of documents) {
      readDocument(doc, scope.owner);
      writeJson(path.join(objectiveDir(scope, doc.id), "objective.json"), doc);
    }
    assertMinimal({ groups: minimalGroups(groups) });
    writeJson(path.join(scope.owner.directory, "groups.json"), { groups });
  }
  function purgeDocuments(scope: Scope, purgeIds: readonly string[]): void {
    for (const id of purgeIds) fs.rmSync(objectiveDir(scope, id), { recursive: true, force: true });
  }
  function prepare(scope: Scope, transaction: Transaction): string {
    const id = randomUUID();
    writeJson(journalPath(scope, id), transaction);
    archiveStore(scope).save({ ...scope.archive, transaction: id });
    return id;
  }
  function apply(scope: Scope, tx: Transaction, id: string): void {
    writeDocuments(scope, tx.documents, tx.groups);
    // 누락 문서를 추측해 지우지 않는다. 준비 저널이 지정한 영구 삭제만 재실행한다.
    purgeDocuments(scope, tx.purgeIds);
    archiveStore(scope).save(tx.archive);
    scope.documents = new Map(tx.documents.map((doc) => [doc.id, doc])); scope.groups = tx.groups; scope.archive = tx.archive;
    fs.rmSync(journalPath(scope, id), { force: true });
  }
  function recover(scope: Scope): void {
    const id = scope.archive.transaction;
    if (!id) return;
    const value = readJson(journalPath(scope, id));
    if (!object(value) || !Array.isArray(value.documents) || !Array.isArray(value.groups)) throw failure();
    const archive = readArchive(value.archive);
    if (archive.transaction) throw failure();
    const tx: Transaction = { documents: value.documents.map((value) => readDocument(value, scope.owner)), groups: value.groups as Group[], archive,
      state: readRegistrations(value.state, !ready && !!deps.migrateRegistrationAliases), purgeIds: ids(value.purgeIds) };
    const documentIds = new Set(ids(tx.documents.map((doc) => doc.id)));
    const referenced = [...archive.entries.map((row) => row.objectiveId), ...archive.deletions.flatMap((row) => row.objectiveIds)];
    if (referenced.some((ref) => !archive.unavailable?.includes(ref) && !documentIds.has(ref))
      || tx.purgeIds.some((purgeId) => documentIds.has(purgeId) || referenced.includes(purgeId) || archive.unavailable?.includes(purgeId))) throw failure();
    // state의 저장 모양은 등록만이다. readRegistrations가 만든 본문 뷰를 다시 쓰지 않는다.
    deps.stateStore.save(value.state as DurableConsoleState);
    // 본문 적용이 뒤에서 보류되어도 이미 확정한 등록 after-image를 옛 명부로 덮지 않는다.
    previousRaw = value.state as Record<string, unknown>;
    state = tx.state;
    apply(scope, tx, id);
  }
  function dropReadHold(scope: Scope, id: string, clearUnavailable: boolean): void {
    const unavailableIds = clearUnavailable ? (scope.archive.unavailable ?? []).filter((held) => held !== id) : [...scope.archive.unavailable ?? []];
    const quarantine = (scope.archive.quarantine ?? []).filter((row) => !(row.id === id && row.reason === "objective_unreadable"));
    scope.archive = { ...scope.archive, ...(unavailableIds.length ? { unavailable: unavailableIds } : {}), quarantine };
    if (!unavailableIds.length) delete scope.archive.unavailable;
    if (!quarantine.length) delete scope.archive.quarantine;
  }
  function readDocuments(scope: Scope, heldThisBoot: ReadonlySet<string>): void {
    scope.unreadable.clear();
    const conflicts = new Set((scope.archive.quarantine ?? []).filter((row) => row.reason === "invalid_inline_row" || row.reason === "id_conflict").flatMap((row) => row.id ? [row.id] : []));
    for (const entry of fs.readdirSync(scope.owner.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || conflicts.has(entry.name)) continue;
      const file = path.join(objectiveDir(scope, entry.name), "objective.json");
      if (!exists(file)) continue;
      try {
        const raw = readJson(file);
        const renamed = renameOwnerOperationId(raw);
        const doc = readDocument(renamed, scope.owner);
        if (doc.id !== entry.name) throw failure();
        scope.documents.set(doc.id, doc);
        // 이번 기동이 충돌로 숨긴 id는 파일이 읽혀도 유지한다. 예전 읽기 실패만 풀어 준다.
        dropReadHold(scope, entry.name, !heldThisBoot.has(entry.name));
        if (JSON.stringify(raw).includes("\"ownerOperationId\"")) writeJson(file, doc);
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof ObjectiveArchiveError) && !(error instanceof Error && /^(objective_actor|objective_owner|objective_location|invalid_objective)/.test(error.message))) throw error;
        // 읽기 실패는 이 기동에서만 숨긴다. 디스크 unavailable로 남기면 고친 파일도 다음 기동에 안 읽힌다.
        scope.unreadable.add(entry.name);
        dropReadHold(scope, entry.name, !heldThisBoot.has(entry.name));
        const sourceHash = createHash("sha256").update(readBytes(file)).digest("hex");
        const reason = error instanceof Error && /^(objective_|invalid_)/.test(error.message) ? error.message : "objective_unreadable";
        console.warn(`[objectives] ${entry.name}: ${reason}; original preserved`);
        scope.archive = { ...scope.archive, quarantine: [...scope.archive.quarantine ?? [], { id: entry.name, sourceHash, location: "objective.json", reason: "objective_unreadable" }] };
      }
    }
  }
  function preserveSource(owner: ObjectiveOwner, source: Buffer): string {
    const sourceHash = createHash("sha256").update(source).digest("hex");
    const backup = path.join(owner.directory, ".archive-migration", `${sourceHash}.json`);
    safeDir(path.dirname(backup));
    if (!exists(backup)) {
      const fd = fs.openSync(backup, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW_FLAG, 0o600);
      try { fs.writeFileSync(fd, source); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    if (!readBytes(backup).equals(source)) throw failure();
    return sourceHash;
  }
  /** 직전 인라인 형식만 읽는다. 첨부·증거 트리는 살피거나 복사하지 않는다. */
  function migrateInline(scope: Scope, raw: unknown, source: Buffer): void {
    // 파싱·행 검증보다 원문 보존이 먼저다. 실패 기록에는 본문을 복제하지 않는다.
    const sourceHash = preserveSource(scope.owner, source);
    if (!object(raw)) throw failure();
    const oldTx = raw.transaction;
    if (oldTx !== undefined && (!object(oldTx) || !Array.isArray(oldTx.documents) || !Array.isArray(oldTx.groups) || !object(oldTx.state))) throw failure();
    const target = oldTx === undefined ? raw : (oldTx as Record<string, unknown>).archive;
    if (!object(target) || !Number.isSafeInteger(target.revision) || Number(target.revision) < 0
      || !Array.isArray(target.entries) || !Array.isArray(target.deletions) || !Array.isArray(target.events)) throw failure();
    const candidates = new Map<string, ObjectiveDocument>();
    const conflicted = new Set<string>();
    const quarantine: Quarantine[] = [];
    const knownIds = (row: unknown): string[] => {
      if (!object(row)) return [];
      const docs = [row.objective, ...(Array.isArray(row.objectives) ? row.objectives : [])];
      return [...new Set([row.objectiveId, ...(row.kind === "objective" ? [row.targetId] : []), ...docs.flatMap((doc) => object(doc)
        ? [doc.id, ...(Array.isArray(doc.sessions) ? doc.sessions.flatMap((child) => object(child) ? [child.id] : []) : [])] : [])].filter((id): id is string => typeof id === "string"))];
    };
    const reject = (row: unknown, location: string, reason: string): void => {
      const failedIds = knownIds(row);
      for (const id of failedIds) { try { conflicted.add(segment(id)); } catch { /* 경로로 사용할 수 없는 ID는 기록에만 남긴다. */ } }
      for (const id of failedIds.length ? failedIds : [null]) quarantine.push({ id, sourceHash, location, reason, ...(object(row) && row.kind === "theater" && typeof row.targetId === "string" ? { theaterId: row.targetId } : {}) });
    };
    const prefix = oldTx ? "transaction.archive." : "";
    const located = new Set<string>();
    const entries: Archive["entries"][number][] = [], deletions: Deletion[] = [], events: EventIndex[] = [];
    for (const [kind, rows] of [["entries", target.entries], ["deletions", target.deletions], ["events", target.events]] as const) {
      rows.forEach((row: unknown, index: number) => {
        const location = `${prefix}${kind}[${index}]`;
        try {
          if (!object(row)) throw failure();
          const bodies = kind === "deletions" ? [ ...(row.objective === undefined ? [] : [row.objective]), ...(Array.isArray(row.objectives) ? row.objectives : []) ] : [row.objective];
          const docs = bodies.map((value) => readDocument(value, scope.owner));
          const encoded = kind === "entries" ? { archiveId: row.archiveId, archivedAt: row.archivedAt, objectiveId: docs[0]!.id }
            : kind === "events" ? { eventId: row.eventId, channel: row.channel, objectiveId: docs[0]!.id, sessionIds: ids(Array.isArray(docs[0]!.sessions) ? docs[0]!.sessions.map((child) => object(child) ? child.id : undefined) : []), theaterId: scope.owner.theaterIdOf(docs[0]!.cwd as string) }
              : { deletionId: row.deletionId, kind: row.kind, targetId: row.targetId, deletedAt: row.deletedAt, expiresAt: row.expiresAt, objectiveIds: docs.map((doc) => doc.id), ...(row.groups !== undefined ? { groups: row.groups } : {}), ...(row.archived !== undefined ? { archived: row.archived } : {}) };
          const checked = readArchive({ ...emptyArchive(), [kind]: [encoded] });
          if (kind !== "events" && docs.some((doc) => located.has(doc.id))) throw failure();
          entries.push(...checked.entries); deletions.push(...checked.deletions); events.push(...checked.events);
          if (kind !== "events") for (const doc of docs) { located.add(doc.id); candidates.set(doc.id, doc); }
        } catch { reject(row, location, "invalid_inline_row"); }
      });
    }
    if (quarantine.length) writeJson(path.join(scope.owner.directory, ".archive-migration", `${sourceHash}.quarantine.json`), quarantine);
    let archive = readArchive({ revision: target.revision, entries, deletions, events,
      ...(quarantine.length ? { quarantine } : {}), ...(conflicted.size ? { unavailable: [...conflicted] } : {}),
    });
    scope.archive = archive;
    readDocuments(scope, persistentHolds(scope));
    for (const id of scope.archive.unavailable ?? []) conflicted.add(id);
    for (const [id, doc] of candidates) {
      try {
        const file = path.join(objectiveDir(scope, id), "objective.json");
        if (exists(file) && !isDeepStrictEqual(readDocument(readJson(file), scope.owner), doc)) conflicted.add(id);
      } catch { conflicted.add(id); }
    }
    // 한 삭제 집합은 분할해서 되돌리지 않는다. 충돌한 본문의 자식 ID도 재발급하지 않는다.
    for (const row of archive.deletions) if (row.objectiveIds.some((id) => conflicted.has(id))) for (const id of row.objectiveIds) conflicted.add(id);
    for (const doc of [...scope.documents.values(), ...candidates.values()]) if (conflicted.has(doc.id) && Array.isArray(doc.sessions)) {
      for (const child of doc.sessions) if (object(child) && typeof child.id === "string") conflicted.add(segment(child.id));
    }
    if (oldTx && (conflicted.size || quarantine.length)) throw failure(); // 준비 연산의 원자성을 임의로 쪼개지 않는다.
    archive = { ...archive, ...(conflicted.size ? { unavailable: [...conflicted] } : {}),
      ...(conflicted.size ? { quarantine: [...archive.quarantine ?? [], ...[...conflicted].filter((id) => !(archive.quarantine ?? []).some((row) => row.id === id)).map((id) => ({ id, sourceHash, location: "objective.json", reason: "id_conflict" }))] } : {}) };
    for (const [id, doc] of candidates) if (!conflicted.has(id)) scope.documents.set(id, doc);
    for (const id of conflicted) scope.documents.delete(id);
    if (oldTx && object(oldTx)) {
      const active = (oldTx.documents as unknown[]).map((value) => readDocument(value, scope.owner));
      const documents = new Map(active.map((doc) => [doc.id, doc]));
      for (const [id, doc] of candidates) documents.set(id, doc);
      const tx: Transaction = { documents: [...documents.values()], groups: oldTx.groups as Group[], archive, state: oldTx.state as DurableConsoleState,
        purgeIds: [...scope.documents.keys()].filter((id) => !documents.has(id)) };
      readRegistrations(tx.state);
      // 새 색인의 준비 포인터가 생긴 뒤부터는 기존 owner별 복구 규칙을 따른다.
      scope.archive = archive;
      const id = prepare(scope, tx);
      scope.archive = { ...archive, transaction: id };
      recover(scope);
    } else {
      // 파일을 먼저 둬도 구형 archive가 권위다. 중단 후에는 동일 파일을 재사용한다.
      for (const [id, doc] of candidates) if (!conflicted.has(id)) {
        const file = path.join(objectiveDir(scope, id), "objective.json");
        if (!exists(file)) writeJson(file, doc);
      }
      archiveStore(scope).save(archive);
      scope.archive = archive;
    }
  }
  const persistentReasons = new Set(["invalid_inline_row", "id_conflict", "archive_unreadable", "missing_theater_registration", "index_missing", "purge_conflict"]);
  function persistentHolds(scope: Scope): Set<string> {
    return new Set((scope.archive.quarantine ?? []).filter((row) => persistentReasons.has(row.reason)).flatMap((row) => row.id ? [row.id] : []));
  }
  function holdIds(scope: Scope, ids: readonly string[], reason: string, sourceHash: string): void {
    if (!ids.length) return;
    const quarantine = [...scope.archive.quarantine ?? []];
    for (const id of ids) {
      scope.unreadable.add(id);
      if (!quarantine.some((row) => row.id === id && row.reason === reason)) quarantine.push({ id, sourceHash, location: "archive.json", reason });
    }
    scope.archive = { ...scope.archive, unavailable: [...new Set([...(scope.archive.unavailable ?? []), ...ids])], quarantine };
  }
  function holdDirectory(owner: ObjectiveOwner): Scope {
    const unreadable = new Set<string>();
    try {
      safeDir(owner.directory);
      for (const entry of fs.readdirSync(owner.directory, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && exists(path.join(owner.directory, entry.name, "objective.json"))) unreadable.add(entry.name);
      }
    } catch { /* 자리를 못 열어도 원본 색인은 쓰지 않는다. */ }
    // 읽지 못한 색인을 빈 색인으로 덮지 않는다. 보류는 이 기동 메모리에만 있고, 다음 기동이 원본을 다시 읽는다.
    return { owner, documents: new Map(), groups: [], archive: emptyArchive(), unreadable, indexUnread: true };
  }
  function isolateOrphanDeletions(scope: Scope, owner: ObjectiveOwner, archiveFile: string): void {
    const orphans = scope.archive.deletions.flatMap((row, index) => row.kind === "theater"
      && (!state.deletionTombstones?.some((entry) => entry.kind === "theater" && entry.targetId === row.targetId && entry.deletionId === row.deletionId)) ? [{ row, index }] : []);
    if (!orphans.length) return;
    const sourceHash = exists(archiveFile) ? preserveSource(owner, readBytes(archiveFile)) : "0".repeat(64);
    const rejected = new Set(orphans.map(({ row }) => row));
    const objectiveIds = orphans.flatMap(({ row }) => row.objectiveIds);
    scope.archive = { ...scope.archive,
      deletions: scope.archive.deletions.filter((row) => !rejected.has(row)),
      unavailable: [...new Set([...scope.archive.unavailable ?? [], ...objectiveIds])],
      // 사유 행의 id가 Theater면 다음 기동이 목표 보류를 읽기 성공으로 푼다. 목표 id도 같은 사유로 남긴다.
      quarantine: [...scope.archive.quarantine ?? [],
        ...orphans.map(({ row, index }) => ({ id: row.targetId, sourceHash, location: `deletions[${index}]`, reason: "missing_theater_registration", theaterId: row.targetId })),
        ...objectiveIds.filter((id) => !(scope.archive.quarantine ?? []).some((row) => row.id === id && row.reason === "missing_theater_registration")).map((id) => ({ id, sourceHash, location: "archive.json", reason: "missing_theater_registration" })),
      ],
    };
    for (const id of objectiveIds) scope.unreadable.add(id);
  }
  function importLegacy(scope: Scope): { readonly touched: readonly string[]; readonly groupIds: readonly string[] } {
    const known = new Set<string>([...scope.documents.keys(), ...scope.archive.entries.map((row) => row.objectiveId), ...scope.archive.deletions.flatMap((row) => row.objectiveIds),
      ...scope.archive.events.filter((row) => row.channel === "objective:purged").map((row) => row.objectiveId), ...(scope.archive.unavailable ?? []), ...scope.unreadable]);
    let imported: ReturnType<typeof importMissingObjectives>;
    try {
      imported = importMissingObjectives({ dataDir: deps.directory, owner: scope.owner, previousRaw, known, quarantined: scope.archive.quarantine ?? [], prepareDir: safeDir, writeJson, accept: (value) => readDocument(value, scope.owner), warn: (message) => console.warn(message) });
    } catch (error) {
      console.warn(`[objectives] owner ${scope.owner.commodoreId}: ${error instanceof Error ? error.message : "legacy_import_failed"}; original preserved`);
      return { touched: [], groupIds: [] };
    }
    for (const doc of imported.documents) scope.documents.set(doc.id, doc);
    const present = new Set(scope.groups.map((group) => group.id));
    const groups = [...scope.groups, ...imported.groups.filter((group) => !present.has(group.id))];
    if (groups.length !== scope.groups.length) {
      try { assertMinimal({ groups: minimalGroups(groups) }); scope.groups = groups; writeJson(path.join(scope.owner.directory, "groups.json"), { groups }); }
      catch (error) { console.warn(`[objectives] owner ${scope.owner.commodoreId}: ${error instanceof Error ? error.message : "legacy_groups_unreadable"}; original preserved`); }
    }
    const take = <T>(kind: "entries" | "deletions" | "events", rows: readonly T[]): T[] => rows.flatMap((row) => {
      try { readArchive({ ...emptyArchive(), [kind]: [row] }); return [row]; } catch { return []; }
    });
    const entries = take("entries", imported.entries.filter((entry) => !scope.archive.entries.some((prior) => prior.objectiveId === entry.objectiveId) && !imported.deletions.some((row) => row.objectiveIds.includes(entry.objectiveId))));
    const deletions = take("deletions", imported.deletions.filter((row) => !scope.archive.deletions.some((prior) => prior.deletionId === row.deletionId)));
    const events = take("events", imported.events);
    const quarantine = [...scope.archive.quarantine ?? [], ...imported.quarantine.filter((row) => !(scope.archive.quarantine ?? []).some((prior) => prior.id === row.id && prior.sourceHash === row.sourceHash && prior.reason === row.reason))];
    if (!entries.length && !deletions.length && !events.length && quarantine.length === (scope.archive.quarantine?.length ?? 0)) return { touched: imported.touched, groupIds: imported.groupIds };
    try {
      scope.archive = readArchive({ ...scope.archive, entries: [...scope.archive.entries, ...entries], deletions: [...scope.archive.deletions, ...deletions], events: [...scope.archive.events, ...events], ...(quarantine.length ? { quarantine } : {}) });
    } catch (error) {
      console.warn(`[objectives] owner ${scope.owner.commodoreId}: ${error instanceof Error ? error.message : "legacy_index_unreadable"}; original preserved`);
      for (const row of deletions) for (const id of row.objectiveIds) scope.unreadable.add(id);
      return { touched: imported.touched, groupIds: imported.groupIds };
    }
    return { touched: imported.touched, groupIds: imported.groupIds };
  }
  function readScope(owner: ObjectiveOwner): Scope {
    const existing = exists(owner.directory);
    safeDir(owner.directory);
    const groupsFile = path.join(owner.directory, "groups.json"), archiveFile = path.join(owner.directory, "archive.json");
    let groups: { groups: unknown } = { groups: [] };
    if (exists(groupsFile)) {
      try {
        const raw = readJson(groupsFile);
        if (!object(raw) || !Array.isArray(raw.groups)) throw failure();
        assertMinimal({ groups: minimalGroups(raw.groups as Group[]) });
        groups = raw as { groups: unknown };
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof ObjectiveArchiveError)) throw error;
        console.warn(`[objectives] owner ${owner.commodoreId}: groups.json unreadable; original preserved`);
      }
    }
    const scope: Scope = { owner, documents: new Map(), groups: groups.groups as Group[], archive: emptyArchive(), unreadable: new Set() };
    let persistArchive = true;
    let rebuildIndex = false;
    let loadedArchive: Archive | null = null;
    if (exists(archiveFile)) {
      const source = readBytes(archiveFile);
      const noteBroken = () => {
        preserveSource(owner, source);
        console.warn(`[objectives] owner ${owner.commodoreId}: archive.json unreadable; original preserved`);
        scope.archive = emptyArchive();
        rebuildIndex = true;
      };
      try {
        const raw: unknown = JSON.parse(source.toString("utf8"));
        const inline = object(raw) && (object(raw.transaction) || [raw.entries, raw.deletions, raw.events].some((rows) => Array.isArray(rows) && rows.some((row) => object(row) && ("objective" in row || "objectives" in row))));
        if (inline) {
          try { migrateInline(scope, raw, source); }
          catch (error) {
            persistArchive = false;
            scope.journalDeferred = true;
            deferredAliasOwners.add(owner.commodoreId);
            console.warn(`[objectives] owner ${owner.commodoreId}: ${error instanceof Error ? error.message : "archive_recovery_required"}; original preserved`);
          }
        } else { scope.archive = readArchive(raw); loadedArchive = JSON.parse(JSON.stringify(scope.archive)) as Archive; }
      } catch { noteBroken(); }
    }
    try { recover(scope); } catch (error) {
      if (scope.archive.transaction) scope.journalDeferred = true;
      deferredAliasOwners.add(owner.commodoreId);
      console.warn(`[objectives] owner ${owner.commodoreId}: ${error instanceof Error ? error.message : "archive_recovery_required"}; original preserved`);
    }
    const purgeIds = scope.archive.events.filter((row) => row.channel === "objective:purged" && !unavailable(scope, row.objectiveId)).map((row) => row.objectiveId);
    const purgeConflict = new Set(purgeIds.filter((id) => scope.archive.entries.some((row) => row.objectiveId === id) || scope.archive.deletions.some((row) => row.objectiveIds.includes(id))));
    if (purgeConflict.size) {
      console.warn(`[objectives] owner ${owner.commodoreId}: purge conflicts isolated; original preserved`);
      holdIds(scope, [...purgeConflict], "purge_conflict", "0".repeat(64));
      scope.archive = { ...scope.archive, events: scope.archive.events.filter((row) => !purgeConflict.has(row.objectiveId)) };
    }
    purgeDocuments(scope, purgeIds.filter((id) => !purgeConflict.has(id)));
    for (const id of purgeIds) if (!purgeConflict.has(id)) scope.documents.delete(id);
    readDocuments(scope, persistentHolds(scope));
    for (const id of [...scope.archive.entries.map((row) => row.objectiveId), ...scope.archive.deletions.flatMap((row) => row.objectiveIds)]) {
      if (!scope.documents.has(id) && !scope.unreadable.has(id)) scope.archive = { ...scope.archive, unavailable: [...new Set([...scope.archive.unavailable ?? [], id])] };
    }
    for (const row of scope.archive.deletions) if (row.objectiveIds.some((id) => unavailable(scope, id))) scope.archive = { ...scope.archive, unavailable: [...new Set([...scope.archive.unavailable ?? [], ...row.objectiveIds])] };
    if (rebuildIndex) holdIds(scope, [...scope.documents.keys()], "archive_unreadable", "0".repeat(64));
    const preexisting = !exists(archiveFile) && !rebuildIndex ? new Set(scope.documents.keys()) : new Set<string>();
    const importedLegacy = importLegacy(scope);
    const touched = importedLegacy.touched;
    // 원장에 그룹 id를 남기기 전에 합친 groups.json을 먼저 쓴다. 쓰기가 실패하면 그 id는 다음 기동이 다시 수입한다.
    let durableGroupIds: readonly string[] = [];
    if (importedLegacy.groupIds.length) {
      try {
        assertMinimal({ groups: minimalGroups(scope.groups) });
        writeJson(groupsFile, { groups: scope.groups });
        const onDisk = new Set(scope.groups.map((group) => group.id));
        durableGroupIds = importedLegacy.groupIds.filter((id) => onDisk.has(id));
      } catch (error) {
        console.warn(`[objectives] owner ${owner.commodoreId}: ${error instanceof Error ? error.message : "legacy_groups_unreadable"}; original preserved`);
      }
    }
    isolateOrphanDeletions(scope, owner, archiveFile);
    // rename 뒤 색인 저장 전에 끊긴 id는 pending-index에 있다. 색인 없는 기존 문서로 숨기면 재개 때 목록에서 빠진다.
    const pendingRename = readPendingIndex(owner.directory);
    for (const id of preexisting) {
      if (pendingRename.has(id)) continue;
      if (!scope.archive.entries.some((row) => row.objectiveId === id) && !scope.archive.deletions.some((row) => row.objectiveIds.includes(id))) holdIds(scope, [id], "index_missing", "0".repeat(64));
    }
    if (persistArchive) {
      // 읽은 색인과 같으면 다시 쓰지 않는다. 키 순서만 다른 정규화가 재시작마다 archive.json을 바꾸면 안 된다.
      if (!loadedArchive || !isDeepStrictEqual(loadedArchive, scope.archive)) archiveStore(scope).save(scope.archive);
      if (touched.length || durableGroupIds.length) rememberImported(owner.directory, touched, durableGroupIds);
      clearPendingIndex(owner.directory, touched);
    }
    if (!exists(groupsFile)) writeJson(groupsFile, { groups: scope.groups });
    const journals = path.join(owner.directory, ".transactions");
    if (exists(journals)) {
      safeDir(journals);
      for (const name of fs.readdirSync(journals)) if (/^[0-9a-f-]{36}\.json$/.test(name) && name !== `${scope.archive.transaction ?? ""}.json`) fs.rmSync(path.join(journals, name), { force: true });
    }
    return scope;
  }
  function assertReady(): void { if (!ready || blocked) throw failure(); }
  const retryNotBefore = new Map<string, number>();
  const retryAfterMs = 30_000;
  const failedAtLoad = new Set<string>();
  function held(scope: Scope): boolean { return scope.indexUnread === true || scope.journalDeferred === true || scope.unmerged === true; }
  function scopeOf(commodoreId: string): Scope {
    assertReady();
    if (unavailableOwners.has(commodoreId)) throw new ObjectiveArchiveError(503, "objective_owner_unavailable");
    const existing = scopes.get(commodoreId);
    const owner = deps.owners().find((entry) => entry.commodoreId === commodoreId);
    if (!owner) throw new ObjectiveArchiveError(503, "objective_owner_unavailable");
    // 일시적 읽기 실패는 재시작까지 붙잡아 두지 않는다. 간격이 지난 접근에서만 다시 읽고, 실패해도 디스크는 쓰지 않는다.
    if (existing && !(existing.indexUnread && Date.now() >= (retryNotBefore.get(commodoreId) ?? 0))) return existing;
    try {
      const scope = readScope(owner);
      // 기동 스냅샷에 없던 owner를 저장 계획에 넣으면 레지스트리가 모르는 활성 목표가 purge된다. 재시작 전까지 읽기만 한다.
      if (failedAtLoad.has(commodoreId)) scope.unmerged = true;
      scopes.set(commodoreId, scope);
      retryNotBefore.delete(commodoreId);
      return scope;
    } catch (error) {
      console.warn(`[objectives] owner ${commodoreId}: ${error instanceof Error ? error.message : "archive_recovery_required"}; original preserved`);
      retryNotBefore.set(commodoreId, Date.now() + retryAfterMs);
      if (existing?.indexUnread) return existing;
      const scope = holdDirectory(owner);
      scopes.set(commodoreId, scope);
      return scope;
    }
  }
  function encodeDeletion(row: DurableDeletionTombstone, commodoreId: string): Deletion {
    return { deletionId: row.deletionId, targetId: row.targetId, deletedAt: row.deletedAt, expiresAt: row.expiresAt,
      kind: row.kind === "theater" ? "theater" : "objective", objectiveIds: deletionObjectiveRecords(row).filter((node) => node.commodoreId === commodoreId).map((node) => node.id),
      ...(row.archived ? { archived: Object.fromEntries(Object.entries(row.archived).filter(([id]) => deletionObjectiveRecords(row).some((node) => node.id === id && node.commodoreId === commodoreId))) } : {}), ...(row.kind === "theater" ? { groups: row.groups.filter((group) => group.commodoreId === commodoreId).map(withoutOwner) } : {}),
    };
  }
  function decodeDeletion(row: Deletion, scope: Scope): DurableDeletionTombstone | null {
    const { objectiveIds, groups, kind, ...base } = row;
    const decode = (id: string) => recordOf(scope, document(scope, id));
    if (kind === "objective") return { ...base, kind: "objectiveRecord", objectiveRecord: decode(row.targetId),
      ...(objectiveIds.length > 1 ? { descendants: objectiveIds.filter((id) => id !== row.targetId).map(decode) } : {}) };
    const registration = state.deletionTombstones?.find((entry) => entry.kind === "theater" && entry.deletionId === row.deletionId);
    if (!registration || registration.kind !== "theater") return null;
    return { ...base, kind: "theater", theater: registration.theater, objectiveRecords: objectiveIds.map(decode), groups: (groups ?? []).map((group) => ({ ...group, commodoreId: scope.owner.commodoreId, theaterId: group.theaterId ?? scope.owner.legacyTheaterId })) };
  }
  function retainHeldAliases(source: Record<string, unknown>, normalized: Record<string, unknown>): Record<string, unknown> {
    const aliasHeld = (theaterId: string) => unavailableOwners.has(ownerOfTheater(theaterId) ?? "") || deferredAliasOwners.has(ownerOfTheater(theaterId) ?? "");
    if (!deps.migrateRegistrationAliases || ![...unavailableOwners, ...deferredAliasOwners].length) return normalized;
    // 보류한 owner의 저널이 더 최신 이름/해제를 담을 수 있다. 그 명부는 이관 원본으로 먼저 소비하지 않는다.
    const heldSource = { ...source,
      theaters: Array.isArray(source.theaters) ? source.theaters.filter((row) => object(row) && aliasHeld(String(row.id))) : [],
      deletionTombstones: Array.isArray(source.deletionTombstones) ? source.deletionTombstones.filter((row) => object(row) && aliasHeld(String(row.targetId))) : [],
    };
    return retainRegistrationAliases(heldSource, normalized);
  }
  function stripCommittedAliases(source: Record<string, unknown>, committed: ReadonlySet<string>): Record<string, unknown> {
    if (!committed.size) return source;
    let changed = false;
    const clean = (value: unknown, id: string): unknown => {
      if (!committed.has(id) || !object(value) || !Object.hasOwn(value, "alias")) return value;
      changed = true;
      const { alias: _alias, ...rest } = value;
      return rest;
    };
    const theaters = Array.isArray(source.theaters) ? source.theaters.map((row) => object(row) ? clean(row, String(row.id)) : row) : source.theaters;
    const deletionTombstones = Array.isArray(source.deletionTombstones) ? source.deletionTombstones.map((row) => {
      if (!object(row) || row.kind !== "theater") return row;
      const theater = clean(row.theater, String(row.targetId));
      return theater === row.theater ? row : { ...row, theater };
    }) : source.deletionTombstones;
    return changed ? { ...source, ...(Array.isArray(theaters) ? { theaters } : {}), ...(Array.isArray(deletionTombstones) ? { deletionTombstones } : {}) } : source;
  }
  function ownerTheaterIds(owner: ObjectiveOwner): readonly string[] {
    return [owner.legacyTheaterId, ...(owner.legacyTheaterIds ?? [])];
  }
  function ownerOfTheater(theaterId: string): string | undefined {
    return deps.owners().find((owner) => ownerTheaterIds(owner).includes(theaterId))?.commodoreId;
  }
  function heldTheaters(): Set<string> {
    const held = new Set(deps.owners().filter((owner) => unavailableOwners.has(owner.commodoreId)).flatMap((owner) => ownerTheaterIds(owner)));
    for (const scope of scopes.values()) {
      for (const row of scope.archive.quarantine ?? []) if (row.location.includes("deletions[")) {
        if (row.theaterId) held.add(row.theaterId);
        else {
          held.add(scope.owner.legacyTheaterId);
          for (const doc of scope.documents.values()) held.add(scope.owner.theaterIdOf(doc.cwd as string));
        }
      }
      for (const row of scope.archive.deletions) if (row.kind === "theater" && row.objectiveIds.some((id) => unavailable(scope, id))) held.add(row.targetId);
    }
    return held;
  }
  function registrationState(next: DurableConsoleState): DurableConsoleState {
    // 더 오래된 원본과 격리된 Theater의 등록은 승계하거나 정리하지 않고 그대로 남긴다.
    const held = heldTheaters();
    const untouched = Array.isArray(previousRaw.deletionTombstones) ? previousRaw.deletionTombstones.filter((row) => {
      if (!object(row)) return true;
      const node = row.objectiveRecord ?? row.operation;
      const owner = row.kind === "theater" ? row.targetId : object(node) ? node.theaterId : undefined;
      return typeof owner !== "string" || !scopes.has(object(node) && typeof node.commodoreId === "string" ? node.commodoreId : ownerOfTheater(owner) ?? "") || held.has(owner);
    }) : [];
    const deletions = [...(next.deletionTombstones ?? []).filter((row) => row.kind === "theater" && !held.has(row.targetId)).map((row) => {
      const { objectiveRecords: _records, groups: _groups, ...registration } = row as Extract<DurableDeletionTombstone, { kind: "theater" }>; return registration;
    }), ...untouched];
    const { deletionTombstones: _deletions, theaters: _theaters, ...original } = previousRaw;
    return retainHeldAliases(previousRaw, { ...original, version: STATE_VERSION, theaters: next.theaters, ...(deletions.length ? { deletionTombstones: deletions } : {}) }) as unknown as DurableConsoleState;
  }
  function snapshot(): DurableConsoleState {
    const objectiveRecords: ObjectiveRecord[] = [], groups: DurableObjectiveGroup[] = [], deletions: DurableDeletionTombstone[] = [];
    for (const scope of scopes.values()) {
      const hidden = inactive(scope);
      for (const doc of scope.documents.values()) if (!doc.pending && !hidden.has(doc.id)) objectiveRecords.push(recordOf(scope, doc));
      groups.push(...scope.groups.map((group) => ({ ...group, commodoreId: scope.owner.commodoreId, theaterId: group.theaterId ?? scope.owner.legacyTheaterId })));
      for (const row of scope.archive.deletions.filter((row) => !row.objectiveIds.some((id) => unavailable(scope, id)))) {
        try { const decoded = decodeDeletion(row, scope); if (decoded) deletions.push(decoded); }
        catch (error) { console.warn(`[objectives] ${row.deletionId}: ${error instanceof Error ? error.message : "deletion_unreadable"}; original preserved`); }
      }
    }
    const merged = new Map<string, DurableDeletionTombstone>();
    for (const row of deletions) {
      const prior = merged.get(row.deletionId);
      merged.set(row.deletionId, row.kind === "theater" && prior?.kind === "theater"
        ? { ...row, objectiveRecords: [...prior.objectiveRecords, ...row.objectiveRecords], groups: [...prior.groups, ...row.groups], archived: { ...prior.archived, ...row.archived } } : row);
    }
    const tombstones = [...merged.values()];
    validateLocations(objectiveRecords, entries(), tombstones);
    return { version: STATE_VERSION, theaters: state.theaters, objectiveRecords, groups, deletionTombstones: tombstones };
  }
  function entries(): readonly ArchivedObjective[] {
    assertReady();
    return [...scopes.values()].flatMap((scope) => scope.archive.entries.filter((row) => !unavailable(scope, row.objectiveId)).map(({ objectiveId, ...rest }) => ({ ...rest, objectiveRecord: recordOf(scope, document(scope, objectiveId)) })));
  }
  function events(): readonly ArchiveLifecycleEvent[] {
    assertReady();
    return [...scopes.values()].flatMap((scope) => scope.archive.events.filter((row) => !unavailable(scope, row.objectiveId)).map((row) => {
      const doc = scope.documents.get(row.objectiveId);
      return { ...row, commodoreId: scope.owner.commodoreId, theaterId: row.theaterId ?? (doc ? scope.owner.theaterIdOf(doc.cwd as string) : scope.owner.legacyTheaterId),
        ...(row.channel === "objective:restored" && doc && !inactive(scope).has(doc.id) ? { objectiveRecord: recordOf(scope, doc) } : {}),
      };
    }));
  }
  function save(next: DurableConsoleState, archived: readonly ArchivedObjective[] = entries(), eventRows: readonly ArchiveLifecycleEvent[] = []): void {
    assertReady();
    validateLocations(next.objectiveRecords, archived, next.deletionTombstones ?? []);
    // 격리한 삭제 기록은 등록과 함께 바꿀 수 없다. prepare 전에 거절해 호출자가 메모리도 되돌리게 한다.
    for (const theaterId of heldTheaters()) {
      const before = [...new Set([...scopes.values()].flatMap((scope) => scope.archive.deletions.filter((row) => row.kind === "theater" && row.targetId === theaterId && !row.objectiveIds.some((id) => unavailable(scope, id))).map((row) => row.deletionId)))].sort();
      const after = (next.deletionTombstones ?? []).filter((row) => row.kind === "theater" && row.targetId === theaterId).map((row) => row.deletionId).sort();
      if (state.theaters.some((row) => row.id === theaterId) !== next.theaters.some((row) => row.id === theaterId) || !isDeepStrictEqual(before, after)) {
        throw new ObjectiveArchiveError(409, "objective_owner_recovery_required");
      }
    }
    for (const id of new Set([...next.objectiveRecords.map((node) => node.commodoreId), ...(next.groups ?? []).map((group) => group.commodoreId), ...archived.map((entry) => entry.objectiveRecord.commodoreId), ...(next.deletionTombstones ?? []).flatMap((row) => [...deletionObjectiveRecords(row).map((node) => node.commodoreId), ...(row.kind === "theater" ? [ownerOfTheater(row.targetId)].filter((id): id is string => !!id) : [])])])) scopeOf(id);
    const registration = registrationState(next);
    for (const scope of scopes.values()) if (held(scope) && (next.objectiveRecords.some((node) => node.commodoreId === scope.owner.commodoreId) || (next.groups ?? []).some((group) => group.commodoreId === scope.owner.commodoreId) || archived.some((entry) => entry.objectiveRecord.commodoreId === scope.owner.commodoreId) || (next.deletionTombstones ?? []).some((row) => row.kind === "theater" ? row.targetId === scope.owner.legacyTheaterId || deletionObjectiveRecords(row).some((node) => node.commodoreId === scope.owner.commodoreId) : row.objectiveRecord.commodoreId === scope.owner.commodoreId))) console.warn(`[objectives] owner ${scope.owner.commodoreId}: objective_owner_recovery_required; original preserved`);
    const plans = [...scopes.values()].filter((scope) => !held(scope)).map((scope) => {
      const commodoreId = scope.owner.commodoreId;
      const documents = new Map([...scope.documents].filter(([, doc]) => doc.pending && !unavailable(scope, doc.id)));
      const retain = (node: ObjectiveRecord) => {
        if (unavailable(scope, node.id) || node.sessions?.some((child) => unavailable(scope, child.id))) throw failure();
        documents.set(node.id, readDocument(documentFromObjective(node, scope.documents.get(node.id)), scope.owner));
      };
      for (const node of next.objectiveRecords.filter((node) => node.commodoreId === commodoreId)) retain(node);
      const archiveEntries = [...scope.archive.entries.filter((row) => unavailable(scope, row.objectiveId)), ...archived.filter((entry) => entry.objectiveRecord.commodoreId === commodoreId).map(({ objectiveRecord, ...rest }) => {
        retain(objectiveRecord); return { ...rest, objectiveId: objectiveRecord.id };
      })];
      const deletions = (next.deletionTombstones ?? []).filter((row) => row.kind === "theater" ? row.targetId === scope.owner.legacyTheaterId || row.objectiveRecords.some((node) => node.commodoreId === commodoreId) || row.groups.some((group) => group.commodoreId === commodoreId) : row.objectiveRecord.commodoreId === commodoreId);
      for (const row of deletions) for (const node of deletionObjectiveRecords(row)) if (node.commodoreId === commodoreId) retain(node);
      const archive: Archive = readArchive({ revision: scope.archive.revision + (isDeepStrictEqual(archiveEntries, scope.archive.entries) ? 0 : 1), entries: archiveEntries,
        deletions: [...scope.archive.deletions.filter((row) => row.objectiveIds.some((id) => unavailable(scope, id))), ...deletions.map((row) => encodeDeletion(row, commodoreId))],
        events: [...scope.archive.events, ...eventRows.filter((row) => row.commodoreId === commodoreId).map(eventIndex)],
        ...(scope.archive.unavailable?.length ? { unavailable: scope.archive.unavailable } : {}),
        ...(scope.archive.quarantine?.length ? { quarantine: scope.archive.quarantine } : {}),
      });
      const knownIds = new Set([
        ...baseline.objectiveRecords.filter((node) => node.commodoreId === commodoreId).map((node) => node.id),
        ...(baseline.deletionTombstones ?? []).flatMap((row) => deletionObjectiveRecords(row).filter((node) => node.commodoreId === commodoreId).map((node) => node.id)),
        ...scope.archive.entries.map((row) => row.objectiveId),
        ...scope.archive.deletions.flatMap((row) => row.objectiveIds),
      ]);
      const knownGroupIds = new Set((baseline.groups ?? []).filter((group) => group.commodoreId === commodoreId).map((group) => group.id));
      const nextGroups = (next.groups ?? []).filter((group) => group.commodoreId === commodoreId).map(withoutOwner);
      const transaction: Transaction = { documents: [...documents.values()],
        groups: [...nextGroups, ...scope.groups.filter((group) => !knownGroupIds.has(group.id) && !nextGroups.some((nextGroup) => nextGroup.id === group.id))],
        archive, state: registration,
        purgeIds: [...scope.documents.keys()].filter((id) => !documents.has(id) && !unavailable(scope, id) && knownIds.has(id)) };
      return { scope, transaction, id: "" };
    }).filter(({ scope, transaction }) => {
      // 읽기에서 복구한 cwd·행위자는 메모리 뷰다. 다른 owner의 저장이 원문 확정 쓰기가 되면 안 된다.
      // 동일한 writer 투영끼리 비교해 옛 직렬화 모양이나 문서 순서만 다른 scope도 건너뛴다.
      const previous = new Map([...scope.documents].filter(([id]) => !unavailable(scope, id)).map(([id, doc]) => [id,
        doc.pending ? doc : readDocument(documentFromObjective(recordOf(scope, doc), doc), scope.owner),
      ]));
      const groups = scope.groups.map((group) => ({ ...group, theaterId: group.theaterId ?? scope.owner.legacyTheaterId }));
      return transaction.purgeIds.length > 0 || !isDeepStrictEqual(previous, new Map(transaction.documents.map((doc) => [doc.id, doc])))
        || !isDeepStrictEqual(groups, transaction.groups) || !isDeepStrictEqual(scope.archive, transaction.archive);
    });
    try {
      // owner별 prepare → 등록 → apply → finalize 의미는 유지한다. 본문은 별도 일시 저널에만 담는다.
      for (const plan of plans) plan.id = prepare(plan.scope, plan.transaction);
      deps.stateStore.save(registration);
      for (const { scope, transaction, id } of plans) apply(scope, transaction, id);
      state = next;
      baseline = next;
    } catch (error) { blocked = true; throw error; }
  }
  function acknowledgeEvents(ids: readonly string[]): void {
    assertReady(); const consumed = new Set(ids);
    try {
      for (const scope of scopes.values()) {
        if (held(scope)) continue;
        const archive = { ...scope.archive, events: scope.archive.events.filter((event) => !consumed.has(event.eventId)) };
        if (isDeepStrictEqual(scope.archive, archive)) continue;
        archiveStore(scope).save(archive); scope.archive = archive;
      }
    } catch (error) { blocked = true; throw error; }
  }
  const board: ObjectiveBoardStorage = {
    owners: () => deps.owners().filter((owner) => !unavailableOwners.has(owner.commodoreId)),
    unavailable: (id) => isReserved(id),
    forget(commodoreId, id) {
      const scope = scopeOf(commodoreId);
      if (held(scope)) throw new ObjectiveArchiveError(409, "objective_owner_recovery_required");
      if (unavailable(scope, id) || scope.archive.entries.some((row) => row.objectiveId === id) || scope.archive.deletions.some((row) => row.objectiveIds.includes(id))) throw failure();
      const doc = scope.documents.get(id);
      if (doc && !doc.pending) throw failure();
      purgeDocuments(scope, [id]); scope.documents.delete(id);
    },
    directory(commodoreId) { try { return scopeOf(commodoreId).owner.directory; } catch { return null; } },
    list(commodoreId) { const scope = scopeOf(commodoreId); return [...scope.documents.values()].filter((doc) => !unavailable(scope, doc.id)).map((doc) => boardFromDocument(doc, scope.owner)); },
    save(commodoreId, value) {
      const scope = scopeOf(commodoreId), previous = scope.documents.get(value.id);
      if (held(scope)) throw new ObjectiveArchiveError(409, "objective_owner_recovery_required");
      if (unavailable(scope, value.id) || (!previous && !value.pending) || scope.archive.events.some((row) => row.channel === "objective:purged" && row.objectiveId === value.id)) throw failure();
      const doc = readDocument(documentFromBoard(value, previous), scope.owner);
      writeJson(path.join(objectiveDir(scope, doc.id), "objective.json"), doc); scope.documents.set(doc.id, doc);
    },
  };
  function load(): DurableConsoleState {
    try {
      const raw = exists(deps.stateStore.path) ? readJson(deps.stateStore.path) : { version: STATE_VERSION, theaters: [] };
      if (!object(raw)) throw failure();
      failedAtLoad.clear();
      previousRaw = raw; state = readRegistrations(raw, !!deps.migrateRegistrationAliases);
      deps.initializeOwners?.(readRegistrations(state));
      const failedOwners = new Set<string>();
      for (const owner of deps.owners()) {
        try { const scope = readScope(owner); scopes.set(owner.commodoreId, scope); }
        catch (error) {
          failedOwners.add(owner.commodoreId);
          failedAtLoad.add(owner.commodoreId);
          console.warn(`[objectives] owner ${owner.commodoreId}: ${error instanceof Error ? error.message : "archive_recovery_required"}; original preserved`);
        }
      }
      // objectives-migration.json은 앞선 위치 이동의 기록이다. 읽거나 고쳐 이주 연쇄를 재개하지 않는다.
      // 별칭 이주는 별개다. 커밋한 항목만 명부에서 거둔다. 이번 기동에 복구가 끝난 owner만 거둔다.
      if (deps.migrateRegistrationAliases) {
        const aliases = legacyTheaterAliases(state as unknown as Record<string, unknown>).filter((entry) => {
          const owner = ownerOfTheater(entry.theaterId) ?? "";
          return !failedOwners.has(owner) && !unavailableOwners.has(owner) && !deferredAliasOwners.has(owner);
        });
        let committed = new Set<string>();
        try {
          const result = deps.migrateRegistrationAliases(aliases);
          committed = new Set(result ?? aliases.map((entry) => entry.theaterId));
        } catch (error) { console.warn(`[objectives] alias migration: ${error instanceof Error ? error.message : "alias_migration_failed"}; aliases retained`); }
        try {
          if (exists(deps.stateStore.path)) {
            const current = readJson(deps.stateStore.path);
            if (!object(current)) throw failure();
            const cleaned = stripCommittedAliases(current, committed);
            if (cleaned !== current) deps.stateStore.save(cleaned as unknown as DurableConsoleState);
          }
          previousRaw = stripCommittedAliases(previousRaw, committed);
          state = readRegistrations(state);
        } catch (error) { console.warn(`[objectives] alias migration: ${error instanceof Error ? error.message : "alias_cleanup_failed"}; aliases retained`); }
      }
      ready = true; blocked = false;
      baseline = snapshot();
      return baseline;
    } catch (error) { blocked = true; throw error instanceof SyntaxError ? failure() : error; }
  }
  function isReserved(id: string): boolean {
    return [...scopes.values()].some((scope) => unavailable(scope, id) || scope.archive.events.some((event) => event.channel === "objective:purged" && (event.objectiveId === id || event.sessionIds.includes(id))));
  }
  function ownerRecoveryRequired(commodoreId: string): boolean {
    try { return held(scopeOf(commodoreId)); } catch { return false; }
  }
  return { load, save, assertReady, entries, events, acknowledgeEvents, board, isReserved, ownerRecoveryRequired, revision: () => [...scopes.values()].reduce((sum, scope) => sum + scope.archive.revision, 0), blocked: () => blocked };
}

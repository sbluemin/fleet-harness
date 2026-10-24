import { legacyTheaterAliases, retainRegistrationAliases, withoutTheaterAliases, type LegacyTheaterAlias } from "../../workspace/host/registration-migration.js";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createDurableJsonStore, ensureSafeDirectory, NOFOLLOW_FLAG, type DurableJsonStore } from "@fleet-console/infra";
import { resolveWorkspaceDirectory } from "@fleet-console/infra/workspace-dir";
import type { ObjectiveRecord } from "./records/objective-records-domain.js";
import { STATE_VERSION, sanitizeDurableConsoleState, deletionObjectiveRecords, type DurableConsoleState, type DurableDeletionTombstone, type DurableObjectiveGroup } from "../../workspace/host/durable-state.js";
import { ObjectiveArchiveError, validateLocations, type ArchivedObjective, type ArchiveLifecycleEvent } from "../../workspace/host/objective-archive-storage.js";
import type { StoredObjective } from "../shared/types.js";
import { assertMinimal, boardFromDocument, documentFromBoard, documentFromObjective, object, objectiveRecordFromDocument, normalizeObjectiveDocument, type ObjectiveDocumentContext, type ObjectiveDocument } from "./storage-codec.js";

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
interface Scope { owner: ObjectiveOwner; documents: Map<string, ObjectiveDocument>; groups: readonly Group[]; archive: Archive }
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
function unavailable(scope: Scope, id: string): boolean { return scope.archive.unavailable?.includes(id) ?? false; }
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
  /** 복구한 명부의 별칭을 소유 저장소에 커밋한다. 실패하면 별칭을 지우지 않고 기동을 중단한다. */
  migrateRegistrationAliases?: (entries: readonly LegacyTheaterAlias[]) => void;
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
  let previousRaw: Record<string, unknown> = {};
  const unavailableOwners = new Set<string>();
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
  function readDocuments(scope: Scope): void {
    for (const entry of fs.readdirSync(scope.owner.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || unavailable(scope, entry.name)) continue;
      const file = path.join(objectiveDir(scope, entry.name), "objective.json");
      if (!exists(file)) continue;
      try {
        const doc = readDocument(readJson(file), scope.owner);
        if (doc.id !== entry.name) throw failure();
        scope.documents.set(doc.id, doc);
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof ObjectiveArchiveError) && !(error instanceof Error && /^(objective_actor|objective_owner|objective_location|invalid_objective)/.test(error.message))) throw error;
        // 참조 중인 원본도 지우거나 빈 본문으로 바꾸지 않는다. 해당 목표만 격리한다.
        scope.archive = { ...scope.archive, unavailable: [...new Set([...scope.archive.unavailable ?? [], entry.name])] };
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
    readDocuments(scope);
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
    archive = { ...archive, ...(conflicted.size ? { unavailable: [...conflicted] } : {}) };
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
  function readScope(owner: ObjectiveOwner): Scope {
    const existing = exists(owner.directory);
    safeDir(owner.directory);
    const groupsFile = path.join(owner.directory, "groups.json"), archiveFile = path.join(owner.directory, "archive.json");
    if (existing && (!exists(groupsFile) || !exists(archiveFile))) throw failure();
    const groups = exists(groupsFile) ? readJson(groupsFile) : { groups: [] };
    if (!object(groups) || !Array.isArray(groups.groups)) throw failure();
    assertMinimal({ groups: minimalGroups(groups.groups as Group[]) });
    const scope: Scope = { owner, documents: new Map(), groups: groups.groups as Group[], archive: emptyArchive() };
    if (exists(archiveFile)) {
      const source = readBytes(archiveFile);
      try {
        const raw: unknown = JSON.parse(source.toString("utf8"));
        const inline = object(raw) && (object(raw.transaction) || [raw.entries, raw.deletions, raw.events].some((rows) => Array.isArray(rows) && rows.some((row) => object(row) && ("objective" in row || "objectives" in row))));
        if (inline) migrateInline(scope, raw, source);
        else scope.archive = readArchive(raw);
      } catch (error) {
        const sourceHash = preserveSource(owner, source);
        const quarantineFile = path.join(owner.directory, ".archive-migration", `${sourceHash}.quarantine.json`);
        if (!exists(quarantineFile)) writeJson(quarantineFile, [
          { id: null, sourceHash, location: "archive.json", reason: "owner_recovery_required" },
        ]);
        throw error;
      }
    }
    recover(scope);
    const purgeIds = scope.archive.events.filter((row) => row.channel === "objective:purged" && !unavailable(scope, row.objectiveId)).map((row) => row.objectiveId);
    if (purgeIds.some((id) => scope.archive.entries.some((row) => row.objectiveId === id) || scope.archive.deletions.some((row) => row.objectiveIds.includes(id)))) throw failure();
    purgeDocuments(scope, purgeIds);
    for (const id of purgeIds) scope.documents.delete(id);
    readDocuments(scope);
    for (const id of [...scope.archive.entries.map((row) => row.objectiveId), ...scope.archive.deletions.flatMap((row) => row.objectiveIds)]) {
      if (!scope.documents.has(id)) scope.archive = { ...scope.archive, unavailable: [...new Set([...scope.archive.unavailable ?? [], id])] };
    }
    for (const row of scope.archive.deletions) if (row.objectiveIds.some((id) => unavailable(scope, id))) scope.archive = { ...scope.archive, unavailable: [...new Set([...scope.archive.unavailable ?? [], ...row.objectiveIds])] };
    // 이미 어긋난 Theater 삭제도 행 단위로 격리한다. snapshot의 decode가 Console 전체를 막지 않는다.
    const orphans = scope.archive.deletions.flatMap((row, index) => row.kind === "theater"
      && (!state.deletionTombstones?.some((entry) => entry.kind === "theater" && entry.targetId === row.targetId && entry.deletionId === row.deletionId)) ? [{ row, index }] : []);
    if (orphans.length) {
      const sourceHash = preserveSource(owner, readBytes(archiveFile));
      const rejected = new Set(orphans.map(({ row }) => row));
      scope.archive = { ...scope.archive,
        deletions: scope.archive.deletions.filter((row) => !rejected.has(row)),
        unavailable: [...new Set([...scope.archive.unavailable ?? [], ...orphans.flatMap(({ row }) => row.objectiveIds)])],
        quarantine: [...scope.archive.quarantine ?? [], ...orphans.map(({ row, index }) => ({ id: row.targetId, sourceHash, location: `deletions[${index}]`, reason: "missing_theater_registration", theaterId: row.targetId }))],
      };
    }
    // 소유자 하나의 충돌은 다른 목표의 정상 저장을 막지 않는다. 격리 ID는 재기동에도 예약한다.
    archiveStore(scope).save(scope.archive);
    if (!existing) writeJson(groupsFile, { groups: [] });
    const journals = path.join(owner.directory, ".transactions");
    if (exists(journals)) {
      safeDir(journals);
      for (const name of fs.readdirSync(journals)) if (/^[0-9a-f-]{36}\.json$/.test(name)) fs.rmSync(path.join(journals, name), { force: true });
    }
    return scope;
  }
  function assertReady(): void { if (!ready || blocked) throw failure(); }
  function scopeOf(commodoreId: string): Scope {
    assertReady();
    if (unavailableOwners.has(commodoreId)) throw new ObjectiveArchiveError(503, "objective_owner_unavailable");
    const existing = scopes.get(commodoreId);
    if (existing) return existing;
    const owner = deps.owners().find((entry) => entry.commodoreId === commodoreId);
    if (!owner || olderSource(owner)) throw new ObjectiveArchiveError(503, "objective_owner_unavailable");
    const scope = readScope(owner); scopes.set(commodoreId, scope); return scope;
  }
  function encodeDeletion(row: DurableDeletionTombstone, commodoreId: string): Deletion {
    return { deletionId: row.deletionId, targetId: row.targetId, deletedAt: row.deletedAt, expiresAt: row.expiresAt,
      kind: row.kind === "theater" ? "theater" : "objective", objectiveIds: deletionObjectiveRecords(row).filter((node) => node.commodoreId === commodoreId).map((node) => node.id),
      ...(row.archived ? { archived: Object.fromEntries(Object.entries(row.archived).filter(([id]) => deletionObjectiveRecords(row).some((node) => node.id === id && node.commodoreId === commodoreId))) } : {}), ...(row.kind === "theater" ? { groups: row.groups.filter((group) => group.commodoreId === commodoreId).map(withoutOwner) } : {}),
    };
  }
  function decodeDeletion(row: Deletion, scope: Scope): DurableDeletionTombstone {
    const { objectiveIds, groups, kind, ...base } = row;
    const decode = (id: string) => recordOf(scope, document(scope, id));
    if (kind === "objective") return { ...base, kind: "objectiveRecord", objectiveRecord: decode(row.targetId),
      ...(objectiveIds.length > 1 ? { descendants: objectiveIds.filter((id) => id !== row.targetId).map(decode) } : {}) };
    const registration = state.deletionTombstones?.find((entry) => entry.kind === "theater" && entry.deletionId === row.deletionId);
    if (!registration || registration.kind !== "theater") throw failure();
    return { ...base, kind: "theater", theater: registration.theater, objectiveRecords: objectiveIds.map(decode), groups: (groups ?? []).map((group) => ({ ...group, commodoreId: scope.owner.commodoreId, theaterId: group.theaterId ?? scope.owner.legacyTheaterId })) };
  }
  function retainHeldAliases(source: Record<string, unknown>, normalized: Record<string, unknown>): Record<string, unknown> {
    if (!deps.migrateRegistrationAliases || !unavailableOwners.size) return normalized;
    // 보류한 owner의 저널이 더 최신 이름/해제를 담을 수 있다. 그 명부는 이관 원본으로 먼저 소비하지 않는다.
    const heldSource = { ...source,
      theaters: Array.isArray(source.theaters) ? source.theaters.filter((row) => object(row) && unavailableOwners.has(ownerOfTheater(String(row.id)) ?? "")) : [],
      deletionTombstones: Array.isArray(source.deletionTombstones) ? source.deletionTombstones.filter((row) => object(row) && unavailableOwners.has(ownerOfTheater(String(row.targetId)) ?? "")) : [],
    };
    return retainRegistrationAliases(heldSource, normalized);
  }
  function cleanMigratedAliases(source: Record<string, unknown>): Record<string, unknown> {
    const cleaned = retainHeldAliases(source, withoutTheaterAliases(source));
    return isDeepStrictEqual(source, cleaned) ? source : cleaned;
  }
  function ownerOfTheater(theaterId: string): string | undefined {
    return deps.owners().find((owner) => owner.legacyTheaterId === theaterId)?.commodoreId;
  }
  function heldTheaters(): Set<string> {
    const held = new Set(deps.owners().filter((owner) => unavailableOwners.has(owner.commodoreId)).map((owner) => owner.legacyTheaterId));
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
      deletions.push(...scope.archive.deletions.filter((row) => !row.objectiveIds.some((id) => unavailable(scope, id))).map((row) => decodeDeletion(row, scope)));
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
    const plans = [...scopes.values()].map((scope) => {
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
      const transaction: Transaction = { documents: [...documents.values()], groups: (next.groups ?? []).filter((group) => group.commodoreId === commodoreId).map(withoutOwner), archive, state: registration,
        purgeIds: [...scope.documents.keys()].filter((id) => !documents.has(id) && !unavailable(scope, id)) };
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
    } catch (error) { blocked = true; throw error; }
  }
  function acknowledgeEvents(ids: readonly string[]): void {
    assertReady(); const consumed = new Set(ids);
    try {
      for (const scope of scopes.values()) {
        const archive = { ...scope.archive, events: scope.archive.events.filter((event) => !consumed.has(event.eventId)) };
        archiveStore(scope).save(archive); scope.archive = archive;
      }
    } catch (error) { blocked = true; throw error; }
  }
  const board: ObjectiveBoardStorage = {
    owners: () => deps.owners().filter((owner) => !unavailableOwners.has(owner.commodoreId)),
    unavailable: (id) => isReserved(id),
    forget(commodoreId, id) {
      const scope = scopeOf(commodoreId);
      if (unavailable(scope, id) || scope.archive.entries.some((row) => row.objectiveId === id) || scope.archive.deletions.some((row) => row.objectiveIds.includes(id))) throw failure();
      const doc = scope.documents.get(id);
      if (doc && !doc.pending) throw failure();
      purgeDocuments(scope, [id]); scope.documents.delete(id);
    },
    directory(commodoreId) { try { return scopeOf(commodoreId).owner.directory; } catch { return null; } },
    list(commodoreId) { const scope = scopeOf(commodoreId); return [...scope.documents.values()].filter((doc) => !unavailable(scope, doc.id)).map((doc) => boardFromDocument(doc, scope.owner)); },
    save(commodoreId, value) {
      const scope = scopeOf(commodoreId), previous = scope.documents.get(value.id);
      if (unavailable(scope, value.id) || (!previous && !value.pending) || scope.archive.events.some((row) => row.channel === "objective:purged" && row.objectiveId === value.id)) throw failure();
      const doc = readDocument(documentFromBoard(value, previous), scope.owner);
      writeJson(path.join(objectiveDir(scope, doc.id), "objective.json"), doc); scope.documents.set(doc.id, doc);
    },
  };
  function olderSource(owner: ObjectiveOwner): boolean {
    // 현재 owner가 직전 위치의 권위다. 옛 정리가 미뤄졌더라도 그 원본은 읽거나 지우지 않는다.
    if (exists(owner.directory)) return false;
    // 옛 위치만 남아 있으면 이주하거나 순회하지 않고 빈 owner 발급도 막는다.
    if (exists(path.join(resolveWorkspaceDirectory(deps.directory, owner.legacyCwd).path, "objectives"))) return true;
    const oldRows = [previousRaw.operations, previousRaw.objectiveRecords, previousRaw.groups].flatMap((rows) => Array.isArray(rows) ? rows : rows === undefined ? [] : [rows]);
    if (oldRows.some((row) => !object(row) || typeof row.theaterId !== "string" || row.theaterId === owner.legacyTheaterId)
      || state.deletionTombstones?.some((row) => row.kind === "objectiveRecord" ? row.objectiveRecord.theaterId === owner.legacyTheaterId : row.targetId === owner.legacyTheaterId && row.objectiveRecords.length > 0)) return true;
    const oldArchive = path.join(deps.directory, "operations-archive.json");
    if (!exists(oldArchive)) return false;
    // 이전 reader를 재도입하지 않는다. 소유 맥락만 확인하며, 불명확한 공유 원본은 보수적으로 막는다.
    try {
      const raw = readJson(oldArchive);
      if (!object(raw)) return true;
      const owners = new Set<string>();
      const contexts = (value: unknown): void => {
        if (Array.isArray(value)) { value.forEach(contexts); return; }
        if (!object(value)) return;
        if (typeof value.theaterId === "string") owners.add(value.theaterId);
        if (value.kind === "theater" && typeof value.targetId === "string") owners.add(value.targetId);
        for (const key of ["entries", "events", "deletions", "transaction", "state", "archive", "operations", "objectiveRecords", "deletionTombstones", "operation", "objectiveRecord", "descendants"]) contexts(value[key]);
      };
      contexts(raw);
      return !owners.size || owners.has(owner.legacyTheaterId);
    } catch { return true; }
  }
  function load(): DurableConsoleState {
    try {
      const raw = exists(deps.stateStore.path) ? readJson(deps.stateStore.path) : { version: STATE_VERSION, theaters: [] };
      if (!object(raw)) throw failure();
      previousRaw = raw; state = readRegistrations(raw, !!deps.migrateRegistrationAliases);
      deps.initializeOwners?.(readRegistrations(state));
      for (const owner of deps.owners()) {
        try {
          if (olderSource(owner)) throw new ObjectiveArchiveError(503, "older_source_requires_recovery");
          const scope = readScope(owner); scopes.set(owner.commodoreId, scope);
        } catch {
          unavailableOwners.add(owner.commodoreId);
          console.warn(`[objectives] owner ${owner.commodoreId}: recovery required; original preserved`);
        }
      }
      // objectives-migration.json은 앞선 위치 이동의 기록이다. 읽거나 고쳐 이주 연쇄를 재개하지 않는다.
      // 별칭 이주는 별개다. owner 저널에서 복구한 새 이름·해제를 대상에 커밋한 뒤 명부에서 거둔다.
      if (deps.migrateRegistrationAliases) {
        deps.migrateRegistrationAliases(legacyTheaterAliases(state as unknown as Record<string, unknown>).filter((entry) => !unavailableOwners.has(ownerOfTheater(entry.theaterId) ?? "")));
        if (exists(deps.stateStore.path)) {
          const current = readJson(deps.stateStore.path);
          if (!object(current)) throw failure();
          const cleaned = cleanMigratedAliases(current);
          if (cleaned !== current) deps.stateStore.save(cleaned as unknown as DurableConsoleState);
        }
        previousRaw = cleanMigratedAliases(previousRaw);
        state = readRegistrations(state);
      }
      ready = true; blocked = false;
      return snapshot();
    } catch (error) { blocked = true; throw error instanceof SyntaxError ? failure() : error; }
  }
  function isReserved(id: string): boolean {
    return [...scopes.values()].some((scope) => unavailable(scope, id) || scope.archive.events.some((event) => event.channel === "objective:purged" && (event.objectiveId === id || event.sessionIds.includes(id))));
  }
  return { load, save, assertReady, entries, events, acknowledgeEvents, board, isReserved, revision: () => [...scopes.values()].reduce((sum, scope) => sum + scope.archive.revision, 0), blocked: () => blocked };
}

import { predecessorStateHash } from "./predecessor-hash.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDurableJsonStore, ensureSafeDirectory, NOFOLLOW_FLAG, type DurableJsonStore } from "@fleet-console/infra";
import { resolveWorkspaceDirectory } from "@fleet-console/infra/workspace-dir";
import type { ObjectiveRecord } from "./records/objective-records-domain.js";
import { STATE_VERSION, sanitizeDurableConsoleState, deletionObjectiveRecords, type DurableConsoleState, type DurableDeletionTombstone, type DurableObjectiveGroup } from "../../workspace/host/durable-state.js";
import { ObjectiveArchiveError, readArchiveDocument, validateLocations, type ArchivedObjective, type ArchiveLifecycleEvent } from "../../workspace/host/objective-archive-storage.js";
import type { StoredObjective } from "../shared/types.js";
import { assertMinimal, boardFromDocument, documentFromBoard, documentFromObjective, object, objectiveRecordFromDocument, type ObjectiveDocument } from "./storage-codec.js";

export interface ObjectiveOwner { readonly directory: string; readonly theaterId: string; readonly workspacePath: string }
export interface ObjectiveBoardStorage {
  directory(theaterId: string): string | null;
  list(theaterId: string): readonly StoredObjective[];
  save(theaterId: string, board: StoredObjective): void;
  forget(theaterId: string, id: string): void;
}
type Group = Omit<DurableObjectiveGroup, "theaterId">;
interface Deletion {
  deletionId: string; targetId: string; deletedAt: number; expiresAt: number;
  kind: "objective" | "theater";
  objective?: ObjectiveDocument;
  objectives?: readonly ObjectiveDocument[];
  groups?: readonly Group[];
  archived?: DurableDeletionTombstone["archived"];
}
interface Archive {
  revision: number;
  entries: readonly { archiveId: string; archivedAt: number; objective: ObjectiveDocument }[];
  deletions: readonly Deletion[];
  events: readonly { eventId: string; channel: ArchiveLifecycleEvent["channel"]; objective: ObjectiveDocument }[];
  transaction?: { documents: readonly ObjectiveDocument[]; groups: readonly Group[]; archive: Archive; state: DurableConsoleState };
}
interface Scope { owner: ObjectiveOwner; documents: Map<string, ObjectiveDocument>; groups: readonly Group[]; archive: Archive }
const emptyArchive = (): Archive => ({ revision: 0, entries: [], deletions: [], events: [] });
const failure = () => new ObjectiveArchiveError(503, "archive_recovery_required");
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
function segment(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw failure();
  return id;
}
/** 링크를 따라가지 않는다. 파싱 실패와 I/O 실패는 모두 쓰기를 막는다. */
function readJson(file: string): unknown {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw failure();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW_FLAG);
  try { if (!fs.fstatSync(fd).isFile()) throw failure(); return JSON.parse(fs.readFileSync(fd, "utf8")); }
  finally { fs.closeSync(fd); }
}
function safeDir(dir: string): void {
  ensureSafeDirectory(dir);
}
function readDocument(value: unknown): ObjectiveDocument {
  if (!object(value) || typeof value.id !== "string" || typeof value.title !== "string" || !object(value.ts)
    || !Number.isFinite(value.ts.createdAt) || !Number.isFinite(value.ts.updatedAt) || (value.pending !== undefined && value.pending !== true)) throw failure();
  segment(value.id); assertMinimal(value);
  const result = value as ObjectiveDocument;
  objectiveRecordFromDocument(result, "validation");
  return result;
}
function readArchive(value: unknown): Archive {
  if (!object(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !Array.isArray(value.entries) || !Array.isArray(value.deletions) || !Array.isArray(value.events)) throw failure();
  for (const row of value.entries) {
    if (!object(row) || typeof row.archiveId !== "string" || !Number.isFinite(row.archivedAt)) throw failure();
    readDocument(row.objective);
  }
  for (const row of value.deletions) {
    if (!object(row) || typeof row.deletionId !== "string" || typeof row.targetId !== "string" || !Number.isFinite(row.deletedAt) || !Number.isFinite(row.expiresAt)) throw failure();
    if (row.kind === "objective") readDocument(row.objective);
    else if (row.kind !== "theater" || !Array.isArray(row.objectives) || !Array.isArray(row.groups)) throw failure();
    for (const doc of (row.objectives ?? []) as unknown[]) readDocument(doc);
  }
  const channels = new Set(["objective:archived", "objective:restored", "objective:deleted", "objective:purged"]);
  for (const row of value.events) {
    if (!object(row) || typeof row.eventId !== "string" || !channels.has(String(row.channel))) throw failure();
    readDocument(row.objective);
  }
  if (value.transaction !== undefined) {
    const tx = value.transaction;
    if (!object(tx) || !Array.isArray(tx.documents) || !Array.isArray(tx.groups) || !object(tx.archive) || tx.archive.transaction !== undefined || !object(tx.state)) throw failure();
    tx.documents.forEach(readDocument); readArchive(tx.archive);
  }
  assertMinimal(value);
  return value as unknown as Archive;
}
function readRegistrations(raw: unknown): DurableConsoleState {
  if (!object(raw)) throw failure();
  const tombstones = Array.isArray(raw.deletionTombstones) ? raw.deletionTombstones.map((row) => object(row) && row.kind === "theater" ? { ...row, objectiveRecords: row.objectiveRecords ?? row.operations ?? [], groups: row.groups ?? [] } : row) : [];
  const state = sanitizeDurableConsoleState({ ...raw, deletionTombstones: tombstones });
  if (state.deletionTombstones?.length !== tombstones.length) throw failure();
  if (Array.isArray(raw.groups) && state.groups?.length !== raw.groups.length) throw failure();
  const sourceRecords = raw.objectiveRecords ?? raw.operations;
  if (Array.isArray(sourceRecords) && sourceRecords.some((row) => !object(row) || (row.type !== "shell" && !state.objectiveRecords.some((node) => node.id === row.id)))) throw failure();
  return state;
}
function withoutOwner(group: DurableObjectiveGroup): Group { const { theaterId: _owner, ...rest } = group; return rest; }
function allDocuments(scope: Scope): Map<string, ObjectiveDocument> {
  const docs = new Map(scope.documents);
  for (const entry of scope.archive.entries) docs.set(entry.objective.id, entry.objective);
  for (const deletion of scope.archive.deletions) for (const doc of [deletion.objective, ...deletion.objectives ?? []]) if (doc) docs.set(doc.id, doc);
  return docs;
}
/** 세션·보드·그룹·취소 사본을 한 소유 저장소에서 관리한다. Objective은 메모리 호환 뷰뿐이다. */
export function createObjectiveStorage(deps: {
  directory: string;
  stateStore: DurableJsonStore<DurableConsoleState>;
  owners: () => readonly ObjectiveOwner[];
  initializeOwners?: (state: DurableConsoleState) => void;
  createStore?: typeof createDurableJsonStore;
}) {
  const scopes = new Map<string, Scope>();
  const createStore = deps.createStore ?? createDurableJsonStore;
  let ready = false;
  let blocked = false;
  let state: DurableConsoleState = { version: STATE_VERSION, theaters: [], objectiveRecords: [] };
  let deferred: DurableConsoleState = state;
  let predecessorPrepared = false;
  let previousRaw: Record<string, unknown> = {};
  let deferredArchive = { entries: [] as readonly ArchivedObjective[], deletions: [] as readonly DurableDeletionTombstone[], events: [] as readonly ArchiveLifecycleEvent[], revision: 0 };
  const migrated = new Set<string>();
  const unavailable = new Set<string>();
  const archiveStore = (scope: Scope) => createStore<Archive>({ filePath: path.join(scope.owner.directory, "archive.json"), lockDir: null, sensitivity: "sensitive", sanitize: readArchive });
  function writeJson(file: string, value: unknown): void {
    safeDir(path.dirname(file));
    createStore<unknown>({ filePath: file, lockDir: null, sensitivity: "sensitive", sanitize: (raw) => raw }).save(value);
  }
  function writeDocuments(scope: Scope, documents: readonly ObjectiveDocument[], groups: readonly Group[]): void {
    const keep = new Set(documents.map((doc) => doc.id));
    safeDir(scope.owner.directory);
    if (fs.realpathSync(scope.owner.directory) !== path.resolve(scope.owner.directory)) throw failure();
    for (const doc of documents) { assertMinimal(doc); writeJson(path.join(scope.owner.directory, segment(doc.id), "objective.json"), doc); }
    for (const id of scope.documents.keys()) if (!keep.has(id)) fs.rmSync(path.join(scope.owner.directory, segment(id), "objective.json"), { force: true });
    writeJson(path.join(scope.owner.directory, "groups.json"), { groups });
  }
  function recover(scope: Scope): void {
    const tx = scope.archive.transaction;
    if (!tx) return;
    deps.stateStore.save(registrationState(tx.state, true));
    writeDocuments(scope, tx.documents, tx.groups);
    archiveStore(scope).save(tx.archive);
    scope.documents = new Map(tx.documents.map((doc) => [doc.id, doc])); scope.groups = tx.groups; scope.archive = tx.archive;
    state = readRegistrations(tx.state);
  }
  function readScope(owner: ObjectiveOwner): Scope {
    const existing = exists(owner.directory);
    safeDir(owner.directory);
    if (fs.realpathSync(owner.directory) !== path.resolve(owner.directory)) throw failure();
    const documents = new Map<string, ObjectiveDocument>();
    for (const entry of fs.readdirSync(owner.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      segment(entry.name);
      const file = path.join(owner.directory, entry.name, "objective.json");
      if (!exists(file)) continue;
      let doc: ObjectiveDocument;
      try { doc = readDocument(readJson(file)); if (doc.id !== entry.name) throw failure(); }
      catch (error) {
        // 깨진 목표는 원본을 격리한다. 권한·I/O 오류는 빈 문서로 바꾸지 않는다.
        if (!(error instanceof SyntaxError) && !(error instanceof ObjectiveArchiveError)) throw error;
        fs.renameSync(file, `${file}.broken-${Date.now()}-${randomUUID()}`);
        continue;
      }
      documents.set(doc.id, doc);
    }
    const groupsFile = path.join(owner.directory, "groups.json");
    if (existing && (!exists(groupsFile) || !exists(path.join(owner.directory, "archive.json")))) throw failure();
    const groups = exists(groupsFile) ? readJson(groupsFile) : { groups: [] };
    if (!object(groups) || !Array.isArray(groups.groups)) throw failure();
    assertMinimal(groups);
    const archiveFile = path.join(owner.directory, "archive.json");
    const archive = exists(archiveFile) ? readArchive(readJson(archiveFile)) : emptyArchive();
    const scope: Scope = { owner, documents, groups: groups.groups as Group[], archive };
    recover(scope);
    if (!existing) { writeJson(groupsFile, { groups: [] }); archiveStore(scope).save(archive); }
    return scope;
  }
  function assertReady(): void { if (!ready || blocked) throw failure(); }
  function scopeOf(theaterId: string): Scope {
    assertReady();
    const existing = scopes.get(theaterId);
    if (existing) return existing;
    const owner = deps.owners().find((entry) => entry.theaterId === theaterId);
    // 보류한 원본 위에 새 빈 저장소를 만들지 않는다.
    if (!owner || unavailable.has(theaterId) || deferred.objectiveRecords.some((node) => node.theaterId === theaterId)) throw new ObjectiveArchiveError(503, "objective_owner_unavailable");
    const scope = readScope(owner); scopes.set(theaterId, scope); return scope;
  }
  function encodeDeletion(tombstone: DurableDeletionTombstone, scope: Scope): Deletion {
    const docs = allDocuments(scope);
    const encode = (node: ObjectiveRecord) => documentFromObjective(node, docs.get(node.id));
    const base = { deletionId: tombstone.deletionId, targetId: tombstone.targetId, deletedAt: tombstone.deletedAt, expiresAt: tombstone.expiresAt, ...(tombstone.archived ? { archived: tombstone.archived } : {}) };
    return tombstone.kind === "objectiveRecord"
      ? { ...base, kind: "objective", objective: encode(tombstone.objectiveRecord), ...(tombstone.descendants?.length ? { objectives: tombstone.descendants.map(encode) } : {}) }
      : { ...base, kind: "theater", objectives: tombstone.objectiveRecords.map(encode), groups: tombstone.groups.map(withoutOwner) };
  }
  function decodeDeletion(row: Deletion, scope: Scope): DurableDeletionTombstone {
    const { objective, objectives, groups, kind, ...base } = row;
    const decode = (doc: ObjectiveDocument) => objectiveRecordFromDocument(doc, scope.owner.theaterId);
    if (kind === "objective") return { ...base, kind: "objectiveRecord", objectiveRecord: decode(objective!), ...(objectives?.length ? { descendants: objectives.map(decode) } : {}) };
    const registration = state.deletionTombstones?.find((entry) => entry.kind === "theater" && entry.deletionId === row.deletionId);
    if (!registration || registration.kind !== "theater") throw failure();
    return { ...base, kind: "theater", theater: registration.theater, objectiveRecords: (objectives ?? []).map(decode), groups: (groups ?? []).map((group) => ({ ...group, theaterId: scope.owner.theaterId })) };
  }
  function registrationState(next: DurableConsoleState, includeDeferred = false): DurableConsoleState {
    const deferredIds = new Set((deferred.deletionTombstones ?? []).map((row) => row.deletionId));
    const untouched = includeDeferred && Array.isArray(previousRaw.deletionTombstones)
      ? previousRaw.deletionTombstones.filter((row) => object(row) && deferredIds.has(String(row.deletionId))) : [];
    const deletions = [
      ...(next.deletionTombstones ?? []).filter((row) => row.kind === "theater" && !deferredIds.has(row.deletionId)).map((row) => { const { objectiveRecords: _objectiveRecords, groups: _groups, ...registration } = row as Extract<DurableDeletionTombstone, { kind: "theater" }>; return registration; }),
      ...untouched,
    ];
    return { version: STATE_VERSION, theaters: next.theaters,
      ...(includeDeferred && deferred.objectiveRecords.length ? { operations: Array.isArray(previousRaw.operations) ? previousRaw.operations.filter((row) => object(row) && deferred.objectiveRecords.some((record) => record.id === row.id)) : [] } : {}),
      ...(includeDeferred && deferred.groups?.length ? { groups: Array.isArray(previousRaw.groups) ? previousRaw.groups.filter((row) => object(row) && deferred.groups!.some((group) => group.id === row.id)) : [] } : {}),
      ...(deletions.length ? { deletionTombstones: [...new Map(deletions.map((row) => [row.deletionId, row])).values()] } : {}),
    } as DurableConsoleState;
  }
  function snapshot(): DurableConsoleState {
    const objectiveRecords: ObjectiveRecord[] = [], groups: DurableObjectiveGroup[] = [], deletions: DurableDeletionTombstone[] = [];
    for (const scope of scopes.values()) {
      for (const doc of scope.documents.values()) if (!doc.pending) objectiveRecords.push(objectiveRecordFromDocument(doc, scope.owner.theaterId));
      groups.push(...scope.groups.map((group) => ({ ...group, theaterId: scope.owner.theaterId })));
      deletions.push(...scope.archive.deletions.map((row) => decodeDeletion(row, scope)));
    }
    const ids = new Set<string>();
    for (const node of [...objectiveRecords, ...entries().map((entry) => entry.objectiveRecord), ...deletions.flatMap(deletionObjectiveRecords)]) {
      for (const id of [node.id, ...(node.sessions ?? []).map((child) => child.id)]) { if (ids.has(id)) throw failure(); ids.add(id); }
    }
    return { version: STATE_VERSION, theaters: state.theaters, objectiveRecords, groups, deletionTombstones: deletions };
  }
  function entries(): readonly ArchivedObjective[] {
    assertReady();
    return [...scopes.values()].flatMap((scope) => scope.archive.entries.map(({ objective, ...rest }) => ({ ...rest, objectiveRecord: objectiveRecordFromDocument(objective, scope.owner.theaterId) })));
  }
  function events(): readonly ArchiveLifecycleEvent[] {
    assertReady();
    return [...scopes.values()].flatMap((scope) => scope.archive.events.map(({ objective, ...rest }) => ({ ...rest, objectiveRecord: objectiveRecordFromDocument(objective, scope.owner.theaterId) })));
  }
  function save(next: DurableConsoleState, archived: readonly ArchivedObjective[] = entries(), eventRows: readonly ArchiveLifecycleEvent[] = []): void {
    assertReady();
    validateLocations(next.objectiveRecords, archived, next.deletionTombstones ?? []);
    for (const id of new Set([...next.objectiveRecords.map((node) => node.theaterId), ...(next.groups ?? []).map((group) => group.theaterId), ...archived.map((entry) => entry.objectiveRecord.theaterId)])) scopeOf(id);
    const registration = registrationState(next);
    const plans = [...scopes.values()].map((scope) => {
      const theaterId = scope.owner.theaterId, docs = allDocuments(scope);
      const encode = (node: ObjectiveRecord) => documentFromObjective(node, docs.get(node.id));
      const documents = new Map([...scope.documents].filter(([, doc]) => doc.pending));
      for (const node of next.objectiveRecords.filter((node) => node.theaterId === theaterId)) documents.set(node.id, encode(node));
      const archiveEntries = archived.filter((entry) => entry.objectiveRecord.theaterId === theaterId).map(({ objectiveRecord, ...rest }) => ({ ...rest, objective: encode(objectiveRecord) }));
      const archive: Archive = { revision: scope.archive.revision + (JSON.stringify(archiveEntries) === JSON.stringify(scope.archive.entries) ? 0 : 1), entries: archiveEntries,
        deletions: (next.deletionTombstones ?? []).filter((row) => row.kind === "theater" ? row.targetId === theaterId : row.objectiveRecord.theaterId === theaterId).map((row) => encodeDeletion(row, scope)),
        events: [...scope.archive.events, ...eventRows.filter((row) => row.objectiveRecord.theaterId === theaterId).map(({ objectiveRecord, ...rest }) => ({ ...rest, objective: encode(objectiveRecord) }))],
      };
      const groups = (next.groups ?? []).filter((group) => group.theaterId === theaterId).map(withoutOwner);
      const transaction = { documents: [...documents.values()], groups, archive, state: registration };
      assertMinimal(transaction);
      return { scope, transaction };
    });
    try {
      // 각 사령관의 목표·그룹·보관은 하나의 준비 레코드다. 실패 뒤에는 어떤 일반 쓰기도 덮지 못한다.
      for (const { scope, transaction } of plans) archiveStore(scope).save({ ...scope.archive, transaction });
      deps.stateStore.save(registrationState(next, true));
      for (const { scope, transaction } of plans) {
        writeDocuments(scope, transaction.documents, transaction.groups);
        archiveStore(scope).save(transaction.archive);
        scope.documents = new Map(transaction.documents.map((doc) => [doc.id, doc])); scope.groups = transaction.groups; scope.archive = transaction.archive;
      }
      state = next;
    } catch (error) { blocked = true; throw error; }
  }
  function acknowledgeEvents(ids: readonly string[]): void {
    assertReady(); const consumed = new Set(ids);
    for (const scope of scopes.values()) {
      const archive = { ...scope.archive, events: scope.archive.events.filter((event) => !consumed.has(event.eventId)) };
      archiveStore(scope).save(archive); scope.archive = archive;
    }
  }
  const board: ObjectiveBoardStorage = {
    forget(theaterId, id) {
      const scope = scopeOf(theaterId);
      if (scope.archive.entries.some((row) => row.objective.id === id) || scope.archive.deletions.some((row) => row.objective?.id === id || row.objectives?.some((doc) => doc.id === id))) throw failure();
      const doc = scope.documents.get(id);
      if (doc && !doc.pending) throw failure();
      fs.rmSync(path.join(scope.owner.directory, segment(id)), { recursive: true, force: true });
      scope.documents.delete(id);
    },
    directory(theaterId) { try { return scopeOf(theaterId).owner.directory; } catch { return null; } },
    list(theaterId) { return [...allDocuments(scopeOf(theaterId)).values()].map((doc) => boardFromDocument(doc, theaterId)); },
    save(theaterId, value) {
      const scope = scopeOf(theaterId), previous = allDocuments(scope).get(value.id);
      const doc = documentFromBoard(value, previous); assertMinimal(doc);
      const archived = scope.archive.entries.some((entry) => entry.objective.id === doc.id);
      const deleted = scope.archive.deletions.some((row) => row.objective?.id === doc.id || row.objectives?.some((entry) => entry.id === doc.id));
      if (archived || deleted) {
        const replace = (entry: ObjectiveDocument) => entry.id === doc.id ? doc : entry;
        const archive = { ...scope.archive, entries: scope.archive.entries.map((entry) => ({ ...entry, objective: replace(entry.objective) })), deletions: scope.archive.deletions.map((row) => ({ ...row, ...(row.objective ? { objective: replace(row.objective) } : {}), ...(row.objectives ? { objectives: row.objectives.map(replace) } : {}) })) };
        archiveStore(scope).save(archive); scope.archive = archive;
      } else { writeJson(path.join(scope.owner.directory, segment(doc.id), "objective.json"), doc); scope.documents.set(doc.id, doc); }
    },
  };

  function load(): DurableConsoleState {
    try {
      const raw = exists(deps.stateStore.path) ? readJson(deps.stateStore.path) : { version: STATE_VERSION, theaters: [] };
      if (!object(raw) || raw.version !== STATE_VERSION || !Array.isArray(raw.theaters)) throw failure();
      previousRaw = raw;
      state = readRegistrations(raw);
      if (state.theaters.length !== raw.theaters.length) throw failure();
      const legacyArchivePath = path.join(deps.directory, "operations-archive.json");
      if (exists(legacyArchivePath)) {
        const legacy = readArchiveDocument(readJson(legacyArchivePath));
        const tx = legacy.transaction;
        if (!exists(deps.stateStore.path) && !tx) throw failure();
        if (tx) {
          // 바로 앞 저장소의 준비 저널도 메모리에서만 복구한다. 원본 쌍은 새 트리의 커밋 전까지 그대로다.
          const before = (state.revision ?? 0) === tx.beforeRevision && predecessorStateHash(raw) === tx.beforeHash;
          const after = state.revision === tx.state.revision && predecessorStateHash(raw) === predecessorStateHash(tx.state);
          if (!before && !after) throw failure();
          state = readRegistrations(tx.state); deferredArchive = tx.archive; predecessorPrepared = true;
        } else deferredArchive = legacy;
      }
      deps.initializeOwners?.(state);
      migrate(state);
      ready = true; blocked = false;
      return snapshot();
    } catch (error) { blocked = true; throw error instanceof SyntaxError ? failure() : error; }
  }
  function migrate(source: DurableConsoleState): void {
    const markerFile = `${deps.stateStore.path}.objectives-migration.json`;
    const marker = exists(markerFile) ? readJson(markerFile) : { owners: {} };
    if (!object(marker) || !object(marker.owners)) throw failure();
    const markers = marker.owners as Record<string, string>;
    const cleaned = new Set(Array.isArray(marker.cleaned) ? marker.cleaned.filter((id): id is string => typeof id === "string") : []);
    for (const owner of deps.owners()) if (markers[owner.theaterId] === owner.directory && exists(owner.directory)) migrated.add(owner.theaterId);
    const deferSource = () => {
      deferred = { version: STATE_VERSION, theaters: source.theaters,
        objectiveRecords: source.objectiveRecords.filter((node) => !migrated.has(node.theaterId)),
        groups: (source.groups ?? []).filter((group) => !migrated.has(group.theaterId)),
        deletionTombstones: (source.deletionTombstones ?? []).filter((row) => !migrated.has(row.kind === "theater" ? row.targetId : row.objectiveRecord.theaterId)),
      };
    };
    deferSource();
    const legacyArchivePath = path.join(deps.directory, "operations-archive.json");
    if ((source.revision ?? 0) > 0 && !exists(legacyArchivePath) && !migrated.size) throw failure();
    const sourceDeletions = [...new Map([...source.deletionTombstones ?? [], ...deferredArchive.deletions.filter((row) => !migrated.has(row.kind === "theater" ? row.targetId : row.objectiveRecord.theaterId))].map((row) => [row.deletionId, row])).values()];
    state = { ...state, deletionTombstones: sourceDeletions };
    validateLocations(source.objectiveRecords, deferredArchive.entries, sourceDeletions);
    for (const owner of deps.owners()) {
      const parent = path.dirname(owner.directory);
      safeDir(parent);
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (/^\.objectives-new-[0-9a-f-]{36}$/.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink()) fs.rmSync(path.join(parent, entry.name), { recursive: true });
      }
      const destination = owner.directory;
      if (cleaned.has(owner.theaterId) && !exists(destination)) throw failure();
      if (exists(destination)) {
        const scope = readScope(owner); scopes.set(owner.theaterId, scope);
        if (markers[owner.theaterId] === destination) migrated.add(owner.theaterId);
        continue;
      }
      const staging = path.join(path.dirname(destination), `.objectives-new-${randomUUID()}`);
      markers[owner.theaterId] = destination;
      writeJson(markerFile, { owners: markers, cleaned: [...cleaned] });
      try {
        // 현 workspace resolver가 고르는 원본 한 곳만 읽는다. 더 오래된 사본은 순회하지 않는다.
        const legacyDir = path.join(resolveWorkspaceDirectory(deps.directory, owner.workspacePath).path, "objectives");
        safeDir(staging);
        const documents = new Map<string, ObjectiveDocument>();
        if (exists(legacyDir)) {
          if (!fs.lstatSync(legacyDir).isDirectory() || fs.lstatSync(legacyDir).isSymbolicLink()) throw failure();
          for (const entry of fs.readdirSync(legacyDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) throw failure();
            segment(entry.name);
            copyVerified(path.join(legacyDir, entry.name), path.join(staging, entry.name));
            const file = path.join(staging, entry.name, "objective.json");
            if (!exists(file)) continue;
            const raw = readJson(file);
            if (!object(raw) || raw.operationId !== entry.name) throw failure();
            const board = { rank: 0, note: "", missions: [], ...(migrateBoardKeys(raw) as object), id: raw.operationId } as unknown as StoredObjective;
            const draft = object(raw.pending) ? raw.pending : null;
            const normalized = draft ? { ...board, pending: true as const, title: String(draft.title), groupId: draft.groupId as string | null,
              ts: { createdAt: Number(draft.createdAt), updatedAt: Number(draft.createdAt) }, session: { sessionName: draft.sessionName, model: draft.model, effort: draft.effort }, chatMode: draft.viewMode === "chat" } : board;
            documents.set(entry.name, documentFromBoard(normalized));
          }
        }
        const scope: Scope = { owner: { ...owner, directory: staging }, documents, groups: (source.groups ?? []).filter((row) => row.theaterId === owner.theaterId).map(withoutOwner), archive: emptyArchive() };
        const encode = (node: ObjectiveRecord) => documentFromObjective(node, documents.get(node.id));
        scope.archive = { revision: deferredArchive.revision,
          entries: deferredArchive.entries.filter((row) => row.objectiveRecord.theaterId === owner.theaterId).map(({ objectiveRecord, ...rest }) => ({ ...rest, objective: encode(objectiveRecord) })),
          deletions: sourceDeletions.filter((row) => row.kind === "theater" ? row.targetId === owner.theaterId : row.objectiveRecord.theaterId === owner.theaterId).map((row) => encodeDeletion(row, scope)),
          events: deferredArchive.events.filter((row) => row.objectiveRecord.theaterId === owner.theaterId).map(({ objectiveRecord, ...rest }) => ({ ...rest, objective: encode(objectiveRecord) })),
        };
        const inactive = new Set([...scope.archive.entries.map((row) => row.objective.id), ...scope.archive.deletions.flatMap((row) => [row.objective?.id, ...row.objectives?.map((doc) => doc.id) ?? []]).filter(Boolean)]);
        for (const node of source.objectiveRecords.filter((node) => node.theaterId === owner.theaterId)) documents.set(node.id, encode(node));
        const active = [...documents.values()].filter((doc) => !inactive.has(doc.id));
        // 사라진 세션에 붙어 있던 보드는 원본을 버리지 않고 이주를 보류한다.
        if (active.some((doc) => !doc.pending && !source.objectiveRecords.some((node) => node.id === doc.id))) throw failure();
        assertMinimal(scope.archive); active.forEach(assertMinimal);
        writeDocuments(scope, active, scope.groups); archiveStore(scope).save(scope.archive);
        fs.renameSync(staging, destination);
        scope.owner = owner; scope.documents = new Map(active.map((doc) => [doc.id, doc])); scopes.set(owner.theaterId, scope); migrated.add(owner.theaterId);
      } catch (error) {
        fs.rmSync(staging, { recursive: true, force: true });
        unavailable.add(owner.theaterId);
        console.warn(`[objectives] migration deferred for ${owner.theaterId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const pending = (row: DurableDeletionTombstone) => !migrated.has(row.kind === "theater" ? row.targetId : row.objectiveRecord.theaterId);
    deferSource();
    if (predecessorPrepared && (deferred.objectiveRecords.length || deferred.groups?.length || deferred.deletionTombstones?.length
      || deferredArchive.entries.some((row) => !migrated.has(row.objectiveRecord.theaterId)) || deferredArchive.deletions.some(pending) || deferredArchive.events.some((row) => !migrated.has(row.objectiveRecord.theaterId)))) throw failure();
    // rename을 마친 소유분만 원본에서 거둔다. 실패하면 마커와 새 트리가 다음 기동의 권위다.
    if (migrated.size) deps.stateStore.save(registrationState(state, true));
    const pendingArchive = deferredArchive.entries.some((row) => !migrated.has(row.objectiveRecord.theaterId)) || deferredArchive.deletions.some(pending) || deferredArchive.events.some((row) => !migrated.has(row.objectiveRecord.theaterId));
    if (migrated.size && !pendingArchive && exists(legacyArchivePath)) fs.rmSync(legacyArchivePath);
    for (const owner of deps.owners()) if (migrated.has(owner.theaterId) && !cleaned.has(owner.theaterId)) {
      try {
        const legacyDir = path.join(resolveWorkspaceDirectory(deps.directory, owner.workspacePath).path, "objectives");
        if (exists(legacyDir)) fs.rmSync(legacyDir, { recursive: true });
        cleaned.add(owner.theaterId);
        writeJson(markerFile, { owners: markers, cleaned: [...cleaned] });
      } catch { console.warn(`[objectives] source cleanup deferred for ${owner.theaterId}`); }
    }
  }
  return { load, save, assertReady, entries, events, acknowledgeEvents, board, revision: () => [...scopes.values()].reduce((sum, scope) => sum + scope.archive.revision, 0), blocked: () => blocked };
}

/** 원본은 rename 커밋 전까지 보존한다. 링크는 거절하고 복사한 바이트도 대조한다. */
function copyVerified(source: string, target: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw failure();
  if (stat.isDirectory()) {
    safeDir(target);
    for (const name of fs.readdirSync(source)) copyVerified(path.join(source, name), path.join(target, name));
  } else if (stat.isFile()) {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    if (!fs.readFileSync(source).equals(fs.readFileSync(target))) throw failure();
    fs.chmodSync(target, 0o600);
  } else throw failure();
}

/** 직전 보드의 참조 키만 한 번 올린다. 사용자 문자열은 바꾸지 않는다. */
function migrateBoardKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(migrateBoardKeys);
  if (!object(value)) return value;
  const board = "rank" in value && ("missions" in value || "note" in value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key === "operationId" ? board ? "id" : "objectiveId" : key === "operationIntent" ? "lifecycleIntent" : key === "parentOperationId" ? "parentObjectiveId" : key, key === "kind" && item === "operation" ? "objectiveRecord" : migrateBoardKeys(item)]));
}

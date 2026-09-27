import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createDurableJsonStore, ensureSafeDirectory, withDirectoryLock, NOFOLLOW_FLAG, type DurableJsonStore } from "@fleet-console/infra";
import type { OperationNode } from "../../execution/host/operations/operations-domain.js";
import { deletionOperations, sanitizeDeletionTombstone, sanitizeDurableConsoleState, sanitizeOperationNode, STATE_VERSION, type DurableConsoleState, type DurableDeletionTombstone } from "./durable-state.js";

export interface ArchivedOperation {
  readonly operation: OperationNode;
  readonly archiveId: string;
  readonly archivedAt: number;
}
export interface ArchiveLifecycleEvent {
  readonly eventId: string;
  readonly channel: "operation:archived" | "operation:restored" | "operation:deleted" | "operation:purged";
  readonly operation: OperationNode;
}
interface ArchiveDocument {
  readonly version: 1;
  readonly revision: number;
  readonly entries: readonly ArchivedOperation[];
  readonly deletions: readonly DurableDeletionTombstone[];
  readonly events: readonly ArchiveLifecycleEvent[];
  readonly transaction?: {
    readonly beforeRevision: number;
    readonly beforeHash: string;
    readonly state: DurableConsoleState;
    readonly archive: Omit<ArchiveDocument, "transaction">;
  };
}

export class OperationArchiveError extends Error {
  constructor(readonly status: number, code: string) { super(code); this.name = "OperationArchiveError"; }
}

/** 두 저장 파일의 유일한 writer. prepare 후 실패는 다음 쓰기로 덮지 않고 기동 복구를 요구한다. */
export function createOperationArchiveStorage(deps: {
  readonly directory: string;
  readonly stateStore: DurableJsonStore<DurableConsoleState>;
  readonly createStore?: typeof createDurableJsonStore;
}) {
  const archivePath = path.join(deps.directory, "operations-archive.json");
  const lockDir = path.join(deps.directory, "operation-state.lock");
  const empty = (): ArchiveDocument => ({ version: 1, revision: 0, entries: [], deletions: [], events: [] });
  const archiveStore = (deps.createStore ?? createDurableJsonStore)<ArchiveDocument>({
    filePath: archivePath, lockDir: null, sensitivity: "sensitive", sanitize: readArchiveDocument,
  });
  let document = empty();
  let stateRevision = 0;
  let lastState: DurableConsoleState | null = null;
  let ready = false;
  let initialized = false;
  let blocked = false;

  function locked<T>(run: () => T): T {
    ensureSafeDirectory(deps.directory);
    return withDirectoryLock({ lockDir, ownerFileName: "owner.json" }, run);
  }
  function exists(file: string): boolean {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new OperationArchiveError(503, "archive_recovery_required");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  function load(): DurableConsoleState {
    return locked(() => {
      // 알 수 없는 버전·깨진 파일을 sanitizer의 빈 상태로 바꾸지 않는다.
      let state: DurableConsoleState;
      const stateExists = exists(deps.stateStore.path);
      if (stateExists) {
        const fd = fs.openSync(deps.stateStore.path, fs.constants.O_RDONLY | NOFOLLOW_FLAG);
        let raw: Record<string, unknown>;
        try {
          if (!fs.fstatSync(fd).isFile()) throw new OperationArchiveError(503, "archive_recovery_required");
          raw = JSON.parse(fs.readFileSync(fd, "utf8")) as Record<string, unknown>;
        } finally { fs.closeSync(fd); }
        if (!record(raw) || !Number.isInteger(raw.version) || Number(raw.version) < 1 || Number(raw.version) > STATE_VERSION) throw new OperationArchiveError(503, "archive_recovery_required");
        state = sanitizeDurableConsoleState(raw);
        if (raw.version === STATE_VERSION && (!Array.isArray(raw.operations) || raw.operations.length !== state.operations.length || !Array.isArray(raw.theaters) || raw.theaters.length !== state.theaters.length)) throw new OperationArchiveError(503, "archive_recovery_required");
      } else state = sanitizeDurableConsoleState({ version: STATE_VERSION });
      initialized = exists(archivePath);
      if (!initialized && (state.revision ?? 0) > 0) throw new OperationArchiveError(503, "archive_recovery_required");
      document = initialized ? archiveStore.load() : empty();
      if (initialized && !stateExists && !document.transaction) throw new OperationArchiveError(503, "archive_recovery_required");
      if (document.transaction) {
        const tx = document.transaction;
        const revision = state.revision ?? 0;
        const beforeMatches = revision === tx.beforeRevision && stateHash(state) === tx.beforeHash;
        const afterMatches = revision === tx.state.revision && stateHash(state) === stateHash(tx.state);
        if (!beforeMatches && !afterMatches) {
          throw new OperationArchiveError(503, "archive_recovery_required");
        }
        deps.stateStore.save(tx.state);
        archiveStore.save(tx.archive);
        state = tx.state;
        document = tx.archive;
      }
      stateRevision = state.revision ?? 0;
      lastState = state;
      const deletions = [...(state.deletionTombstones ?? []), ...document.deletions];
      if (new Set(deletions.map((item) => item.deletionId)).size !== deletions.length) throw new OperationArchiveError(503, "archive_recovery_required");
      validateLocations(state.operations, document.entries, deletions);
      ready = true;
      blocked = false;
      return { ...state, deletionTombstones: deletions };
    });
  }
  function assertReady(): void {
    if (!ready || blocked) throw new OperationArchiveError(503, "archive_recovery_required");
  }
  function save(state: DurableConsoleState, entries: readonly ArchivedOperation[] = document.entries, events: readonly ArchiveLifecycleEvent[] = []): void {
    assertReady();
    locked(() => {
      const deletions = state.deletionTombstones ?? [];
      validateLocations(state.operations, entries, deletions);
      const changed = canonical(entries) !== canonical(document.entries);
      const archive: ArchiveDocument = {
        version: 1, revision: document.revision + (changed ? 1 : 0), entries,
        deletions, events: [...document.events, ...events],
      };
      const nextState: DurableConsoleState = { ...state, version: STATE_VERSION, revision: stateRevision + 1, deletionTombstones: [] };
      const pairChanged = !initialized || canonical(archive) !== canonical(document);
      // 한 파일만 바뀌는 일반 payload 저장은 저널을 추가하지 않는다.
      if (!pairChanged) {
        deps.stateStore.save(nextState);
        stateRevision = nextState.revision!;
        lastState = nextState;
        return;
      }
      const prepared: ArchiveDocument = { ...document, transaction: { beforeRevision: stateRevision, beforeHash: stateHash(lastState!), state: nextState, archive } };
      try {
        archiveStore.save(prepared);
        deps.stateStore.save(nextState);
        archiveStore.save(archive);
      } catch (error) {
        blocked = true;
        throw error;
      }
      document = archive;
      initialized = true;
      stateRevision = nextState.revision!;
      lastState = nextState;
    });
  }
  function acknowledgeEvents(ids: readonly string[]): void {
    assertReady();
    if (!ids.length) return;
    locked(() => {
      const consumed = new Set(ids);
      const next = { ...document, events: document.events.filter((event) => !consumed.has(event.eventId)) };
      archiveStore.save(next);
      document = next;
    });
  }
  return {
    load, save, assertReady, acknowledgeEvents,
    entries: (): readonly ArchivedOperation[] => { assertReady(); return document.entries; },
    events: (): readonly ArchiveLifecycleEvent[] => { assertReady(); return document.events; },
    revision: () => document.revision,
    blocked: () => blocked,
  };
}

export type OperationArchiveStorage = ReturnType<typeof createOperationArchiveStorage>;

export function archiveEvent(channel: ArchiveLifecycleEvent["channel"], operation: OperationNode): ArchiveLifecycleEvent {
  return { eventId: crypto.randomUUID(), channel, operation };
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
function stateHash(state: DurableConsoleState): string {
  return crypto.createHash("sha256").update(canonical(sanitizeDurableConsoleState(state))).digest("hex");
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function readArchiveDocument(value: unknown): ArchiveDocument {
  if (!record(value) || value.version !== 1 || !integer(value.revision) || !Array.isArray(value.entries) || !Array.isArray(value.deletions) || !Array.isArray(value.events)) throw new OperationArchiveError(503, "archive_recovery_required");
  const entries = value.entries.map((raw): ArchivedOperation => {
    const operation = record(raw) ? sanitizeOperationNode(raw.operation) : null;
    if (!operation || !record(raw) || typeof raw.archiveId !== "string" || !raw.archiveId || !integer(raw.archivedAt)) throw new OperationArchiveError(503, "archive_recovery_required");
    return { operation, archiveId: raw.archiveId, archivedAt: raw.archivedAt };
  });
  const deletions = value.deletions.map((raw) => {
    const result = sanitizeDeletionTombstone(raw);
    if (!result) throw new OperationArchiveError(503, "archive_recovery_required");
    return result;
  });
  const channels = new Set(["operation:archived", "operation:restored", "operation:deleted", "operation:purged"]);
  const events = value.events.map((raw): ArchiveLifecycleEvent => {
    const operation = record(raw) ? sanitizeOperationNode(raw.operation) : null;
    if (!operation || !record(raw) || typeof raw.eventId !== "string" || !channels.has(String(raw.channel))) throw new OperationArchiveError(503, "archive_recovery_required");
    return { operation, eventId: raw.eventId, channel: raw.channel as ArchiveLifecycleEvent["channel"] };
  });
  let transaction: ArchiveDocument["transaction"];
  if (value.transaction !== undefined) {
    const tx = value.transaction;
    if (!record(tx) || !integer(tx.beforeRevision) || typeof tx.beforeHash !== "string" || !/^[a-f0-9]{64}$/.test(tx.beforeHash) || !record(tx.state) || tx.state.version !== STATE_VERSION || !integer(tx.state.revision) || !record(tx.archive) || tx.archive.transaction !== undefined) throw new OperationArchiveError(503, "archive_recovery_required");
    const state = sanitizeDurableConsoleState(tx.state);
    if (!Array.isArray(tx.state.operations) || state.operations.length !== tx.state.operations.length) throw new OperationArchiveError(503, "archive_recovery_required");
    transaction = { beforeRevision: tx.beforeRevision, beforeHash: tx.beforeHash, state, archive: readArchiveDocument(tx.archive) };
  }
  return { version: 1, revision: value.revision, entries, deletions, events, ...(transaction ? { transaction } : {}) };
}
function validateLocations(active: readonly OperationNode[], entries: readonly ArchivedOperation[], deletions: readonly DurableDeletionTombstone[]): void {
  const ids = new Set<string>();
  for (const node of [...active, ...entries.map((entry) => entry.operation), ...deletions.flatMap(deletionOperations)]) {
    if (ids.has(node.id)) throw new OperationArchiveError(409, "archive_cluster_conflict");
    ids.add(node.id);
  }
}

import crypto from "node:crypto";
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

/** 기존 실행 서비스의 메모리 포트. 영속 구현은 목표 저장소가 소유한다. */
export interface OperationArchiveStorage {
  load(): DurableConsoleState;
  save(state: DurableConsoleState, entries?: readonly ArchivedOperation[], events?: readonly ArchiveLifecycleEvent[]): void;
  assertReady(): void;
  acknowledgeEvents(ids: readonly string[]): void;
  entries(): readonly ArchivedOperation[];
  events(): readonly ArchiveLifecycleEvent[];
  revision(): number;
  blocked(): boolean;
}

/** 실행 정리용 투영이다. 자식은 별도 보관 레코드나 active 최상위 노드로 저장하지 않는다. */
export function archiveSessionNodes(operation: OperationNode): readonly OperationNode[] {
  return [operation, ...(operation.childSessions ?? []).map((child): OperationNode => ({
    id: child.id, theaterId: operation.theaterId, type: "agent", pluginId: null,
    title: child.id, parentOperationId: operation.id, payload: child.payload, geometry: null, ts: child.ts,
  }))];
}

export function archiveEvent(channel: ArchiveLifecycleEvent["channel"], operation: OperationNode): ArchiveLifecycleEvent {
  return { eventId: crypto.randomUUID(), channel, operation };
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
export function readArchiveDocument(value: unknown): ArchiveDocument {
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
export function validateLocations(active: readonly OperationNode[], entries: readonly ArchivedOperation[], deletions: readonly DurableDeletionTombstone[]): void {
  const ids = new Set<string>();
  for (const node of [...active, ...entries.map((entry) => entry.operation), ...deletions.flatMap(deletionOperations)].flatMap(archiveSessionNodes)) {
    if (ids.has(node.id)) throw new OperationArchiveError(409, "archive_cluster_conflict");
    ids.add(node.id);
  }
}

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  APPROVAL_DECISIONS,
  APPROVAL_STATUSES,
  type ApprovalDecision,
  type ApprovalEndReason,
  type ApprovalRequestView,
  type ApprovalRetention,
  type ApprovalSnapshot,
  type ApprovalStatus,
} from "./contract.js";

export {
  APPROVAL_ANSWER_ROUTE,
  APPROVAL_CHANNEL,
  APPROVAL_DECISIONS,
  APPROVAL_LIST_ROUTE,
  APPROVAL_STATUSES,
  type ApprovalDecision,
  type ApprovalEndReason,
  type ApprovalRequestView,
  type ApprovalRetention,
  type ApprovalSnapshot,
  type ApprovalStatus,
} from "./contract.js";

/**
 * 승인 기록. 타입의 본문과 승인 때 일어나는 일은 등록된 타입이 알고, 이 코어는 상태 전이와 저장만 한다.
 * 끝난 기록은 디스크와 스냅숏에 남기지 않는다. 끝난 id 에 다시 답하면 `unknown_request` 다.
 * 디스크 타입의 대기만 파일에 남고, 메모리 타입은 `expiresAt` 이 지나면 `expired` 로 사라진다.
 */

const STATUS_SET: ReadonlySet<string> = new Set(APPROVAL_STATUSES);
const APPLYING: ReadonlySet<ApprovalDecision> = new Set(["approve", "always"]);
const DECLINING: ReadonlySet<ApprovalDecision> = new Set(["reject", "declined"]);

export class ApprovalError extends Error {
  constructor(readonly code: "unknown_request" | "approval_failed" | "invalid_request" | "unknown_type" | "corrupt_store") {
    super(code);
    this.name = "ApprovalError";
  }
}

export interface ApprovalType {
  readonly id: string;
  readonly retention: ApprovalRetention;
  /** 이 타입이 사람으로부터 받는 답. 즉답형은 `always` | `declined` 만. */
  readonly decisions: readonly ApprovalDecision[];
  /** 메모리 타입의 수명. 없으면 등록할 수 없다. 디스크 타입은 쓰지 않는다. */
  readonly ttlMs?: number;
  readonly parse: (payload: unknown) => unknown;
  /**
   * 승인(`approve`·`always`) 때 동기로 부른다. `missing` 이면 반영하지 않고 그 요청을 끝낸다.
   * 예외면 이 기록은 그대로 `pending` 이다.
   */
  readonly onApprove?: (record: ApprovalRequestView) => "approved" | "missing";
}

export interface ApprovalCoreOptions {
  /** 디스크 기록을 쓰는 JSON 파일. 없으면 빈 장부에서 시작한다. */
  readonly filePath: string;
  readonly now?: () => number;
  /** 스냅숏이 바뀔 때마다. 메모리 만료도 포함한다. */
  readonly onChange?: (snapshot: ApprovalSnapshot) => void;
}

interface StoredRequest {
  readonly id: string;
  readonly type: string;
  readonly retention: ApprovalRetention;
  readonly status: ApprovalStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt?: number;
  readonly payload: unknown;
}

export interface ApprovalCore {
  register(type: ApprovalType): void;
  propose(typeId: string, payload: unknown): ApprovalRequestView;
  /** 대기 중인 본문만 바꾼다. 상태와 만든 시각은 그대로다. */
  amend(id: string, payload: unknown): ApprovalRequestView;
  /** 사람이 답한다. 없거나 이미 끝난 id 는 `unknown_request`. 반영할 수 없으면 `approval_failed` 로 끝내고 지운다. */
  answer(id: string, decision: ApprovalDecision): ApprovalRequestView;
  /** 즉답형이 답을 받지 못함(`no_response`). 기록은 지운다. */
  expire(id: string): ApprovalRequestView;
  /** 요청을 거둔다. `replaced` 는 같은 대상의 새 제안이 밀어낸 것이다. 기록은 지운다. */
  withdraw(id: string, reason?: ApprovalEndReason): ApprovalRequestView;
  snapshot(): ApprovalSnapshot;
  /** 기록이 `pending` 을 떠날 때 한 번. `silence` 안에서는 울리지 않는다. */
  subscribeSettled(listener: (record: ApprovalRequestView) => void): () => void;
  /** 기동 때 이미 어긋난 기록을 맞출 때 깨움이 나가지 않게 한다. 스냅숏 방송은 그대로다. */
  silence<T>(run: () => T): T;
  dispose(): void;
}

export function createApprovalCore(options: ApprovalCoreOptions): ApprovalCore {
  const now = options.now ?? Date.now;
  const types = new Map<string, ApprovalType>();
  let records = load(options.filePath);
  const settled = new Set<(record: ApprovalRequestView) => void>();
  let quiet = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const view = (record: StoredRequest): ApprovalRequestView => ({
    id: record.id,
    type: record.type,
    retention: record.retention,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
    payload: record.payload,
  });

  const snapshot = (): ApprovalSnapshot => ({
    requests: [...records.values()].map(view).sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id)),
  });

  const publish = () => { options.onChange?.(snapshot()); };

  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (disposed) return;
    const at = now();
    let next: number | undefined;
    for (const record of records.values()) {
      if (record.status === "pending" && record.expiresAt !== undefined && record.expiresAt > at) {
        next = next === undefined ? record.expiresAt : Math.min(next, record.expiresAt);
      }
    }
    if (next === undefined) return;
    timer = setTimeout(() => { timer = null; sweep(); }, Math.min(Math.max(0, next - now()), 2_147_483_647));
    timer.unref?.();
  };

  const commit = (next: Map<string, StoredRequest>, persist: boolean) => {
    if (persist) write(options.filePath, [...next.values()].filter((record) => record.retention === "disk"));
    records = next;
    publish();
    arm();
  };

  const end = (record: StoredRequest, status: Exclude<ApprovalStatus, "pending">, reason?: ApprovalEndReason): ApprovalRequestView => {
    const next = new Map(records);
    next.delete(record.id);
    commit(next, record.retention === "disk");
    const viewed: ApprovalRequestView = { ...view({ ...record, status, updatedAt: now() }), ...(reason ? { reason } : {}) };
    if (quiet === 0) for (const listener of settled) listener(viewed);
    return viewed;
  };

  const requirePending = (id: string): StoredRequest => {
    const record = records.get(id);
    if (!record || record.status !== "pending") throw new ApprovalError("unknown_request");
    return record;
  };

  function sweep(): void {
    const at = now();
    const due = [...records.values()].filter((record) => record.status === "pending" && record.expiresAt !== undefined && record.expiresAt <= at);
    for (const record of due) {
      const current = records.get(record.id);
      if (current?.status === "pending") end(current, "expired");
    }
  }

  arm();

  return {
    register(type) {
      if (types.has(type.id)) throw new ApprovalError("invalid_request");
      if (!type.id || type.decisions.length === 0 || type.decisions.some((decision) => !APPROVAL_DECISIONS.includes(decision))) throw new ApprovalError("invalid_request");
      if (type.retention === "memory" && (type.ttlMs === undefined || type.ttlMs <= 0)) throw new ApprovalError("invalid_request");
      if (type.retention === "disk" && type.ttlMs !== undefined) throw new ApprovalError("invalid_request");
      types.set(type.id, type);
    },
    propose(typeId, payload) {
      if (disposed) throw new ApprovalError("invalid_request");
      const type = types.get(typeId);
      if (!type) throw new ApprovalError("unknown_type");
      const parsed = type.parse(payload);
      const createdAt = now();
      const record: StoredRequest = {
        id: randomUUID(),
        type: type.id,
        retention: type.retention,
        status: "pending",
        createdAt,
        updatedAt: createdAt,
        payload: parsed,
        ...(type.retention === "memory" ? { expiresAt: createdAt + type.ttlMs! } : {}),
      };
      const next = new Map(records);
      next.set(record.id, record);
      commit(next, type.retention === "disk");
      return view(record);
    },
    amend(id, payload) {
      const record = requirePending(id);
      const type = types.get(record.type);
      if (!type) throw new ApprovalError("unknown_type");
      const updated: StoredRequest = { ...record, payload: type.parse(payload), updatedAt: now() };
      const next = new Map(records);
      next.set(id, updated);
      commit(next, record.retention === "disk");
      return view(updated);
    },
    answer(id, decision) {
      sweep();
      const record = requirePending(id);
      const type = types.get(record.type);
      if (!type || !type.decisions.includes(decision)) throw new ApprovalError("invalid_request");
      if (DECLINING.has(decision)) return end(record, "rejected");
      if (!APPLYING.has(decision)) throw new ApprovalError("invalid_request");
      const outcome = type.onApprove?.(view(record)) ?? "approved";
      const current = records.get(id);
      if (!current || current.status !== "pending") throw new ApprovalError("unknown_request");
      if (outcome === "missing") { end(current, "withdrawn", "missing"); throw new ApprovalError("approval_failed"); }
      if (outcome !== "approved") throw new ApprovalError("invalid_request");
      return end(current, "approved");
    },
    expire(id) {
      sweep();
      return end(requirePending(id), "expired");
    },
    withdraw(id, reason) {
      return end(requirePending(id), "withdrawn", reason);
    },
    snapshot() {
      sweep();
      return snapshot();
    },
    subscribeSettled(listener) {
      settled.add(listener);
      return () => { settled.delete(listener); };
    },
    silence(run) {
      quiet += 1;
      try { return run(); }
      finally { quiet -= 1; }
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      settled.clear();
    },
  };
}

function write(filePath: string, requests: readonly StoredRequest[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  const body = `${JSON.stringify({ requests }, null, 2)}\n`;
  try {
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try { fs.writeFileSync(fd, body); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 없으면 그만 */ }
    throw error;
  }
}

function load(filePath: string): Map<string, StoredRequest> {
  let raw: string;
  try { raw = fs.readFileSync(filePath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new ApprovalError("corrupt_store"); }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { requests?: unknown }).requests)) throw new ApprovalError("corrupt_store");
  const records = new Map<string, StoredRequest>();
  for (const entry of (parsed as { requests: unknown[] }).requests) {
    const record = sanitize(entry);
    if (record) records.set(record.id, record);
  }
  return records;
}

function sanitize(entry: unknown): StoredRequest | null {
  if (!entry || typeof entry !== "object") return null;
  const value = entry as Record<string, unknown>;
  if (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 128) return null;
  if (typeof value.type !== "string" || value.type.length < 1 || value.type.length > 128) return null;
  if (value.retention !== "disk") return null;
  if (value.status !== "pending") return null;
  if (typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") return null;
  return {
    id: value.id,
    type: value.type,
    retention: "disk",
    status: value.status as ApprovalStatus,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    payload: value.payload,
  };
}

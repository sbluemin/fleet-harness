import { APPROVAL_ANSWER_ROUTE, APPROVAL_CHANNEL, APPROVAL_LIST_ROUTE, APPROVAL_NOTICE_CHANNEL, type ApprovalDecision, type ApprovalEndReason, type ApprovalRequestView, type ApprovalSnapshot } from "@fleet-console/approval/contract";
import { subscribeConsoleChannel } from "../../../../core/client/src/integration/objective-records-sse.js";

/**
 * 전역 승인 목록. 스냅숏은 대기만 담고, 끝난 요청은 `approval:notice` 한 번으로만 알린다.
 * 새 요청은 낭독 문구만 올리고 초점은 옮기지 않는다.
 */

export interface ApprovalItem {
  readonly id: string;
  readonly type: string;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ApprovalToast {
  readonly key: string;
  readonly status: string;
  readonly reason?: ApprovalEndReason;
  readonly type: string;
}

const listeners = new Set<() => void>();
let items: readonly ApprovalItem[] = [];
let tick = 0;
let open = false;
let toasts: readonly ApprovalToast[] = [];
let announce = "";
let seen: ReadonlySet<string> | null = null;
/** 첫 스냅숏 이후에 새로 생긴 대기 id마다 1씩. 첫 로드에 이미 있던 요청은 세지 않는다. */
let arrival = 0;
let installed = false;

export function subscribeApprovals(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function emit(): void {
  tick += 1;
  for (const listener of listeners) listener();
}

export function approvalTick(): number {
  return tick;
}

export function approvalItems(): readonly ApprovalItem[] {
  return items;
}

export function approvalOpen(): boolean {
  return open;
}

export function approvalToasts(): readonly ApprovalToast[] {
  return toasts;
}

export function approvalAnnounce(): string {
  return announce;
}

export function approvalArrival(): number {
  return arrival;
}

export function openApprovalList(): void {
  if (open) return;
  open = true;
  emit();
}

export function closeApprovalList(): void {
  if (!open) return;
  open = false;
  emit();
}

export function toggleApprovalList(): void {
  open = !open;
  emit();
}

function readPayload(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Readonly<Record<string, unknown>>;
}

function readItem(value: unknown): ApprovalItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<ApprovalRequestView>;
  if (typeof record.id !== "string" || typeof record.type !== "string" || record.status !== "pending") return null;
  if (typeof record.createdAt !== "number") return null;
  return {
    id: record.id,
    type: record.type,
    createdAt: record.createdAt,
    ...(typeof record.expiresAt === "number" ? { expiresAt: record.expiresAt } : {}),
    payload: readPayload(record.payload),
  };
}

function applySnapshot(value: unknown): void {
  const requests = value && typeof value === "object" ? (value as Partial<ApprovalSnapshot>).requests : undefined;
  const next = Array.isArray(requests) ? requests.flatMap((entry) => { const item = readItem(entry); return item ? [item] : []; }) : [];
  const ids = new Set(next.map((item) => item.id));
  if (seen !== null) {
    const fresh = next.find((item) => !seen!.has(item.id));
    if (fresh) {
      announce = fresh.type;
      arrival += 1;
    }
  }
  seen = ids;
  items = next;
  emit();
}

function pushToast(record: Partial<ApprovalRequestView>): void {
  if (typeof record.id !== "string" || typeof record.type !== "string" || typeof record.status !== "string" || record.status === "pending") return;
  const reason = record.reason;
  const toast: ApprovalToast = { key: `${record.id}:${record.status}:${reason ?? ""}`, status: record.status, type: record.type, ...(reason ? { reason } : {}) };
  toasts = [...toasts.filter((entry) => entry.key !== toast.key), toast].slice(-4);
  announce = `notice:${toast.key}`;
  emit();
  window.setTimeout(() => {
    toasts = toasts.filter((entry) => entry.key !== toast.key);
    emit();
  }, 3800);
}

export function installApprovals(): () => void {
  if (installed) return () => {};
  installed = true;
  let streamed = false;
  const stopState = subscribeConsoleChannel(APPROVAL_CHANNEL, (payload) => {
    streamed = true;
    applySnapshot(payload);
  });
  const stopNotice = subscribeConsoleChannel(APPROVAL_NOTICE_CHANNEL, (payload) => {
    if (payload && typeof payload === "object") pushToast(payload as Partial<ApprovalRequestView>);
  });
  void fetch(`/api/v1/${APPROVAL_LIST_ROUTE}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    .then(async (response) => {
      if (!response.ok || streamed) return;
      applySnapshot(await response.json());
    })
    .catch(() => undefined);
  return () => {
    installed = false;
    stopState();
    stopNotice();
  };
}

export async function answerApproval(id: string, decision: ApprovalDecision): Promise<void> {
  const response = await fetch(`/api/v1/${APPROVAL_ANSWER_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, decision }),
  });
  if (response.ok) return;
  let code = "failed";
  try {
    const body = await response.json() as { error?: unknown };
    if (body.error === "experiment_disabled") code = "experiment_disabled";
  } catch { /* 본문이 없으면 일반 실패 */ }
  throw new Error(code);
}

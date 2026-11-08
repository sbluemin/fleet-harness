import { ApprovalError, type ApprovalCore } from "@fleet-console/approval";

import type { ComputerUseLedger, UseHoldOutcome, UseRequestView } from "./use-requests.js";
import { USE_REQUEST_HOLD_MS } from "./use-requests.js";
import type { ObjectiveRecord } from "../../objectives/shared/records/types.js";

/**
 * 컴퓨터 사용 허용 요청의 기록은 승인 코어뿐이다.
 * objective-use 스냅숏의 computer 요청과 예전 응답 라우트는 이 기록을 투영한다.
 * 콘솔 사용 요청은 여기 없다.
 */

export const COMPUTER_USE_APPROVAL_TYPE = "computer.use";

interface ComputerUseApprovalPayload {
  readonly objectiveId: string;
  readonly tools: readonly string[];
  readonly requestedBy: readonly string[];
}

export function bindComputerUseApprovals(deps: {
  readonly core: ApprovalCore;
  readonly experimentEnabled: () => boolean;
  readonly language: () => "en" | "ko" | null;
  readonly read: (objectiveId: string) => ObjectiveRecord | null;
  readonly patch: (objectiveId: string, input: ObjectiveRecord) => void;
}): { readonly ledger: ComputerUseLedger; dispose(): void } {
  deps.core.register({
    id: COMPUTER_USE_APPROVAL_TYPE,
    retention: "memory",
    ttlMs: USE_REQUEST_HOLD_MS,
    decisions: ["always", "declined"],
    parse(payload) {
      const parsed = readPayload(payload);
      if (!parsed) throw new ApprovalError("invalid_request");
      return parsed;
    },
    onApprove(record) {
      const payload = readPayload(record.payload);
      const objective = payload ? deps.read(payload.objectiveId) : null;
      if (!payload || !objective) return "missing";
      // 실험이 꺼져 있으면 요청은 그대로 두고 409 experiment_disabled. 예전 라우트와 같다.
      if (!deps.experimentEnabled()) throw new ApprovalError("experiment_disabled");
      // 예전 라우트가 이미 스위치를 켰으면 언어를 덮어쓰지 않는다. 승인 라우트만 답하면 여기서 켠다.
      if (!computerUseEnabled(objective)) deps.patch(payload.objectiveId, { ...objective, computerUse: { enabled: true, language: deps.language() ?? "en" } });
      return "approved";
    },
  });

  const listeners = new Set<(requestId: string, outcome: UseHoldOutcome) => void>();
  const unsubscribe = deps.core.subscribeSettled((record) => {
    if (record.type !== COMPUTER_USE_APPROVAL_TYPE) return;
    const outcome: UseHoldOutcome = record.status === "approved" ? "always" : record.status === "rejected" ? "declined" : record.status === "expired" ? "no_response" : "withdrawn";
    for (const listener of listeners) listener(record.id, outcome);
  });

  const pending = () => deps.core.snapshot().requests.filter((request) => request.type === COMPUTER_USE_APPROVAL_TYPE && request.status === "pending");
  const viewOf = (request: { readonly id: string; readonly expiresAt?: number; readonly payload: unknown }): UseRequestView | null => {
    const payload = readPayload(request.payload);
    if (!payload || request.expiresAt === undefined) return null;
    return { id: request.id, objectiveId: payload.objectiveId, capability: "computer", tools: payload.tools, requestedBy: payload.requestedBy, expiresAt: request.expiresAt };
  };

  const ledger: ComputerUseLedger = {
    upsert({ objectiveId, participantId, tool }) {
      const existing = pending().find((request) => readPayload(request.payload)?.objectiveId === objectiveId);
      const actor = participantId ?? objectiveId;
      if (!existing) {
        const created = deps.core.propose(COMPUTER_USE_APPROVAL_TYPE, { objectiveId, tools: [tool], requestedBy: [actor] } satisfies ComputerUseApprovalPayload);
        return { id: created.id, expiresAt: created.expiresAt! };
      }
      const payload = readPayload(existing.payload)!;
      const tools = payload.tools.includes(tool) ? payload.tools : [...payload.tools, tool];
      const requestedBy = payload.requestedBy.includes(actor) ? payload.requestedBy : [...payload.requestedBy, actor];
      if (tools !== payload.tools || requestedBy !== payload.requestedBy) deps.core.amend(existing.id, { objectiveId, tools, requestedBy });
      return { id: existing.id, expiresAt: existing.expiresAt! };
    },
    answer(_objectiveId, requestId, decision) {
      try {
        deps.core.answer(requestId, decision === "deny" ? "declined" : "always");
        return { ok: true, capability: "computer" };
      } catch (error) {
        if (error instanceof ApprovalError && (error.code === "unknown_request" || error.code === "invalid_request" || error.code === "approval_failed")) return { ok: false, error: "request_not_found" };
        throw error;
      }
    },
    release(requestId) {
      try { deps.core.withdraw(requestId); } catch (error) {
        if (!(error instanceof ApprovalError)) throw error;
      }
    },
    list() {
      return pending().flatMap((request) => {
        const view = viewOf(request);
        return view ? [view] : [];
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return { ledger, dispose: unsubscribe };
}

function computerUseEnabled(objective: ObjectiveRecord): boolean {
  const value = (objective as { computerUse?: { enabled?: boolean } }).computerUse;
  return value?.enabled === true;
}

function readPayload(payload: unknown): ComputerUseApprovalPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.objectiveId !== "string" || value.objectiveId.length < 1 || value.objectiveId.length > 128) return null;
  if (!Array.isArray(value.tools) || !value.tools.every((tool) => typeof tool === "string")) return null;
  if (!Array.isArray(value.requestedBy) || !value.requestedBy.every((id) => typeof id === "string")) return null;
  return { objectiveId: value.objectiveId, tools: value.tools, requestedBy: value.requestedBy };
}

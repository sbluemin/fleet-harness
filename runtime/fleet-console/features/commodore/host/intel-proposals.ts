import { ApprovalError, type ApprovalCore, type ApprovalEndReason, type ApprovalRequestView, type ApprovalStatus } from "@fleet-console/approval";

import { INTEL_PROPOSAL_TYPE, type IntelProposalPayload } from "../shared/contracts/intel-proposal.js";
import { MAX_INTEL_TEXT } from "../shared/contracts/types.js";
import type { CommodoreStore } from "./store.js";

/**
 * 정보 변경 제안. 대상 사령관마다 열린 제안은 하나(add·edit·remove 중 하나)고, 새 제안이 이전 것을 밀어낸다.
 * 승인하면 그 순간의 항목을 제안대로 덮어쓴다. 고치거나 지울 항목이 이미 없으면 반영하지 않고 제안을 끝낸다.
 * 추가는 `commodore:<제안자>` 출처의 addIntel 이다.
 */

export interface CommodoreIntelProposals {
  proposeAdd(targetId: string, text: string): ApprovalRequestView;
  proposeEdit(targetId: string, intelId: string, text: string): ApprovalRequestView;
  proposeRemove(targetId: string, intelId: string): ApprovalRequestView;
  /** 이 사령관이 지금 열어 둔 정보 제안. 끝난 제안은 남지 않는다. */
  list(): readonly ApprovalRequestView[];
}

export interface IntelProposalBinding {
  forCommodore(commodoreId: string): CommodoreIntelProposals;
  dispose(): void;
}

const DECISIONS = ["approve", "reject"] as const;

export function bindIntelProposals(deps: {
  readonly core: ApprovalCore;
  readonly store: CommodoreStore;
  readonly known: (commodoreId: string) => boolean;
  readonly onSettled?: (proposerId: string, status: ApprovalStatus, reason?: ApprovalEndReason) => void;
  readonly onReplaced?: (proposerId: string) => void;
}): IntelProposalBinding {
  const displace = (targetId: string, nextProposer: string) => {
    for (const request of deps.core.snapshot().requests) {
      if (request.type !== INTEL_PROPOSAL_TYPE || request.status !== "pending") continue;
      const payload = readPayload(request.payload);
      if (!payload || payload.targetId !== targetId) continue;
      deps.core.withdraw(request.id, "replaced");
      if (payload.proposerId !== nextProposer) deps.onReplaced?.(payload.proposerId);
    }
  };

  deps.core.register({
    id: INTEL_PROPOSAL_TYPE,
    retention: "disk",
    decisions: DECISIONS,
    parse(payload) {
      const parsed = readPayload(payload);
      if (!parsed) throw new ApprovalError("invalid_request");
      return parsed;
    },
    onApprove(record) {
      const payload = readPayload(record.payload);
      const state = payload && deps.known(payload.targetId) ? deps.store.read(payload.targetId) : null;
      if (!payload || !state) return "missing";
      if (payload.kind === "add") {
        deps.store.addIntel(payload.targetId, { text: payload.text, source: `commodore:${payload.proposerId}` });
        return "approved";
      }
      const item = state.intel.find((entry) => entry.id === payload.intelId);
      if (!item) return "missing";
      if (payload.kind === "edit") deps.store.editIntel(payload.targetId, payload.intelId, payload.text);
      else deps.store.removeIntel(payload.targetId, payload.intelId);
      return "approved";
    },
  });

  const unsubscribe = deps.core.subscribeSettled((record) => {
    if (record.type !== INTEL_PROPOSAL_TYPE || record.reason === "replaced") return;
    const payload = readPayload(record.payload);
    if (payload) deps.onSettled?.(payload.proposerId, record.status, record.reason);
  });

  const textOf = (value: string) => {
    const text = value.trim();
    if (!text || text.length > MAX_INTEL_TEXT) throw new Error("invalid_request");
    return text;
  };
  const target = (proposerId: string, targetId: string) => {
    if (!deps.known(proposerId) || !deps.known(targetId)) throw new Error("unknown_commodore");
    const state = deps.store.read(targetId);
    if (!state) throw new Error("unknown_commodore");
    return state;
  };

  return {
    forCommodore: (commodoreId) => ({
      proposeAdd: (targetId, text) => {
        target(commodoreId, targetId);
        displace(targetId, commodoreId);
        return deps.core.propose(INTEL_PROPOSAL_TYPE, { kind: "add", proposerId: commodoreId, targetId, text: textOf(text) } satisfies IntelProposalPayload);
      },
      proposeEdit: (targetId, intelId, text) => {
        const item = target(commodoreId, targetId).intel.find((entry) => entry.id === intelId);
        if (!item) throw new Error("unknown_intel");
        displace(targetId, commodoreId);
        return deps.core.propose(INTEL_PROPOSAL_TYPE, { kind: "edit", proposerId: commodoreId, targetId, intelId, text: textOf(text) } satisfies IntelProposalPayload);
      },
      proposeRemove: (targetId, intelId) => {
        const item = target(commodoreId, targetId).intel.find((entry) => entry.id === intelId);
        if (!item) throw new Error("unknown_intel");
        displace(targetId, commodoreId);
        return deps.core.propose(INTEL_PROPOSAL_TYPE, { kind: "remove", proposerId: commodoreId, targetId, intelId } satisfies IntelProposalPayload);
      },
      list: () => deps.core.snapshot().requests.filter((request) => request.type === INTEL_PROPOSAL_TYPE && readPayload(request.payload)?.proposerId === commodoreId),
    }),
    dispose: unsubscribe,
  };
}

function readPayload(payload: unknown): IntelProposalPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (value.kind !== "add" && value.kind !== "edit" && value.kind !== "remove") return null;
  if (typeof value.proposerId !== "string" || value.proposerId.length < 1 || value.proposerId.length > 128) return null;
  if (typeof value.targetId !== "string" || value.targetId.length < 1 || value.targetId.length > 128) return null;
  if (value.kind === "add") {
    if (typeof value.text !== "string" || !value.text.trim() || value.text.trim().length > MAX_INTEL_TEXT) return null;
    return { kind: "add", proposerId: value.proposerId, targetId: value.targetId, text: value.text.trim() };
  }
  if (typeof value.intelId !== "string" || value.intelId.length < 1 || value.intelId.length > 128) return null;
  if (value.kind === "remove") return { kind: "remove", proposerId: value.proposerId, targetId: value.targetId, intelId: value.intelId };
  if (typeof value.text !== "string" || !value.text.trim() || value.text.trim().length > MAX_INTEL_TEXT) return null;
  return { kind: "edit", proposerId: value.proposerId, targetId: value.targetId, intelId: value.intelId, text: value.text.trim() };
}

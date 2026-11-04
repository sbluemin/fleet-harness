import { ApprovalError, type ApprovalCore, type ApprovalDecision, type ApprovalEndReason, type ApprovalRequestView, type ApprovalStatus } from "@fleet-console/approval";

import { DESCRIPTION_PROPOSAL_TYPE, type DescriptionProposalPayload } from "../shared/contracts/description-proposal.js";
import { MAX_DESCRIPTION } from "../shared/contracts/types.js";
import type { CommodoreStore } from "./store.js";

/**
 * 설명 변경 제안. 대상 사령관마다 열린 제안은 하나고, 새 제안이 이전 것을 밀어낸다(withdrawn, replaced).
 * 사람이 승인하면 그 순간의 설명을 제안 문안으로 덮어쓴다. 그 사이 사람이 고쳤어도 같다.
 * 승인하면 `store.setDescription` 으로 rev 가 오르고, 대상 사령관은 description changed 로 깨어난다.
 */

export interface CommodoreDescriptionProposals {
  propose(targetId: string, text: string): ApprovalRequestView;
  /** 이 사령관이 지금 열어 둔 제안. 끝난 제안은 남지 않는다. */
  list(): readonly ApprovalRequestView[];
}

export interface DescriptionProposalBinding {
  forCommodore(commodoreId: string): CommodoreDescriptionProposals;
  dispose(): void;
}

const DECISIONS = ["approve", "reject"] as const satisfies readonly ApprovalDecision[];

export function bindDescriptionProposals(deps: {
  readonly core: ApprovalCore;
  readonly store: CommodoreStore;
  readonly known: (commodoreId: string) => boolean;
  /** 결말. `replaced` 는 여기서 울리지 않는다 — 제안자가 다를 때만 `onReplaced` 가 울린다. */
  readonly onSettled?: (proposerId: string, status: ApprovalStatus, reason?: ApprovalEndReason) => void;
  readonly onReplaced?: (proposerId: string) => void;
}): DescriptionProposalBinding {
  const displace = (targetId: string, nextProposer: string) => {
    for (const request of deps.core.snapshot().requests) {
      if (request.type !== DESCRIPTION_PROPOSAL_TYPE || request.status !== "pending") continue;
      const payload = readPayload(request.payload);
      if (!payload || payload.targetId !== targetId) continue;
      deps.core.withdraw(request.id, "replaced");
      if (payload.proposerId !== nextProposer) deps.onReplaced?.(payload.proposerId);
    }
  };

  deps.core.register({
    id: DESCRIPTION_PROPOSAL_TYPE,
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
      deps.store.setDescription(payload.targetId, payload.text);
      return "approved";
    },
  });

  const unsubscribeSettled = deps.core.subscribeSettled((record) => {
    if (record.type !== DESCRIPTION_PROPOSAL_TYPE || record.reason === "replaced") return;
    const payload = readPayload(record.payload);
    if (payload) deps.onSettled?.(payload.proposerId, record.status, record.reason);
  });

  const propose = (proposerId: string, targetId: string, text: string): ApprovalRequestView => {
    if (!deps.known(proposerId) || !deps.known(targetId)) throw new Error("unknown_commodore");
    if (text.length > MAX_DESCRIPTION) throw new Error("invalid_request");
    const state = deps.store.read(targetId);
    if (!state) throw new Error("unknown_commodore");
    if (state.description.text === text) throw new Error("unchanged");
    displace(targetId, proposerId);
    return deps.core.propose(DESCRIPTION_PROPOSAL_TYPE, { proposerId, targetId, text } satisfies DescriptionProposalPayload);
  };

  return {
    forCommodore: (commodoreId) => ({
      propose: (targetId, text) => propose(commodoreId, targetId, text),
      list: () => deps.core.snapshot().requests.filter((request) => request.type === DESCRIPTION_PROPOSAL_TYPE && readPayload(request.payload)?.proposerId === commodoreId),
    }),
    dispose() { unsubscribeSettled(); },
  };
}

function readPayload(payload: unknown): DescriptionProposalPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.proposerId !== "string" || value.proposerId.length < 1 || value.proposerId.length > 128) return null;
  if (typeof value.targetId !== "string" || value.targetId.length < 1 || value.targetId.length > 128) return null;
  if (typeof value.text !== "string" || value.text.length > MAX_DESCRIPTION) return null;
  return { proposerId: value.proposerId, targetId: value.targetId, text: value.text };
}

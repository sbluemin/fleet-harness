import { ApprovalError, type ApprovalCore, type ApprovalDecision, type ApprovalRequestView, type ApprovalStatus } from "@fleet-console/approval";

import { DESCRIPTION_PROPOSAL_TYPE, type DescriptionProposalPayload } from "../shared/contracts/description-proposal.js";
import { MAX_DESCRIPTION } from "../shared/contracts/types.js";
import type { CommodoreStore } from "./store.js";

/**
 * 설명 변경 제안. 코어에 타입을 등록하고, 사령관 도구는 제안·목록만 받는다.
 * 사람이 승인하면 `store.setDescription` 으로 rev 가 오르고, 그 사건으로 대상 사령관이 깨어난다.
 * 같은 대상의 다른 제안은 기준 rev 가 달라지는 순간 stale 이 되어 승인되지 않는다. 사람이 설명을 직접 고쳐도 같다.
 */

export interface CommodoreDescriptionProposals {
  propose(targetId: string, text: string): ApprovalRequestView;
  /** 이 사령관이 낸 제안. 결말(승인·거절·낡음)도 여기 있다. */
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
  /** 이 콘솔에 있는 사령관인가. 없으면 제안도 승인도 거절한다. */
  readonly known: (commodoreId: string) => boolean;
  /** 제안한 사령관의 제안이 결말 났을 때. 기동 중 맞추기는 알리지 않는다. */
  readonly onSettled?: (proposerId: string, status: ApprovalStatus) => void;
}): DescriptionProposalBinding {
  let applying: string | null = null;

  const noteRevision = (targetId: string, rev: number) => {
    for (const request of deps.core.snapshot().requests) {
      if (request.id === applying || request.type !== DESCRIPTION_PROPOSAL_TYPE || request.status !== "pending") continue;
      const payload = readPayload(request.payload);
      if (!payload || payload.targetId !== targetId || payload.baseRev === rev) continue;
      deps.core.markStale(request.id);
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
      // rev 가 달라진 제안은 같은 대상의 나머지도 함께 낡는다. 문안이 이미 같으면 이 제안만 낡는다.
      if (!payload || !state || state.description.rev !== payload.baseRev) {
        if (payload) noteRevision(payload.targetId, state?.description.rev ?? payload.baseRev + 1);
        return "stale";
      }
      if (state.description.text === payload.text) return "stale";
      applying = record.id;
      try { deps.store.setDescription(payload.targetId, payload.text); }
      finally { applying = null; }
      return "approved";
    },
  });

  const unsubscribeStore = deps.store.subscribe((event) => {
    if (event.op === "state" && event.change === "description") noteRevision(event.commodoreId, event.state.description.rev);
  });
  const unsubscribeSettled = deps.core.subscribeSettled((record) => {
    if (record.type !== DESCRIPTION_PROPOSAL_TYPE) return;
    const payload = readPayload(record.payload);
    if (payload) deps.onSettled?.(payload.proposerId, record.status);
  });

  deps.core.silence(() => {
    for (const request of deps.core.snapshot().requests) {
      if (request.type !== DESCRIPTION_PROPOSAL_TYPE || request.status !== "pending") continue;
      const payload = readPayload(request.payload);
      const state = payload && deps.known(payload.targetId) ? deps.store.read(payload.targetId) : null;
      if (!payload || !state || state.description.rev !== payload.baseRev) deps.core.markStale(request.id);
    }
  });

  const propose = (proposerId: string, targetId: string, text: string): ApprovalRequestView => {
    if (!deps.known(proposerId) || !deps.known(targetId)) throw new Error("unknown_commodore");
    if (text.length > MAX_DESCRIPTION) throw new Error("invalid_request");
    const state = deps.store.read(targetId);
    if (!state) throw new Error("unknown_commodore");
    if (state.description.text === text) throw new Error("unchanged");
    return deps.core.propose(DESCRIPTION_PROPOSAL_TYPE, { proposerId, targetId, baseRev: state.description.rev, text } satisfies DescriptionProposalPayload);
  };

  return {
    forCommodore: (commodoreId) => ({
      propose: (targetId, text) => propose(commodoreId, targetId, text),
      list: () => deps.core.snapshot().requests.filter((request) => {
        if (request.type !== DESCRIPTION_PROPOSAL_TYPE) return false;
        return readPayload(request.payload)?.proposerId === commodoreId;
      }),
    }),
    dispose() {
      unsubscribeStore();
      unsubscribeSettled();
    },
  };
}

function readPayload(payload: unknown): DescriptionProposalPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.proposerId !== "string" || value.proposerId.length < 1 || value.proposerId.length > 128) return null;
  if (typeof value.targetId !== "string" || value.targetId.length < 1 || value.targetId.length > 128) return null;
  if (typeof value.baseRev !== "number" || !Number.isInteger(value.baseRev) || value.baseRev < 0) return null;
  if (typeof value.text !== "string" || value.text.length > MAX_DESCRIPTION) return null;
  return { proposerId: value.proposerId, targetId: value.targetId, baseRev: value.baseRev, text: value.text };
}

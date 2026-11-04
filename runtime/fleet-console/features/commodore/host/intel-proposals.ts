import { ApprovalError, type ApprovalCore, type ApprovalRequestView, type ApprovalStatus } from "@fleet-console/approval";

import { INTEL_PROPOSAL_TYPE, type IntelProposalBase, type IntelProposalPayload } from "../shared/contracts/intel-proposal.js";
import { MAX_INTEL_TEXT } from "../shared/contracts/types.js";
import type { CommodoreStore } from "./store.js";

/**
 * 정보 변경 제안. 추가는 기준이 없어 stale 이 되지 않고, 고침·삭제는 승인하는 순간
 * 항목이 없거나 본문·editedAt 이 기준과 다르면 stale 로 끝내고 반영하지 않는다.
 * 같은 항목의 제안은 모두 남긴다. 하나가 반영된 뒤 나머지는 승인을 시도할 때 stale 이 된다.
 * 승인 경로는 addIntel·editIntel·removeIntel 뿐이고, 추가는 `commodore:<제안자>` 출처다.
 */

export interface CommodoreIntelProposals {
  proposeAdd(targetId: string, text: string): ApprovalRequestView;
  proposeEdit(targetId: string, intelId: string, text: string): ApprovalRequestView;
  proposeRemove(targetId: string, intelId: string): ApprovalRequestView;
  /** 이 사령관이 낸 정보 제안. 결말도 여기 있다. */
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
  readonly onSettled?: (proposerId: string, status: ApprovalStatus) => void;
}): IntelProposalBinding {
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
      if (!payload || !state) return "stale";
      if (payload.kind === "add") {
        deps.store.addIntel(payload.targetId, { text: payload.text, source: `commodore:${payload.proposerId}` });
        return "approved";
      }
      const item = state.intel.find((entry) => entry.id === payload.intelId);
      if (!sameBase(item, payload.base)) return "stale";
      if (payload.kind === "edit") deps.store.editIntel(payload.targetId, payload.intelId, payload.text);
      else deps.store.removeIntel(payload.targetId, payload.intelId);
      return "approved";
    },
  });

  const unsubscribe = deps.core.subscribeSettled((record) => {
    if (record.type !== INTEL_PROPOSAL_TYPE) return;
    const payload = readPayload(record.payload);
    if (payload) deps.onSettled?.(payload.proposerId, record.status);
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
  const baseOf = (proposerId: string, targetId: string, intelId: string): IntelProposalBase => {
    const item = target(proposerId, targetId).intel.find((entry) => entry.id === intelId);
    if (!item) throw new Error("unknown_intel");
    return { editedAt: item.editedAt ?? null, text: item.text };
  };

  return {
    forCommodore: (commodoreId) => ({
      proposeAdd: (targetId, text) => {
        target(commodoreId, targetId);
        return deps.core.propose(INTEL_PROPOSAL_TYPE, { kind: "add", proposerId: commodoreId, targetId, text: textOf(text) } satisfies IntelProposalPayload);
      },
      proposeEdit: (targetId, intelId, text) => deps.core.propose(INTEL_PROPOSAL_TYPE, {
        kind: "edit", proposerId: commodoreId, targetId, intelId, text: textOf(text), base: baseOf(commodoreId, targetId, intelId),
      } satisfies IntelProposalPayload),
      proposeRemove: (targetId, intelId) => deps.core.propose(INTEL_PROPOSAL_TYPE, {
        kind: "remove", proposerId: commodoreId, targetId, intelId, base: baseOf(commodoreId, targetId, intelId),
      } satisfies IntelProposalPayload),
      list: () => deps.core.snapshot().requests.filter((request) => request.type === INTEL_PROPOSAL_TYPE && readPayload(request.payload)?.proposerId === commodoreId),
    }),
    dispose: unsubscribe,
  };
}

function sameBase(item: { readonly text: string; readonly editedAt?: number } | undefined, base: IntelProposalBase): item is { readonly text: string; readonly editedAt?: number } {
  return item !== undefined && item.text === base.text && (item.editedAt ?? null) === base.editedAt;
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
  const base = readBase(value.base);
  if (!base) return null;
  if (value.kind === "remove") return { kind: "remove", proposerId: value.proposerId, targetId: value.targetId, intelId: value.intelId, base };
  if (typeof value.text !== "string" || !value.text.trim() || value.text.trim().length > MAX_INTEL_TEXT) return null;
  return { kind: "edit", proposerId: value.proposerId, targetId: value.targetId, intelId: value.intelId, text: value.text.trim(), base };
}

function readBase(value: unknown): IntelProposalBase | null {
  if (!value || typeof value !== "object") return null;
  const base = value as Record<string, unknown>;
  if (typeof base.text !== "string" || base.text.length < 1 || base.text.length > MAX_INTEL_TEXT) return null;
  if (base.editedAt !== null && (typeof base.editedAt !== "number" || !Number.isInteger(base.editedAt) || base.editedAt < 0)) return null;
  return { editedAt: base.editedAt ?? null, text: base.text };
}

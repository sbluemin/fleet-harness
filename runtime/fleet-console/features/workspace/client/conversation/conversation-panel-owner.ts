import { useConversationSurface } from "./conversation-surface-store.js";
import { useConversationSubject, useConversationStandIn } from "./conversation-slots.js";
import { useClusterIndex } from "../objective-clusters.js";

/** 가운데 대화의 사령관. 사령관 대화와 그 지휘관·구성원·시작 전 목표에서만 값이 있고, 그때 데스크톱은 「구성원」 탭 대신 그 맥락의 패널을 싣는다. 일반 세션·TaskForce는 포함하지 않는다. */
export function useConversationPanelOwner(): string | null {
  const surface = useConversationSurface();
  const subject = useConversationSubject();
  const standIn = useConversationStandIn();
  const index = useClusterIndex();
  if (surface?.surfaceId === "commodore") return typeof surface.params.commodoreId === "string" ? surface.params.commodoreId : null;
  if (surface !== null && surface.surfaceId !== "objective-fresh") return null;
  const rootId = subject ? subject.parentObjectiveId ?? subject.id : standIn;
  if (surface?.surfaceId === "objective-fresh" && typeof surface.params.commodoreId === "string") return surface.params.commodoreId;
  return rootId === null ? null : index.clusters.find((cluster) => cluster.conversation?.objectiveId === rootId)?.commodoreId ?? null;
}

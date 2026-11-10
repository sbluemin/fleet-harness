import { useConversationSurface } from "./conversation-surface-store.js";
import { useConversationSubject, useConversationStandIn } from "./conversation-slots.js";
import { useClusterIndex } from "../objective-clusters.js";

/** 사령관·그 지휘관 대화만 우측 사령관 패널을 소유한다. 일반 세션·TaskForce는 포함하지 않는다. */
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

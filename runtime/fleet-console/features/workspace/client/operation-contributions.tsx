import { FeatureErrorBoundary } from "@fleet-console/ui/react";
import type { OperationNode } from "../../execution/shared/operations/types.js";

import { useFeatureRegistry } from "../../../core/client/src/integration/feature-registry.js";

/**
 * Operation 을 소유하지 않는 플러그인이 캡션·칩에 얹는 표식. 한 기여의 실패가 캡션을 비우지 않도록 각각 경계로 감싼다.
 */
export function OperationCaptionContributions({ operation, language, surface }: { readonly operation: OperationNode; readonly language: "en" | "ko"; readonly surface: "caption" | "chip" }) {
  const registry = useFeatureRegistry();
  if (registry.operationCaptionContributions.length === 0) return null;
  return (
    <>
      {registry.operationCaptionContributions.map((contribution) => (
        <FeatureErrorBoundary key={contribution.id} fallback={<></>}>
          {contribution.render({ operation, language, surface })}
        </FeatureErrorBoundary>
      ))}
    </>
  );
}

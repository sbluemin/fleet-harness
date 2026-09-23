import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { OperationNode } from "@fleet-console/sdk/operations";

import { usePluginRegistry } from "../../../core/client/src/integration/plugin-registry.js";

/**
 * Operation 을 소유하지 않는 플러그인이 캡션·칩에 얹는 표식. 한 기여의 실패가 캡션을 비우지 않도록 각각 경계로 감싼다.
 */
export function OperationCaptionContributions({ operation, language, surface }: { readonly operation: OperationNode; readonly language: "en" | "ko"; readonly surface: "caption" | "chip" }) {
  const registry = usePluginRegistry();
  if (registry.operationCaptionContributions.length === 0) return null;
  return (
    <>
      {registry.operationCaptionContributions.map((contribution) => (
        <PluginErrorBoundary key={contribution.id} fallback={<></>}>
          {contribution.render({ operation, language, surface })}
        </PluginErrorBoundary>
      ))}
    </>
  );
}

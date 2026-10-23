import { createContext, useContext, useRef, type ReactNode } from "react";
import type { ComposerTopEntryDescriptor } from "../../../../workspace/shared/surface-contracts.js";
import { FeatureErrorBoundary } from "@fleet-console/ui/react";
import { useViewMode } from "../../../../../core/client/src/integration/view-mode-store.js";

// 호스트 조합 루트가 레지스트리 기여를 명시적으로 주입한다. 플러그인은 이 호스트 번들의 Context를 읽지 않는다.
const ComposerTopEntriesContext = createContext<readonly ComposerTopEntryDescriptor[]>([]);
export const ComposerTopEntriesProvider = ComposerTopEntriesContext.Provider;

/** 대화 표면이 명시적으로 요청한 요약 칸. 플러그인의 팝업은 이 줄을 닻으로 삼는다. */
export function ComposerTopEntries({ leading }: { readonly leading?: ReactNode }) {
  const entries = useContext(ComposerTopEntriesContext);
  const layout = useViewMode().effective;
  const popoverAnchorRef = useRef<HTMLSpanElement>(null);
  if (!entries.length && !leading) return null;
  return <div className={`conversation-composer-top${leading ? " is-unified" : ""}`}>
    {leading}
    <span className="conversation-composer-top-content" ref={popoverAnchorRef}>
    {entries.map((entry) => {
      const Render = entry.render;
      return <FeatureErrorBoundary key={entry.id} fallback={null}><Render popoverAnchorRef={popoverAnchorRef} layout={layout} /></FeatureErrorBoundary>;
    })}
  </span></div>;
}

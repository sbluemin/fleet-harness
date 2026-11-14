import { createContext, useContext, useRef, type ReactNode } from "react";
import type { ComposerTopEntryDescriptor } from "../../../../workspace/shared/surface-contracts.js";
import { FeatureErrorBoundary } from "@fleet-console/ui/react";
import { useViewMode } from "../../../../../core/client/src/integration/view-mode-store.js";

// 호스트 조합 루트가 레지스트리 기여를 명시적으로 주입한다. 플러그인은 이 호스트 번들의 Context를 읽지 않는다.
const ComposerTopEntriesContext = createContext<readonly ComposerTopEntryDescriptor[]>([]);
export const ComposerTopEntriesProvider = ComposerTopEntriesContext.Provider;

/** 대화 표면이 명시적으로 요청한 요약 칸. 플러그인의 팝업은 이 줄을 닻으로 삼는다. */
export function ComposerTopEntries({ leading, end, omitEntries = false }: {
  readonly leading?: ReactNode;
  readonly end?: ReactNode;
  readonly omitEntries?: boolean;
}) {
  const entries = useContext(ComposerTopEntriesContext);
  const layout = useViewMode().effective;
  const popoverAnchorRef = useRef<HTMLSpanElement>(null);
  const showEntries = !omitEntries && entries.length > 0;
  if (!showEntries && !leading && !end) return null;
  return (
    <div className={`conversation-composer-top${leading ? " is-unified" : ""}${end ? " has-end" : ""}`}>
      {leading}
      {end ? <span className="conversation-composer-top-end">{end}</span> : null}
      {showEntries ? (
        <span className="conversation-composer-top-content" ref={popoverAnchorRef}>
          {entries.map((entry) => {
            const Render = entry.render;
            return <FeatureErrorBoundary key={entry.id} fallback={null}><Render popoverAnchorRef={popoverAnchorRef} layout={layout} placement="top" /></FeatureErrorBoundary>;
          })}
        </span>
      ) : null}
    </div>
  );
}

/** 입력 캡슐 안 오른쪽(보내기 버튼 왼쪽)에 서는 요약 칸. 항목이 비면 null 을 돌려 구분선도 세우지 않는다. */
export function ComposerTrailingEntries() {
  const entries = useContext(ComposerTopEntriesContext);
  const layout = useViewMode().effective;
  const popoverAnchorRef = useRef<HTMLSpanElement>(null);
  if (!entries.length) return null;
  return (
    <span className="conversation-composer-trailing" ref={popoverAnchorRef}>
      {entries.map((entry) => {
        const Render = entry.render;
        return <FeatureErrorBoundary key={entry.id} fallback={null}><Render popoverAnchorRef={popoverAnchorRef} layout={layout} placement="capsule" /></FeatureErrorBoundary>;
      })}
    </span>
  );
}

import { useMemo, useState } from "react";

import { resolveOperationActivity, resolveOperationMarkVisual } from "../../../../../features/execution/client/operation-activity.js";
import { getIdleArrivalIds } from "../../../../../features/execution/client/operation-marks.js";
import { statusGlyphClassName } from "@fleet-console/sdk/components/status-glyph";

import { useT } from "../../i18n/index.js";
import { focusOperation } from "../../integration/store.js";
import type { ConsoleState } from "../../integration/types.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { setMobileDestination } from "./mobile-store.js";

/** 검색(S-41) — 모든 Theater의 작업을 제목으로 찾는다. 결과 행은 드로어 행 문법, 보조 줄은 「Theater · 상태 낱말」. */
export function MobileSearchScreen({ state, onBack }: { readonly state: ConsoleState; readonly onBack: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  useClaimMobileBar({ variant: "centered", title: "", leading: "back", onBack });
  const idleArrivals = getIdleArrivalIds();
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    return state.operations.filter((operation) => operation.title.toLowerCase().includes(needle));
  }, [query, state.operations]);
  return (
    <section className="mobile-search-screen">
      <div className="mobile-search-field">
        <input className="mobile-field" autoFocus value={query} placeholder={t("mobile.search.placeholder")} aria-label={t("mobile.search.aria")} spellCheck={false} autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
      </div>
      {query.trim() !== "" && results.length === 0 ? <p className="mobile-attention-empty">{t("mobile.search.empty")}</p> : null}
      {results.map((operation) => {
        const mark = resolveOperationMarkVisual({ activity: resolveOperationActivity(operation, state.operationRuntime), operationId: operation.id, idleArrivalIds: idleArrivals });
        const theater = state.theaters.find((item) => item.id === operation.theaterId);
        return (
          <button type="button" className="mobile-drawer-row is-tall mobile-search-row" key={operation.id} onClick={() => { setMobileDestination({ kind: "home" }); focusOperation(operation.id); }}>
            <span className="mobile-drawer-row-glyph"><span className={statusGlyphClassName(mark)} aria-hidden="true" /></span>
            <span className="mobile-drawer-row-copy">
              <span className="mobile-drawer-row-title">{operation.title}</span>
              <small className="is-plain">{[theater?.label, t(`mobile.search.state.${mark}`)].filter(Boolean).join(" · ")}</small>
            </span>
          </button>
        );
      })}
    </section>
  );
}

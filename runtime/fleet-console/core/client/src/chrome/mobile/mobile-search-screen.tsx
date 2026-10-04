import { useEffect, useMemo, useState } from "react";

import { resolveOperationActivity, resolveOperationMarkVisual } from "../../../../../features/execution/client/operation-activity.js";
import { getIdleArrivalIds } from "../../../../../features/execution/client/operation-marks.js";
import { statusGlyphClassName } from "@fleet-console/sdk/components/status-glyph";

import { useT } from "../../i18n/index.js";
import { focusOperation } from "../../integration/store.js";
import type { ConsoleState } from "../../integration/types.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { refreshOperationArchive, useOperationArchive } from "../../integration/operation-archive.js";
import { ArchiveRows, useArchiveRestore } from "./mobile-archive-screen.js";
import { setMobileDestination } from "./mobile-store.js";

/** 검색(S-41) — 모든 Theater의 작업을 제목으로 찾는다. 결과 행은 드로어 행 문법, 보조 줄은 「Theater · 상태 낱말」. */
export function MobileSearchScreen({ state, scope, onBack }: { readonly state: ConsoleState; readonly scope?: "archive"; readonly onBack: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const archive = useOperationArchive();
  const { busy, restored, restore } = useArchiveRestore();
  useEffect(() => { if (scope === "archive") void refreshOperationArchive(); }, [scope]);
  // 보관함 안 검색(D34): 보관한 작업 제목에서 찾고, 결과 행에서 복원한다.
  const archived = useMemo(() => {
    if (scope !== "archive") return [];
    const needle = query.trim().toLowerCase();
    return (archive.snapshot?.entries ?? []).filter((entry) => !restored.has(entry.operation.id) && (needle === "" || entry.operation.title.toLowerCase().includes(needle)));
  }, [archive.snapshot, query, restored, scope]);
  useClaimMobileBar({ variant: "centered", title: "", leading: "back", onBack });
  const idleArrivals = getIdleArrivalIds();
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return state.operations;
    return state.operations.filter((operation) => operation.title.toLowerCase().includes(needle));
  }, [query, state.operations]);
  return (
    <section className="mobile-search-screen">
      <div className="mobile-search-field">
        <input className="mobile-field" autoFocus value={query} placeholder={t(scope === "archive" ? "mobile.search.placeholderArchive" : "mobile.search.placeholder")} aria-label={t(scope === "archive" ? "mobile.search.ariaArchive" : "mobile.search.aria")} spellCheck={false} autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
      </div>
      {scope === "archive" ? (
        archived.length === 0 ? <p className="mobile-attention-empty">{t("mobile.search.emptyArchive")}</p> : <ArchiveRows entries={archived} state={state} restore={restore} busy={busy} />
      ) : null}
      {scope !== "archive" && results.length === 0 ? <p className="mobile-attention-empty">{t("mobile.search.empty")}</p> : null}
      {scope === "archive" ? null : results.map((operation) => {
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

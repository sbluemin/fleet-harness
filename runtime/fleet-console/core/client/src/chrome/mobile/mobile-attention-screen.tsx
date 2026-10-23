import { useSyncExternalStore } from "react";

import { resolveLocalizedText } from "@fleet-console/i18n/translate";

import { ObjectiveStatusIcon } from "../../../../../features/execution/client/components/objective-status-icon.js";
import { useClusterIndex } from "../../../../../features/workspace/client/objective-clusters.js";
import { resolveObjectiveActivity, resolveObjectiveMarkVisual } from "../../../../../features/execution/client/objective-activity.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../../../../../features/execution/client/objective-marks.js";

import { useConsoleLocale, useT } from "../../i18n/index.js";
import { navigateConsoleRoute } from "../../integration/console-location.js";
import { focusObjective } from "../../integration/store.js";
import { useConsoleState } from "../../hooks/use-store.js";
import { AttentionReason } from "./mobile-attention-reason.js";
import { useMobileAttentionRows } from "./mobile-attention-context.js";
import { MobileMarkedRow } from "./mobile-row-mark.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { attentionMovesFirst, entryIconOf } from "./mobile-destinations.js";
import { getViewedTheaterId } from "../../integration/viewed-theater.js";
import { openMobilePluginDestination, setMobileDestination } from "./mobile-store.js";

/** S-35 「확인 필요」 전체 화면 — 홈 맨 위 묶음이 세 건까지만 싣는 것의 전부. 답하면 이 목록에서 빠진다. */
export function MobileAttentionScreen() {
  const t = useT();
  const rows = useMobileAttentionRows();
  const locale = useConsoleLocale();
  const bindings = useRailEntries();
  const state = useConsoleState();
  const clusterIndex = useClusterIndex();
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  // 플러그인 항목의 오른쪽 값은 그 항목이 온 목적지의 이름(예: 「목표」)이다 — 어디서 온 일인지 알린다.
  const sourceName = (entryId: string): string | null => {
    const entry = bindings.find((binding) => binding.entry.id === entryId)?.entry;
    return entry ? resolveLocalizedText(entry.mobile?.destination?.label ?? entry.title, locale) : null;
  };
  useClaimMobileBar({ variant: "centered", title: t("mobile.home.attention"), leading: "back" });
  return (
    <section className="mobile-attention-screen">
      {rows.length === 0 ? <p className="mobile-attention-empty">{t("mobile.attention.empty")}</p> : (
        <>
          <div className="mobile-group">
            {rows.map((row) => (
              <MobileMarkedRow key={row.key} mark={(row.kind === "objectiveRecord" ? clusterIndex.rowOf.get(row.objectiveRecord.id) : row.clusterId ? clusterIndex.layouts.get(row.clusterId) : undefined)?.cluster.row?.mark}>
                {row.kind === "objectiveRecord" ? (
                  <button type="button" className="mobile-group-row is-two" onClick={() => { setMobileDestination({ kind: "home" }); navigateConsoleRoute("/objectives"); focusObjective(row.objectiveRecord.id); }}>
                    <ObjectiveStatusIcon objectiveRecord={row.objectiveRecord} status={resolveObjectiveMarkVisual({ activity: resolveObjectiveActivity(row.objectiveRecord, state.objectiveRecordRuntime), objectiveId: row.objectiveRecord.id, idleArrivalIds })} size={28} decorative />
                    <span className="mobile-group-row-copy">{row.objectiveRecord.title}<small className="is-awaiting"><AttentionReason row={row} /></small></span>
                  </button>
                ) : (
                  <button type="button" className="mobile-group-row is-two" onClick={() => { if (attentionMovesFirst(bindings, row.entryId)) { openMobilePluginDestination(row.entryId, getViewedTheaterId()); navigateConsoleRoute("/objectives"); } row.item.open(); }}>
                    <span className="mobile-group-row-icon" aria-hidden="true">{entryIconOf(bindings, row.entryId)}</span>
                    <span className="mobile-group-row-copy">{row.item.title}<small className="is-awaiting"><AttentionReason row={row} /></small></span>
                    {sourceName(row.entryId) ? <span className="mobile-group-row-value">{sourceName(row.entryId)}</span> : null}
                  </button>
                )}
              </MobileMarkedRow>
            ))}
          </div>
          <p className="mobile-secnote">{t("mobile.attention.note")}</p>
        </>
      )}
    </section>
  );
}

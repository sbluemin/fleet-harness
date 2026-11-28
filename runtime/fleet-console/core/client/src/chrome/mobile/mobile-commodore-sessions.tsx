import { useClusterIndex } from "../../../../../features/workspace/client/objective-clusters.js";
import { useAvatarClaims } from "../../../../../features/workspace/client/avatars.js";
import { CommandBoardGlyph } from "../../../../../features/workspace/client/command-board/command-board.js";
import { useCommandBoardEnabled } from "../../../../../features/workspace/client/command-board/command-board-experiment.js";
import { isNotStartedRow, useCommanderRows } from "../../../../../features/workspace/client/commander-tab/commander-rows.js";
import { useConsoleState } from "../../hooks/use-store.js";
import { useT } from "../../i18n/index.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { AttentionReason } from "./mobile-attention.js";
import { MobileArchivedFinished } from "./mobile-archived-finished.js";
import { MobileCommanderList } from "./mobile-commander-list.js";
import { attentionMovesFirst, entryIconOf, useMobileAttention } from "./mobile-destinations.js";
import { openApprovalList } from "../../../../../features/execution/client/approval/store.js";
import { MobileMarkedRow } from "./mobile-row-mark.js";
import { openMobilePluginDestination, setMobileDestination } from "./mobile-store.js";

/** 사령관 세부 첫 화면의 「확인 필요 N」 수 — 플러그인 항목과 사람을 기다리는 세션을 모두 센다. */
export function useMobileCommodoreAttentionCount(commodoreId: string): number {
  return useMobileAttention(useConsoleState(), commodoreId).rows.length;
}

/**
 * 사령관 「지휘관 세션」 — 플러그인 확인 필요 띠, 정렬 가능한 지휘관 명단, 보관한 완료 목표의 입구.
 * 범위는 사령관 UUID다. 사람을 기다리는 지휘관도 명단에 남아 「답할 것 맨 위」 선호를 따른다.
 */
export function MobileCommodoreSessions({ commodoreId, leave }: { readonly commodoreId: string; readonly leave: (run: () => void) => void }) {
  const t = useT();
  const commandBoardEnabled = useCommandBoardEnabled();
  const state = useConsoleState();
  const bindings = useRailEntries();
  const clusterIndex = useClusterIndex();
  const { rows } = useMobileAttention(state, commodoreId);
  const commanderRows = useCommanderRows(commodoreId, null);
  // 폰은 두 입구를 나눈다 — 사령관의 직접 질문은 띠에만, 시작 전·완료 목표는 통합 지휘판에서 관리하므로 여기서는 진행·검토 중인 지휘관만 보여 준다.
  const nonCommodore = commanderRows.sorted.filter((item) => !item.row.commodore);
  const freshCount = nonCommodore.filter((item) => isNotStartedRow(item.row)).length;
  const doneCount = nonCommodore.filter((item) => item.row.glyph === "done").length;
  const sorted = nonCommodore.filter((item) => !isNotStartedRow(item.row) && item.row.glyph !== "done");
  const commanderClusterIds = new Set(sorted.map((item) => item.layout.cluster.id));
  const sections = commanderRows.sections
    .filter((section) => section.fold === null)
    .map((section) => ({ ...section, rows: section.rows.filter((item) => commanderClusterIds.has(item.layout.cluster.id)) }))
    .filter((section) => section.rows.length > 0);
  const attention = rows.filter((row) => row.kind !== "objectiveRecord")
    .filter((row) => row.kind === "approval" || !row.clusterId || !commanderClusterIds.has(row.clusterId));
  const settledSummary = [
    freshCount > 0 ? t("commanderTab.settledFresh", { n: freshCount }) : null,
    doneCount > 0 ? t("commanderTab.settledDone", { n: doneCount }) : null,
  ].filter((part): part is string => part !== null).join(" · ");
  // 지휘관 얼굴은 몽글 아바타다 — 아직 모습이 없는 키를 한 번 묶음째 뽑아 저장한다.
  useAvatarClaims();
  return (
    <div className="mobile-commodore-sessions">
      {attention.length > 0 ? <>
        <div className="mobile-conv-section"><span>{t("mobile.home.attention")} {attention.length}</span></div>
        <div className="mobile-conv-attention">
          {attention.map((row) => <MobileMarkedRow key={row.key} mark={row.kind === "plugin" && row.clusterId ? clusterIndex.layouts.get(row.clusterId)?.cluster.row?.mark : undefined}>
            {row.kind === "approval" ? (
              <button type="button" data-press="r1" className="mobile-conv-row" onClick={() => leave(() => openApprovalList())}>
                <span className="mobile-conv-row-copy">
                  <span className="mobile-conv-row-top"><span className="mobile-conv-row-title">{row.title}</span></span>
                  <span className="mobile-conv-row-sub"><span className="mobile-conv-state is-awaiting"><AttentionReason row={row} /></span></span>
                </span>
              </button>
            ) : (
            <button type="button" data-press="r1" className="mobile-conv-row" onClick={() => leave(() => { if (attentionMovesFirst(bindings, row.entryId)) openMobilePluginDestination(row.entryId, commodoreId); row.item.open(); })}>
              <span className="mobile-conv-row-av"><span className="mobile-conv-round is-static">{entryIconOf(bindings, row.entryId)}</span></span>
              <span className="mobile-conv-row-copy">
                <span className="mobile-conv-row-top"><span className="mobile-conv-row-title">{row.item.title}</span></span>
                <span className="mobile-conv-row-sub"><span className="mobile-conv-state is-awaiting"><AttentionReason row={row} /></span></span>
              </span>
            </button>
            )}
          </MobileMarkedRow>)}
        </div>
      </> : null}
      <MobileCommanderList key={commodoreId} rows={{ ...commanderRows, sorted, sections }} leave={leave} hasAttention={attention.length > 0} />
      {commandBoardEnabled ? (
        <button
          type="button"
          data-press="r1"
          className="mobile-commodore-board-link"
          onClick={() => leave(() => setMobileDestination({ kind: "command-board", commodoreId }))}
        >
          <span className="mobile-commodore-board-link-main">
            <CommandBoardGlyph size={16} />
            <span>{t("commandBoard.mobileOpenBoard")}</span>
          </span>
          <span className="mobile-commodore-board-link-meta">
            {settledSummary ? <span>{settledSummary}</span> : null}
            <span aria-hidden="true">→</span>
          </span>
        </button>
      ) : null}
      <MobileArchivedFinished commodoreId={commodoreId} leave={leave} />
    </div>
  );
}

import { useClusterIndex } from "../../../../../features/workspace/client/objective-clusters.js";
import { useAvatarClaims } from "../../../../../features/workspace/client/avatars.js";
import { useCommanderRows } from "../../../../../features/workspace/client/commander-tab/commander-rows.js";
import { useConsoleState } from "../../hooks/use-store.js";
import { useT } from "../../i18n/index.js";
import { openMobileNewSession } from "../../integration/store.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { AttentionReason } from "./mobile-attention-reason.js";
import { MobileArchivedFinished } from "./mobile-archived-finished.js";
import { MobileCommanderList } from "./mobile-commander-list.js";
import { attentionMovesFirst, entryIconOf, useMobileAttention } from "./mobile-destinations.js";
import { MobileIcon } from "./mobile-icons.js";
import { MobileMarkedRow } from "./mobile-row-mark.js";
import { openMobilePluginDestination } from "./mobile-store.js";

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
  const state = useConsoleState();
  const bindings = useRailEntries();
  const clusterIndex = useClusterIndex();
  const { rows } = useMobileAttention(state, commodoreId);
  const commanderRows = useCommanderRows(commodoreId, null);
  // 폰은 두 입구를 나눈다 — 사령관의 직접 질문은 띠에만, 지휘관의 결정 요청은 뿌리 유무와 관계없이 목록에만 선다.
  // 요청도 플러그인 행으로 오므로 kind만으로 가르지 않고 실제 명단의 묶음 id를 쓴다. 데스크톱 명단은 바꾸지 않는다.
  const sorted = commanderRows.sorted.filter((item) => !item.row.commodore);
  const commanderClusterIds = new Set(sorted.map((item) => item.layout.cluster.id));
  const sections = commanderRows.sections
    .map((section) => ({ ...section, rows: section.rows.filter((item) => commanderClusterIds.has(item.layout.cluster.id)) }))
    .filter((section) => section.rows.length > 0);
  const attention = rows.filter((row) => row.kind !== "objectiveRecord")
    .filter((row) => !row.clusterId || !commanderClusterIds.has(row.clusterId));
  // 지휘관 얼굴은 몽글 아바타다 — 아직 모습이 없는 키를 한 번 묶음째 뽑아 저장한다.
  useAvatarClaims();
  // 새 세션의 주인은 이 사령관이다. 세부를 먼저 접고 홈 자리에 연다.
  const startSession = () => leave(() => openMobileNewSession(commodoreId));
  return (
    <div className="mobile-commodore-sessions">
      {attention.length > 0 ? <>
        <div className="mobile-conv-section"><span>{t("mobile.home.attention")} {attention.length}</span></div>
        <div className="mobile-conv-attention">
          {attention.map((row) => <MobileMarkedRow key={row.key} mark={row.clusterId ? clusterIndex.layouts.get(row.clusterId)?.cluster.row?.mark : undefined}>
            <button type="button" data-press="r1" className="mobile-conv-row" onClick={() => leave(() => { if (attentionMovesFirst(bindings, row.entryId)) openMobilePluginDestination(row.entryId, commodoreId); row.item.open(); })}>
              <span className="mobile-conv-row-av"><span className="mobile-conv-round is-static">{entryIconOf(bindings, row.entryId)}</span></span>
              <span className="mobile-conv-row-copy">
                <span className="mobile-conv-row-top"><span className="mobile-conv-row-title">{row.item.title}</span></span>
                <span className="mobile-conv-row-sub"><span className="mobile-conv-state is-awaiting"><AttentionReason row={row} /></span></span>
              </span>
            </button>
          </MobileMarkedRow>)}
        </div>
      </> : null}
      <MobileCommanderList key={commodoreId} rows={{ ...commanderRows, sorted, sections }} leave={leave} hasAttention={attention.length > 0} />
      <MobileArchivedFinished commodoreId={commodoreId} leave={leave} />
      <div className="mobile-commodore-sessions-foot">
        <button type="button" data-press="r3" className="mobile-pill" onClick={startSession}><MobileIcon name="plus" size={18} />{t("mobile.commodore.sessions.new")}</button>
      </div>
    </div>
  );
}

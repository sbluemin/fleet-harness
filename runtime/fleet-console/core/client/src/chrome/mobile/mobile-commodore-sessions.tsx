import { useMemo } from "react";

import { useClusterIndex } from "../../../../../features/workspace/client/objective-clusters.js";
import { useAvatarClaims } from "../../../../../features/workspace/client/avatars.js";
import { useConsoleState } from "../../hooks/use-store.js";
import { useT } from "../../i18n/index.js";
import { focusObjective, openMobileNewSession } from "../../integration/store.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { AttentionReason } from "./mobile-attention-reason.js";
import { ConversationRow, ConversationSummary, isFinishedConversation, useMobileConversations, type MobileConversation } from "./mobile-conversation-row.js";
import { attentionMovesFirst, entryIconOf, useMobileAttention } from "./mobile-destinations.js";
import { MobileHomeSections } from "./mobile-home-sections.js";
import { MobileIcon } from "./mobile-icons.js";
import { MobileMarkedRow } from "./mobile-row-mark.js";
import { openMobilePluginDestination, setMobileDestination } from "./mobile-store.js";

/**
 * 사령관 화면 「지휘관 세션」 탭의 본문 — 그 사령관이 소유한 지휘관 세션(최상위 Objective 대화)만 모은다.
 * 맨 위 「확인 필요 N」(사람을 기다리는 세션과 그 사령관 문맥의 플러그인 항목), 「진행 중」, 끝에 「시작 전 N」·「완료 N」 접기(`MobileHomeSections`).
 * 범위의 열쇠는 사령관 UUID다 — Theater는 사령관마다 따로 갖는 목록이라 범위로 쓰지 않는다. 사령관 기능은 이 본문을 주입 포트로만 받는다.
 */
export function MobileCommodoreSessions({ commodoreId }: { readonly commodoreId: string }) {
  const t = useT();
  const state = useConsoleState();
  const bindings = useRailEntries();
  const clusterIndex = useClusterIndex();
  const conversations = useMobileConversations(state);
  const { rows: attention } = useMobileAttention(state, commodoreId);
  // 지휘관 얼굴은 몽글 아바타다 — 아직 모습이 없는 키를 한 번 묶음째 뽑아 저장한다(홈 목록이 하던 일).
  useAvatarClaims();

  const owned = useMemo(() => conversations
    .filter((conversation) => conversation.objectiveRecord.commodoreId === commodoreId)
    .sort((left, right) => right.objectiveRecord.ts.updatedAt - left.objectiveRecord.ts.updatedAt || right.objectiveRecord.ts.createdAt - left.objectiveRecord.ts.createdAt), [commodoreId, conversations]);
  const byId = useMemo(() => new Map(owned.map((conversation) => [conversation.objectiveRecord.id, conversation])), [owned]);
  const attentionObjectiveIds = new Set(attention.flatMap((row) => row.kind === "objectiveRecord" ? [row.objectiveRecord.id] : []));
  const rest = owned.filter((conversation) => !attentionObjectiveIds.has(conversation.objectiveRecord.id));
  const finished = rest.filter((conversation) => isFinishedConversation(clusterIndex, conversation.objectiveRecord.id));
  const live = rest.filter((conversation) => !isFinishedConversation(clusterIndex, conversation.objectiveRecord.id));

  const open = (conversation: MobileConversation) => { setMobileDestination({ kind: "home" }); focusObjective(conversation.objectiveRecord.id); };
  // 새 세션의 주인은 이 사령관이다 — 시트가 문맥(열려 있던 대화 등)에서 다른 사령관을 고르지 않게 직접 넘긴다.
  const startSession = () => openMobileNewSession(commodoreId);
  const empty = owned.length === 0 && attention.length === 0;

  return (
    <div className="mobile-commodore-sessions">
      {attention.length > 0 ? (
        <>
          <div className="mobile-conv-section"><span>{t("mobile.home.attention")} {attention.length}</span></div>
          <div className="mobile-conv-attention">
            {attention.map((row) => {
              if (row.kind === "objectiveRecord") {
                const conversation = byId.get(row.objectiveRecord.id);
                return conversation ? (
                  <ConversationRow key={row.key} conversation={conversation} sub={<span className="mobile-conv-state is-awaiting"><AttentionReason row={row} /></span>} onOpen={() => open(conversation)} />
                ) : null;
              }
              return (
                <MobileMarkedRow key={row.key} mark={row.clusterId ? clusterIndex.layouts.get(row.clusterId)?.cluster.row?.mark : undefined}>
                  <button type="button" data-press="r1" className="mobile-conv-row" onClick={() => { if (attentionMovesFirst(bindings, row.entryId)) openMobilePluginDestination(row.entryId, commodoreId); row.item.open(); }}>
                    <span className="mobile-conv-row-av"><span className="mobile-conv-round is-static">{entryIconOf(bindings, row.entryId)}</span></span>
                    <span className="mobile-conv-row-copy">
                      <span className="mobile-conv-row-top"><span className="mobile-conv-row-title">{row.item.title}</span></span>
                      <span className="mobile-conv-row-sub"><span className="mobile-conv-state is-awaiting"><AttentionReason row={row} /></span></span>
                    </span>
                  </button>
                </MobileMarkedRow>
              );
            })}
          </div>
        </>
      ) : null}
      {live.length > 0 ? (
        <>
          <div className="mobile-conv-section"><span>{t("mobile.commodore.sessions.live")}</span></div>
          {live.map((conversation) => (
            <ConversationRow key={conversation.objectiveRecord.id} conversation={conversation} sub={<ConversationSummary conversation={conversation} />} onOpen={() => open(conversation)} />
          ))}
        </>
      ) : null}
      <MobileHomeSections commodoreId={commodoreId} finishedConversations={finished} onOpenConversation={open} />
      {empty ? <p className="mobile-conv-empty-note">{t("mobile.commodore.sessions.empty")}</p> : null}
      <div className="mobile-commodore-sessions-foot">
        <button type="button" data-press="r3" className="mobile-pill" onClick={startSession}><MobileIcon name="plus" size={18} />{t("mobile.commodore.sessions.new")}</button>
      </div>
    </div>
  );
}

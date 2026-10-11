import { useMemo } from "react";

import { statusGlyphClassName } from "@fleet-console/sdk/components/status-glyph";

import { useAvatarClaims } from "../../../../../features/workspace/client/avatars.js";
import { useT } from "../../i18n/index.js";
import { focusOperation, openQuickLaunch } from "../../integration/store.js";
import { useMobileAppearance } from "../../integration/mobile-appearance-store.js";
import type { ConsoleState } from "../../integration/types.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { useMobileAttentionRows } from "./mobile-attention-context.js";
import { AttentionReason } from "./mobile-attention-reason.js";
import { ConversationRow, ConversationSummary, useMobileConversations, type MobileConversation } from "./mobile-conversation-row.js";
import { MobileIcon } from "./mobile-icons.js";
import { MobileMonogram } from "./mobile-monogram.js";
import { pushMobileSheet, setMobileDestination, setMobileDrawerOpen } from "./mobile-store.js";

const MAX_ATTENTION_ROWS = 3;

/**
 * 홈 — 대화 목록. 머리(프로필 · Theater 알약 · 검색 · +), 지금 Theater의 정체, 맨 위 「확인 필요」 묶음(최대 3건 + 전체 보기), 그 아래 대화 행.
 * 행 하나는 지휘관 묶음 하나다. 행을 누르면 그 Operation 화면이 홈 자리에 서고, 뒤로가 이 목록으로 돌아온다.
 * 목록은 고른 Theater 범위이고(전환은 머리의 Theater 알약), 모든 Theater를 가로지르는 것은 검색뿐이다.
 */
export function MobileConversationList({ state }: { readonly state: ConsoleState }) {
  const t = useT();
  const appearance = useMobileAppearance();
  const attention = useMobileAttentionRows();
  const conversations = useMobileConversations(state);
  // 대화 목록은 몽글 아바타를 보이는 표면이다 — 데스크톱 사이드바처럼 아직 모습이 없는 키를 한 번 묶음째 뽑아 저장한다.
  useAvatarClaims();
  // 이 화면이 자기 머리를 그린다 — 호스트 상단 막대는 숨긴다.
  useClaimMobileBar({ variant: "centered", title: "", leading: "menu", hidden: true });

  const theater = state.theaters.find((item) => item.id === state.activeTheaterId) ?? null;
  const consoleName = appearance.console?.label ?? window.location.hostname;
  const inTheater = useMemo(() => conversations
    .filter((conversation) => conversation.operation.theaterId === state.activeTheaterId)
    .sort((left, right) => right.operation.ts.updatedAt - left.operation.ts.updatedAt || right.operation.ts.createdAt - left.operation.ts.createdAt), [conversations, state.activeTheaterId]);
  const byId = useMemo(() => new Map(inTheater.map((conversation) => [conversation.operation.id, conversation])), [inTheater]);
  const attentionOperationIds = new Set(attention.flatMap((row) => row.kind === "operation" ? [row.operation.id] : []));
  const rest = inTheater.filter((conversation) => !attentionOperationIds.has(conversation.operation.id));

  const open = (conversation: MobileConversation) => { setMobileDestination({ kind: "home" }); focusOperation(conversation.operation.id); };

  return (
    <section className="mobile-conv-list">
      <header className="mobile-conv-head">
        {/* 프로필 자리 — 프로필·설정 시트가 서기 전까지는 기존 드로어(목적지·설정)로 가는 문이다. */}
        <button type="button" data-press="r1" className="mobile-conv-round" aria-label={t("mobile.drawer.consoleSwitch", { name: consoleName })} onClick={() => setMobileDrawerOpen(true)}>
          <MobileMonogram label={consoleName} toneKey={consoleName} tone={appearance.console?.tone ?? null} letters={appearance.console?.monogram ?? consoleName.charAt(0).toUpperCase()} round size={36} />
          {state.connection !== "live" ? <span className="mobile-avatar-dot" data-state={state.connection === "offline" ? "failed" : "reconnecting"} aria-hidden="true" /> : null}
        </button>
        <span className="mobile-conv-gap" />
        <button type="button" data-press="r1" className="mobile-conv-theater" aria-label={t("mobile.list.theaterAria")} onClick={() => pushMobileSheet({ kind: "theater" })}>
          {theater ? <MobileMonogram label={theater.label} toneKey={theater.id} size={32} /> : <span className="mobile-monogram is-empty" aria-hidden="true"><MobileIcon name="theater" size={16} /></span>}
          <strong>{theater?.label ?? t("mobile.drawer.noTheater")}</strong>
          <MobileIcon name="down" size={16} />
        </button>
        <span className="mobile-conv-gap" />
        <button type="button" data-press="r1" className="mobile-conv-round" aria-label={t("mobile.list.search")} onClick={() => setMobileDestination({ kind: "search" })}><MobileIcon name="search" /></button>
        <button type="button" data-press="r1" className="mobile-conv-round" aria-label={t("mobile.list.create")} onClick={() => pushMobileSheet({ kind: "create" })}><MobileIcon name="plus" /></button>
      </header>
      <div className="mobile-conv-scroll">
        {theater ? (
          <div className="mobile-conv-hero">
            <MobileMonogram label={theater.label} toneKey={theater.id} size={64} />
            <strong>{theater.label}</strong>
            <small>{t("mobile.list.heroSub", { count: inTheater.length })}</small>
          </div>
        ) : null}
        {attention.length > 0 ? (
          <>
            <div className="mobile-conv-section">
              <span>{t("mobile.drawer.attention")} {attention.length}</span>
              <button type="button" data-press="r1" onClick={() => setMobileDestination({ kind: "attention" })}>{t("mobile.list.attentionAll")} ›</button>
            </div>
            <div className="mobile-conv-attention">
              {attention.slice(0, MAX_ATTENTION_ROWS).map((row) => {
                if (row.kind === "operation") {
                  const conversation = byId.get(row.operation.id);
                  return conversation ? (
                    <ConversationRow key={row.key} conversation={conversation} sub={<span className="mobile-conv-state is-awaiting"><AttentionReason row={row} /></span>} onOpen={() => open(conversation)} />
                  ) : null;
                }
                return (
                  <button type="button" data-press="r1" className="mobile-conv-row" key={row.key} onClick={() => { setMobileDestination({ kind: "plugin", entryId: row.entryId }); row.item.open(); }}>
                    <span className="mobile-conv-row-av"><span className="mobile-conv-round is-static"><span className={statusGlyphClassName("review")} aria-hidden="true" /></span></span>
                    <span className="mobile-conv-row-copy">
                      <span className="mobile-conv-row-top"><span className="mobile-conv-row-title">{row.item.title}</span></span>
                      <span className="mobile-conv-row-sub"><span className="mobile-conv-state is-awaiting"><AttentionReason row={row} /></span></span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        ) : null}
        <div className="mobile-conv-section"><span>{t("mobile.list.section")}</span></div>
        {rest.length === 0 && attention.length === 0 ? (
          <div className="mobile-conv-empty">
            <p>{t("mobile.list.empty")}</p>
            <button type="button" className="mobile-pill" onClick={openQuickLaunch}><MobileIcon name="plus" size={18} />{t("mobile.list.newConversation")}</button>
          </div>
        ) : rest.length === 0 ? <p className="mobile-conv-empty-note">{t("mobile.list.noMore")}</p> : rest.map((conversation) => (
          <ConversationRow key={conversation.operation.id} conversation={conversation} sub={<ConversationSummary conversation={conversation} />} onOpen={() => open(conversation)} />
        ))}
      </div>
    </section>
  );
}

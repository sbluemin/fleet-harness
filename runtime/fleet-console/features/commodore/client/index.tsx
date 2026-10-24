import { commodoreName } from "./commodore-name.js";
import type { CommodoreClientDeps } from "./deps.js";
import type { ClientFeatureDescriptor } from "../../workspace/shared/feature-surfaces.js";
import type { CommodoreBoardClient } from "../../objectives/shared/commodore-board-client.js";
import type { CommodoreClientHost, CommodoreClientSnapshot } from "../shared/contracts/client.js";
import type { PaneDescriptor } from "../../workspace/shared/pane.js";
import type { RailEntryDescriptor } from "../../workspace/shared/rail.js";
import { commodoreInboxSection } from "./commodore-inbox-section.js";
import { COMMODORE_MOBILE_PANE, commodoreDestinationTrailing, MobileCommodore, PennantIcon } from "./commodore-mobile.js";
import { commodoreTheaterContribution } from "./commodore-header.js";
import { commodoreMentionTargets, commodoreQuoteTargets, messageCommodoreMention, receiveCommodoreQuote, subscribeCommodoreQuoteTargets } from "./commodore-mention.js";
import { COMMODORE_ENTRY_ID, commodoreBoardOf, commodoreDestinationShown, commodoreLanguage, commodoreRevision, installCommodoreState, loadCommodore, noteCommodoreLanguage, openAsks, openAskTheaters, openCommodoreMobile, readCommodore, subscribeCommodore, subscribeCommodoreMentions } from "./commodore-state.js";
import { commodoreConversationSurface, connectCommodoreConversation, isCommodoreConversationActive, openCommodoreConversation, openCommodoreLog, subscribeCommodoreConversationActive } from "./commodore-conversation.js";
import { renderCommodoreRowGlyph, renderCommodoreRowGlyphOff } from "./commodore-mention-glyph.js";
import { installCommodoreBoard } from "./board.js";
import { getT } from "./i18n/index.js";
import "./commodore.css";

/** 모바일 사령관 화면 — 바로가기 목적지 「사령관」의 본문. 데스크톱은 사이드바 줄과 「사령관 기록」 시트를 그대로 쓴다. */
export const commodoreMobilePane: PaneDescriptor = {
  id: COMMODORE_MOBILE_PANE,
  role: "primary",
  mounts: ["rail"],
  title: (ctx) => commodoreName(ctx.theaterId ?? "", getT(ctx.language)),
  hideCaption: true,
  render: (ctx) => ctx.mobileBar ? <MobileCommodore ctx={ctx} /> : null,
};

/**
 * 폰 전용 엔트리 — 실험 기능 「자율 운영」이 켜져 있을 때만 홈 대표 자리(바로가기 칩)에 「사령관」 목적지로 선다.
 * 데스크톱 레일에는 오르지 않는다(`mobile.desktop: false`) — 팔레트의 사령관 행은 호스트가 Theater Inbox 섹션(`commodoreInboxSection`)에서 세운다.
 */
export const commodoreEntry: RailEntryDescriptor = {
  id: COMMODORE_ENTRY_ID,
  title: (locale) => getT(locale)("commodore.name"),
  icon: () => <PennantIcon />,
  scope: "theater",
  panes: [COMMODORE_MOBILE_PANE],
  // 목적지 order 5(「목표」 목적지 10 앞). 칩 오른쪽 칸은 자율 운영 루프의 상태(S-53 CM-1c)다.
  mobile: { desktop: false, destination: { order: 5, shown: commodoreDestinationShown, trailing: commodoreDestinationTrailing }, icon: () => <PennantIcon /> },
  // 사령관 칩 배지 — 사령관이 사람에게 물어 답을 기다리는 질문 수(`openAsks`). 행은 「목표」의 확인 필요가 같은 질문을 이미 세우므로 두지 않는다.
  attention: {
    subscribe: subscribeCommodore,
    count: (theaterId) => openAsks(theaterId).length,
    label: (count, locale) => getT(locale)("commodore.board.ask.badge", { count }),
  },
};


export function createCommodoreClient(board: CommodoreBoardClient | null) {
  const snapshots = new Map<string, { readonly revision: number; readonly value: CommodoreClientSnapshot }>();
  const host: CommodoreClientHost = {
    read(theaterId) {
      const revision = commodoreRevision();
      const hit = snapshots.get(theaterId); if (hit?.revision === revision) return hit.value;
      const value = { commodoreId: readCommodore(theaterId).view?.commodoreId ?? null, ...commodoreBoardOf(theaterId), view: readCommodore(theaterId).view, asks: openAsks(theaterId) };
      snapshots.set(theaterId, { revision, value }); return value;
    },
    subscribe: subscribeCommodore,
    revision: commodoreRevision,
    askTheaters: openAskTheaters,
    load: (theaterId) => loadCommodore(theaterId),
    open(theaterId, options) {
      if (options?.mobile || options?.tab && options.tab !== "log") { openCommodoreMobile(options?.tab ?? "log", theaterId); return true; }
      if (options?.revealAt !== undefined || options?.readOnly || options?.objectiveId) return openCommodoreConversation(theaterId, options);
      openCommodoreLog(theaterId); return true;
    },
    language: commodoreLanguage,
    conversationActive: isCommodoreConversationActive,
    subscribeConversation: subscribeCommodoreConversationActive,
    renderRowGlyph: (_theaterId, operated = true) => operated ? renderCommodoreRowGlyph() : renderCommodoreRowGlyphOff(),
  };
  const install = (ctx: CommodoreClientDeps): (() => void) => {
      const offBoard = installCommodoreBoard(board);
      const offState = installCommodoreState(ctx);
      const offConversation = connectCommodoreConversation(ctx.conversation, ctx.theaterInbox);
      const offQuotes = ctx.composer.receiveQuotes?.("commodore", { targets: commodoreQuoteTargets, receive: receiveCommodoreQuote, subscribe: subscribeCommodoreQuoteTargets });
      return () => { offQuotes?.(); offConversation(); offState(); offBoard(); snapshots.clear(); };

  };
  const plugin: ClientFeatureDescriptor = {
    id: "commodore",

    railEntries: [commodoreEntry],
    panes: [commodoreMobilePane],
    theaterContributions: [commodoreTheaterContribution],
    mentionTargets: commodoreMentionTargets,
    subscribeMentionTargets: subscribeCommodoreMentions,
    messageMentionTarget: messageCommodoreMention,
    theaterInboxSections: [{ ...commodoreInboxSection, omitsRailEntries: board?.railEntryIds ?? [] }],
    persistentComponents: [{ id: "commodore-language", render: ({ language }) => { if (language) noteCommodoreLanguage(language); return null; } }],
    conversationSurfaces: [commodoreConversationSurface],
  };
  return { plugin, host, install };
}

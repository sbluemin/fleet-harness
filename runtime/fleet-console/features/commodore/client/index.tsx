import { subscribeCommodoreLifecycle } from "./commodore-delete-events.js";
import { commodoreName } from "./commodore-name.js";
import type { CommodoreClientDeps } from "./deps.js";
import type { ClientFeatureDescriptor } from "../../workspace/shared/feature-surfaces.js";
import type { CommodoreBoardClient } from "../../objectives/shared/commodore-board-client.js";
import type { CommodoreClientHost, CommodoreClientSnapshot } from "../shared/contracts/client.js";
import type { PaneDescriptor } from "../../workspace/shared/pane.js";
import type { RailEntryDescriptor } from "../../workspace/shared/rail.js";
import { commodoreInboxSection } from "./commodore-inbox-section.js";
import { commodoreMarketplaceSettingsSection } from "./commodore-plugins.js";
import { COMMODORE_MOBILE_PANE, commodoreDestinationTrailing, MobileCommodore, PennantIcon } from "./commodore-mobile.js";
import { commodoreTheaterContribution } from "./commodore-header.js";
import { commodoreMentionTargets, commodoreQuoteTargets, messageCommodoreMention, receiveCommodoreQuote, subscribeCommodoreQuoteTargets } from "./commodore-mention.js";
import { installCommodoreList, readCommodoreList, subscribeCommodoreList } from "./commodore-list.js";
import { COMMODORE_ENTRY_ID, commodoreBoardOf, commodoreDestinationShown, commodoreLanguage, commodoreRevision, contextsOf, installCommodoreState, loadCommodore, noteCommodoreLanguage, openAsks, openAskOwners, openCommodoreMobile, ownerOfContext, readCommodore, resolveContext, subscribeCommodore, subscribeCommodoreMentions } from "./commodore-state.js";
import { CommodoreZoneHost, commodoreConversationSurface, connectCommodoreConversation, isCommodoreConversationActive, openCommodoreConversation, openCommodoreLog, subscribeCommodoreConversationActive } from "./commodore-conversation.js";
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
 * 폰 전용 엔트리 — 실험 기능 「자율 운영」이 켜져 있을 때 「사령관」 목적지로 선다. 폰 홈의 사령관 행이 그 화면을 연다(바로가기 시트에는 서지 않는다).
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
    count: (theaterId) => theaterId ? openAsks(ownerOfContext(theaterId)).length : 0,
    label: (count, locale) => getT(locale)("commodore.board.ask.badge", { count }),
  },
};


export function createCommodoreClient(board: CommodoreBoardClient | null) {
  const snapshots = new Map<string, { readonly revision: number; readonly value: CommodoreClientSnapshot }>();
  const host: CommodoreClientHost = {
    read(commodoreId) {
      const revision = commodoreRevision();
      const hit = snapshots.get(commodoreId); if (hit?.revision === revision) return hit.value;
      const value = { commodoreId: readCommodore(commodoreId).view?.commodoreId ?? commodoreId, ...commodoreBoardOf(commodoreId), view: readCommodore(commodoreId).view, asks: openAsks(commodoreId) };
      snapshots.set(commodoreId, { revision, value }); return value;
    },
    subscribe: (listener) => { const offState = subscribeCommodore(listener); const offList = subscribeCommodoreList(listener); return () => { offState(); offList(); }; },
    ids: () => readCommodoreList().map((row) => row.commodoreId),
    revision: commodoreRevision,
    askOwners: openAskOwners,
    load: (commodoreId) => loadCommodore(commodoreId),
    resolveContext,
    ownerOfContext,
    open(commodoreId, options) {
      const theaterId = contextsOf(commodoreId)[0] ?? null;
      // 폰 화면의 문맥은 기억된 Theater가 아니라 사령관 UUID다. 빠진 Theater 이름이 부제로 남지 않는다.
      if (options?.mobile || options?.tab && options.tab !== "log") { openCommodoreMobile(options?.tab ?? "log", commodoreId); return true; }
      if (options?.revealAt !== undefined || options?.readOnly || options?.objectiveId) return openCommodoreConversation(commodoreId, options);
      openCommodoreLog(commodoreId, theaterId); return true;
    },
    language: commodoreLanguage,
    conversationActive: isCommodoreConversationActive,
    subscribeConversation: subscribeCommodoreConversationActive,
    renderRowGlyph: (_commodoreId, operated = true) => operated ? renderCommodoreRowGlyph() : renderCommodoreRowGlyphOff(),
  };
  const install = (ctx: CommodoreClientDeps): (() => void) => {
      const offRemoved = subscribeCommodoreLifecycle((event) => { if (event.op === "removed") snapshots.delete(event.commodoreId); });
      const offBoard = installCommodoreBoard(board);
      const offState = installCommodoreState(ctx);
      const offList = installCommodoreList(ctx.consoleEvents);
      const offConversation = connectCommodoreConversation(ctx.conversation, ctx.theaterInbox);
      const offQuotes = ctx.composer.receiveQuotes?.("commodore", { targets: commodoreQuoteTargets, receive: receiveCommodoreQuote, subscribe: subscribeCommodoreQuoteTargets });
      return () => { offRemoved(); offQuotes?.(); offConversation(); offList(); offState(); offBoard(); snapshots.clear(); };

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
    // Console 설정 작업 묶음의 「마켓플레이스」 — 사령관들이 함께 보는 등록부. 설치는 사령관마다 그 설정 칸에서 고른다.
    settingsSections: [commodoreMarketplaceSettingsSection],
    persistentComponents: [
      { id: "commodore-language", render: ({ language }) => { if (language) noteCommodoreLanguage(language); return null; } },
      { id: "commodore-zone", render: () => <CommodoreZoneHost /> },
    ],
    conversationSurfaces: [commodoreConversationSurface],
  };
  return { plugin, host, install };
}

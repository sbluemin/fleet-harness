import type { ComposerQuote, ComposerQuoteAttachResult } from "../../execution/client/composer-primitives/quotes.js";
import type { MentionTargetDescriptor } from "../../execution/shared/composer-ports.js";

import { CommodoreAvatar } from "./commodore-avatar.js";
import { attachQuoteToCommodoreComposer } from "./commodore-inbox-section.js";
import { isCommodoreConversationOpen, subscribeCommodoreConversationActive } from "./commodore-conversation.js";
import { commodoreMongleState } from "./commodore-header.js";
import { commodoreAlias, commodoreTheaterIds, readCommodore, commodoreLanguage, commodoreTheaterLabel, messageCommodore, subscribeCommodore, useCommodore } from "./commodore-state.js";
import { getT } from "./i18n/index.js";
import { useObjectiveTheater } from "./board.js";

const TARGET_PREFIX = "commodore:";

const acceptsMessage = (theaterId: string) => {
  const view = readCommodore(theaterId).view;
  return view?.enabled === true && view.boardReady;
};

/**
 * 새 세션 '@' 덱에 서는 등록된 모든 Theater의 사령관.
 *
 * 순찰 안 함에서도 메시지를 받는다. 보드가 준비된 사령관만 행선지로 내며, 전송 중의 종료·Clear 경합은 서버가 거절한다.
 * 실패하면 새 세션은 초안과 행선지를 그대로 둔다.
 *
 * 밴드가 이미 「사령관」을 말하므로 행 이름은 사이드바 Theater 머리와 같은 이름이다 — 별칭이 있으면 별칭, 없으면 Theater 이름이라
 * 행선지 태그가 「사령관 · fleet-harness」로 읽힌다. 별칭이 있으면 설명문이 원래 Theater 이름을 함께 말하고, 검색어(keywords)에도
 * 실어 별칭을 모르는 사람이 원래 이름으로도 찾게 한다.
 * 표식은 사이드바 머리와 같은 사령관 아바타다.
 */
export function commodoreMentionTargets(): readonly MentionTargetDescriptor[] {
  const t = getT(commodoreLanguage());
  return commodoreTheaterIds().filter((theaterId) => acceptsMessage(theaterId)).map((theaterId) => {
    const theater = commodoreTheaterLabel(theaterId) || theaterId;
    const alias = commodoreAlias(theaterId);
    return {
      id: `${TARGET_PREFIX}${theaterId}`,
      label: alias ?? theater,
      categoryLabel: t("commodore.name"),
      description: alias ? t("commodore.mention.descriptionAlias", { alias, theater }) : t("commodore.mention.description", { theater }),
      ...(alias ? { keywords: [theater] } : {}),
      renderMark: () => <CommodoreMentionMark theaterId={theaterId} />,
    };
  });
}

/**
 * 덱 행·선택 칩·레인의 사령관 표식 — 사이드바 머리 표식과 같은 얼굴(상태)을 스스로 구독해 그린다. 순찰 설정과
 * 무관하게 흐리지 않는다. 호스트 표식 칸(17–20px)이 svg 를 칸에 맞추므로 크기는 그 상한으로 둔다.
 */
function CommodoreMentionMark({ theaterId }: { readonly theaterId: string }) {
  const { view } = useCommodore(theaterId);
  const { objectives } = useObjectiveTheater(theaterId);
  return <CommodoreAvatar theaterId={theaterId} state={commodoreMongleState(view, objectives)} size={20} label="" decorative />;
}

/** 고른 사령관에게 보낸다 — 사령관 기록 서랍의 입력과 같은 경로(`commodore/message`)다. */
export async function messageCommodoreMention(targetId: string, text: string): Promise<void> {
  const theaterId = targetId.startsWith(TARGET_PREFIX) ? targetId.slice(TARGET_PREFIX.length) : "";
  // 덱을 연 뒤 보드가 내려갔을 수 있다 — 아는 만큼 먼저 거절한다. 권위는 서버의 거절이다.
  if (!theaterId || !acceptsMessage(theaterId)) throw new Error("mention_target_gone");
  await messageCommodore(theaterId, text);
}

/**
 * 인용을 받을 수 있는 이 Theater 의 사령관 — 호스트가 Codex 문서의 선택 알약이 붙일 곳을 정할 때 읽는다. 새 세션 '@' 덱과 같은 조건
 * (사령관과 보드가 준비됨)일 때만 낸다. 이름은 덱과 같다(별칭이 있으면 별칭). 가운데 칸에 이 사령관 대화가
 * 서 있으면 `current` 로 알려 지금 열린 대화로 붙게 한다.
 */
export function commodoreQuoteTargets(theaterId: string): readonly { readonly targetId: string; readonly label: string; readonly current?: boolean }[] {
  if (!commodoreTheaterIds().includes(theaterId) || !acceptsMessage(theaterId)) return [];
  return [{
    targetId: `${TARGET_PREFIX}${theaterId}`,
    label: commodoreAlias(theaterId) ?? (commodoreTheaterLabel(theaterId) || theaterId),
    ...(isCommodoreConversationOpen(theaterId) ? { current: true } : {}),
  }];
}

/** 받을 곳의 바뀜 — 사령관 상태(가용 여부·별칭)와 가운데 칸에 선 대화가 바뀌면 깨운다. */
export function subscribeCommodoreQuoteTargets(listener: () => void): () => void {
  const offCommodore = subscribeCommodore(listener);
  const offConversation = subscribeCommodoreConversationActive(listener);
  return () => { offCommodore(); offConversation(); };
}

/** 붙이기 — 사령관 입력창(데스크톱·폰이 같은 초안)에 칩을 세운다. 보내지 않는다. */
export function receiveCommodoreQuote(targetId: string, quote: ComposerQuote): ComposerQuoteAttachResult {
  const theaterId = targetId.startsWith(TARGET_PREFIX) ? targetId.slice(TARGET_PREFIX.length) : "";
  if (!theaterId || !acceptsMessage(theaterId)) return "unavailable";
  return attachQuoteToCommodoreComposer(theaterId, quote);
}

import type { MentionTargetDescriptor } from "@fleet-console/sdk/plugin";

import { CommodoreMentionGlyph } from "./commodore-mention-glyph.js";
import { commodoreActiveTheaterId, commodoreBoardOf, commodoreLanguage, commodoreTheaterLabel, messageCommodore } from "./commodore-state.js";
import { getT } from "./i18n/index.js";

const TARGET_PREFIX = "commodore:";

/**
 * Quick Launch '@' 덱에 서는 지금 Theater 의 사령관.
 *
 * 실험 기능 「자율 운영」과 그 Theater 의 자율 운영이 모두 켜져 있을 때만 낸다. 어느 하나라도 꺼져 있으면 서버가 메시지를
 * 거절한다(`commodore_disabled`·`commodore_inactive`) — 보내도 닿지 않는 행선지를 고를 수 있게 둘 이유가 없으므로
 * 흐리게도 세우지 않는다(꺼진 실험 기능에서 사령관 줄이 사라지는 것과 같은 관례). 덱을 연 뒤 꺼진 경합은 아래 선검사나
 * 서버 거절로 실패하고, Quick Launch 는 초안과 행선지를 그대로 둔 채 전달 실패를 말한다.
 *
 * 밴드가 이미 「사령관」을 말하므로 행 이름은 Theater 다 — 행선지 태그가 「사령관 · fleet-harness」로 읽힌다.
 */
export function commodoreMentionTargets(): readonly MentionTargetDescriptor[] {
  const theaterId = commodoreActiveTheaterId();
  if (!theaterId || !commodoreBoardOf(theaterId).active) return [];
  const t = getT(commodoreLanguage());
  const theater = commodoreTheaterLabel(theaterId) || theaterId;
  return [{
    id: `${TARGET_PREFIX}${theaterId}`,
    label: theater,
    categoryLabel: t("objectives.commodore.name"),
    description: t("objectives.commodore.mention.description", { theater }),
    renderMark: () => <CommodoreMentionGlyph />,
  }];
}

/** 고른 사령관에게 보낸다 — 사령관 기록 서랍의 입력과 같은 경로(`commodore/message`)다. */
export async function messageCommodoreMention(targetId: string, text: string): Promise<void> {
  const theaterId = targetId.startsWith(TARGET_PREFIX) ? targetId.slice(TARGET_PREFIX.length) : "";
  // 덱을 연 뒤 자율 운영이 꺼졌을 수 있다 — 아는 만큼 먼저 거절한다. 권위는 서버의 거절이다.
  if (!theaterId || !commodoreBoardOf(theaterId).active) throw new Error("mention_target_gone");
  await messageCommodore(theaterId, text);
}

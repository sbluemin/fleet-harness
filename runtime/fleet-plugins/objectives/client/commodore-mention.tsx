import type { MentionTargetDescriptor } from "@fleet-console/sdk/plugin";

import { CommodoreMentionGlyph } from "./commodore-mention-glyph.js";
import { commodoreActiveTheaterId, commodoreBoardOf, commodoreLanguage, commodoreTheaterLabel, messageCommodore } from "./commodore-state.js";
import { getT } from "./i18n/index.js";

const TARGET_PREFIX = "commodore:";

/**
 * Quick Launch '@' 덱에 서는 지금 Theater 의 사령관.
 *
 * 실험 기능 「자율 운영」과 그 Theater 의 자율 운영이 모두 켜져 있을 때만 낸다. 어느 하나라도 꺼져 있으면 메시지는
 * 기록에만 남고 사령관을 깨우지 못하며, 다시 켜도 새 사령관은 그 메시지를 받지 않는다 — 보내도 닿지 않는 행선지를
 * 고를 수 있게 두면 사람의 문장이 조용히 사라진다. 그래서 흐리게도 세우지 않는다(꺼진 실험 기능에서 사령관 줄이
 * 사라지는 것과 같은 관례).
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
  // 덱을 연 뒤 자율 운영이 꺼졌을 수 있다 — 깨우지 못할 메시지는 기록에 흘려 넣지 않고 거절한다.
  if (!theaterId || !commodoreBoardOf(theaterId).active) throw new Error("mention_target_gone");
  await messageCommodore(theaterId, text);
}

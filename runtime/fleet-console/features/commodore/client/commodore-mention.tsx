import type { MentionTargetDescriptor } from "../../execution/shared/composer-ports.js";

import { CommodoreAvatar } from "./commodore-avatar.js";
import { commodoreMongleState } from "./commodore-header.js";
import { commodoreLanguage, commodoreOwnerAlias, messageCommodore, readCommodore, useCommodore } from "./commodore-state.js";
import { readCommodoreList } from "./commodore-list.js";
import { getT } from "./i18n/index.js";
import { useObjectiveTheater } from "./board.js";

const TARGET_PREFIX = "commodore:";

const acceptsMessage = (commodoreId: string) => {
  const view = readCommodore(commodoreId).view;
  return view?.enabled === true && view.boardReady;
};

const targetCommodore = (targetId: string): string => (targetId.startsWith(TARGET_PREFIX) ? targetId.slice(TARGET_PREFIX.length) : "");

/** 사령관 행선지의 이름 몫 — 별칭, 그 사령관 자기 목록의 첫 Theater 이름(설명문·검색어). */
function targetNames(commodoreId: string): { readonly alias: string | null; readonly theater: string } {
  const row = readCommodoreList().find((candidate) => candidate.commodoreId === commodoreId);
  return { alias: commodoreOwnerAlias(commodoreId), theater: row?.theaters.find((theater) => theater.label)?.label ?? row?.label ?? "" };
}

/**
 * 새 세션 '@' 덱에 서는 사령관 — 사령관 목록의 사령관마다 하나다. Theater 에서 주인을 찾지 않는다.
 *
 * 루틴이 없어도 메시지를 받는다. 보드가 준비된 사령관만 행선지로 내며, 전송 중의 종료·Clear 경합은 서버가 거절한다.
 * 실패하면 새 세션은 초안과 행선지를 그대로 둔다.
 *
 * 밴드가 이미 「사령관」을 말하므로 행 이름은 사이드바 사령관 머리와 같은 이름이다 — 별칭이 있으면 별칭, 없으면 그 사령관 첫 Theater 이름이라
 * 행선지 태그가 「사령관 · fleet-harness」로 읽힌다. 별칭이 있으면 설명문이 원래 Theater 이름을 함께 말하고, 검색어(keywords)에도
 * 실어 별칭을 모르는 사람이 원래 이름으로도 찾게 한다.
 * 표식은 사이드바 머리와 같은 사령관 아바타다.
 */
export function commodoreMentionTargets(): readonly MentionTargetDescriptor[] {
  const t = getT(commodoreLanguage());
  return readCommodoreList().filter((row) => acceptsMessage(row.commodoreId)).map((row) => {
    const { alias, theater } = targetNames(row.commodoreId);
    const name = theater || t("commodore.name");
    return {
      id: `${TARGET_PREFIX}${row.commodoreId}`,
      label: alias ?? name,
      categoryLabel: t("commodore.name"),
      description: alias ? t("commodore.mention.descriptionAlias", { alias, theater: name }) : t("commodore.mention.description", { theater: name }),
      ...(alias && theater ? { keywords: [theater] } : {}),
      renderMark: () => <CommodoreMentionMark commodoreId={row.commodoreId} />,
    };
  });
}

/**
 * 덱 행·선택 칩·레인의 사령관 표식 — 사이드바 머리 표식과 같은 얼굴(상태)을 스스로 구독해 그린다. 루틴 설정과
 * 무관하게 흐리지 않는다. 호스트 표식 칸(17–20px)이 svg 를 칸에 맞추므로 크기는 그 상한으로 둔다.
 */
function CommodoreMentionMark({ commodoreId }: { readonly commodoreId: string }) {
  const { view } = useCommodore(commodoreId);
  const { objectives } = useObjectiveTheater(commodoreId);
  return <CommodoreAvatar commodoreId={commodoreId} state={commodoreMongleState(view, objectives)} size={20} label="" decorative />;
}

/** 고른 사령관에게 보낸다 — 사령관 기록 서랍의 입력과 같은 경로(`commodore/message`)다. */
export async function messageCommodoreMention(targetId: string, text: string): Promise<void> {
  const commodoreId = targetCommodore(targetId);
  // 덱을 연 뒤 보드가 내려갔을 수 있다 — 아는 만큼 먼저 거절한다. 권위는 서버의 거절이다.
  if (!commodoreId || !acceptsMessage(commodoreId)) throw new Error("mention_target_gone");
  await messageCommodore(commodoreId, text);
}


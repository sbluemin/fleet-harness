import { theaterAvatarKey, type MongleSpecial } from "@fleet-console/sdk/avatars";
import { readAvatarBook, resolveMongleLook, useMongleLook } from "@fleet-console/sdk/avatars/browser";
import type { Translate } from "@fleet-console/sdk/i18n";

import type { ObjectiveMessageKey } from "./i18n/index.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 사령관의 이름 — 아바타로 스페셜(토리·보리·도리)을 고른 사령관은 그 새의 말투를 빌리므로 이름에도 새를 붙인다(「사령관(보리)」).
 * 스페셜이 없으면 그냥 「사령관」이다. 모습은 Console 의 아바타 책이 단일 진실이다.
 */
export function commodoreNameFor(t: T, special: MongleSpecial | null): string {
  return special ? t("objectives.commodore.nameWithSoul", { name: t(`objectives.commodore.soul.${special}`) }) : t("objectives.commodore.name");
}

/** React 밖(대화 표면 제목 등) — 지금 아는 책으로 정한다. 책이 바뀌면 `subscribeAvatarBook` 으로 다시 읽는다. */
export function commodoreName(t: T, theaterId: string): string {
  return commodoreNameFor(t, resolveMongleLook(readAvatarBook(), theaterAvatarKey(theaterId)).special);
}

export function useCommodoreName(t: T, theaterId: string): string {
  return commodoreNameFor(t, useMongleLook(theaterAvatarKey(theaterId)).special);
}

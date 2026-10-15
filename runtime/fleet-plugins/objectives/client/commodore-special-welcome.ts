import { useSyncExternalStore } from "react";

import { MONGLE_SPECIAL_PRESETS, MONGLE_SPECIALS, type MongleSpecial } from "@fleet-console/sdk/avatars";
import type { ConsoleLocale, LocalizedText } from "@fleet-console/sdk/i18n";
import type { OnboardingTour } from "@fleet-console/sdk/onboarding";
import type { PluginInstallContext } from "@fleet-console/sdk/plugin";

import { canEditCommodoreAvatar, openCommodoreAvatarSpecial, subscribeCommodoreConversationActive } from "./commodore-conversation.js";
import { getT } from "./i18n/index.js";

/**
 * 스페셜 퀘이커 웰컴 카드 — 퀘이커 부관단이 끝났음을 알리고, 사령관 아바타 편집기의 「스페셜」(토리·보리·도리)로 바로 데려간다.
 *
 * - 한 번만 선다. 본 기록 키는 `commodore-special.walkthrough` 이고 한 번 배포하면 바꾸지 않는다.
 * - 카드는 사이드바 Theater 머리의 사령관 표식(이 플러그인의 DOM)을 짚는다. Objectives 가 없거나 Theater 가 하나도 없으면 앵커가
 *   서지 않아 카드도 서지 않고, 본 기록도 남지 않는다.
 * - 편집기는 대화 중심 화면(데스크톱)에만 있다. 폰에서는 앵커를 세우지 않아 카드를 미루고, 데스크톱에서 처음 볼 때 선다.
 * - 예전에 부관을 켜 두었던 사람에게는 그 새를 미리 고른 채 편집기를 연다. 제안일 뿐이라 저장은 사람이 「적용」을 누른다.
 *   옛 부관 설정(Console 설정의 `scuttlebutt` 문서)은 플러그인이 걷힌 뒤에도 남아 그대로 읽힌다.
 */

/** 옛 퀘이커 부관단 플러그인의 설정 문서 id — 그 플러그인은 걷혔지만 사용자 설정에는 남아 있다. 읽기만 한다. */
const FORMER_AIDES_SETTINGS_ID = "scuttlebutt";
export const COMMODORE_SPECIAL_TOUR_ID = "commodore-special";
/** 카드가 짚는 앵커 — 사령관 표식 안에 이 플러그인이 세우는 덮개. 읽을 준비가 끝난 데스크톱의 대상 Theater 에만 선다. */
export const COMMODORE_SPECIAL_ANCHOR_ATTRIBUTE = "data-objectives-special-welcome";
const ANCHOR = `.objectives-commodore-mark > [${COMMODORE_SPECIAL_ANCHOR_ATTRIBUTE}]`;

let consoleState: PluginInstallContext["consoleState"] | null = null;
let ready = false;
let former: MongleSpecial | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

/**
 * 예전에 켜 두었던 부관 하나 — 하나만 켰으면 그 새, 여럿이면 상단 바에 고정해 둔(docked) 새를 앞세우고, 그래도 여럿이면 원래
 * 부관단의 순서(토리·보리·도리)에서 먼저인 새다. 아무도 켜지 않았거나 문서가 없으면 null.
 */
export function formerAidePick(value: Readonly<Record<string, unknown>> | null): MongleSpecial | null {
  if (!value) return null;
  const on = MONGLE_SPECIALS.filter((id) => value[id] === true);
  if (on.length <= 1) return on[0] ?? null;
  const docked = typeof value.docked === "object" && value.docked !== null ? value.docked as Readonly<Record<string, unknown>> : {};
  return on.find((id) => docked[id] === true) ?? on[0]!;
}

export function installCommodoreSpecialWelcome(ctx: PluginInstallContext): () => void {
  consoleState = ctx.consoleState;
  let live = true;
  const settle = (pick: MongleSpecial | null) => {
    if (!live) return;
    former = pick;
    ready = true;
    notify();
  };
  void ctx.settings.read(FORMER_AIDES_SETTINGS_ID).then((value) => settle(formerAidePick(value)), () => settle(null));
  return () => {
    live = false;
    consoleState = null;
    ready = false;
    former = null;
    notify();
  };
}

/** 카드가 열 Theater — 지금 보는 Theater, 없으면 등록 목록의 첫 Theater. */
function targetTheaterId(): string | null {
  return consoleState?.getViewedTheaterId?.() ?? consoleState?.getTheaters()[0]?.id ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const offConsole = consoleState?.subscribe(listener) ?? (() => {});
  const offConversation = subscribeCommodoreConversationActive(listener);
  return () => { listeners.delete(listener); offConsole(); offConversation(); };
}

/** 이 Theater 의 사령관 표식에 카드 앵커를 세울지 — 옛 설정을 다 읽었고, 편집기에 닿을 수 있고(데스크톱), 카드가 열 Theater 일 때. */
export function useCommodoreSpecialAnchor(theaterId: string): boolean {
  return useSyncExternalStore(subscribe, () => ready && canEditCommodoreAvatar() && targetTheaterId() === theaterId, () => false);
}

const birdName = (special: MongleSpecial, locale: ConsoleLocale): string =>
  MONGLE_SPECIAL_PRESETS.find((preset) => preset.id === special)?.name[locale === "ko" ? "ko" : "en"] ?? special;

const text = (compose: (t: ReturnType<typeof getT>, locale: ConsoleLocale) => string): LocalizedText => (locale) => compose(getT(locale), locale);

export const commodoreSpecialTour: OnboardingTour = {
  id: COMMODORE_SPECIAL_TOUR_ID,
  spotlight: null,
  // 다른 안내를 막 끝낸 화면에 곧바로 이어 붙이지 않는다.
  deferAfterAnotherTour: true,
  walkthrough: [{
    anchor: ANCHOR,
    title: text((t, locale) => former ? t("objectives.onboarding.special.formerTitle", { bird: birdName(former, locale) }) : t("objectives.onboarding.special.title")),
    body: text((t, locale) => [
      former ? t("objectives.onboarding.special.formerBody", { bird: birdName(former, locale) }) : t("objectives.onboarding.special.body"),
      canEditCommodoreAvatar() ? null : t("objectives.onboarding.special.noEditor"),
    ].filter(Boolean).join(" ")),
    action: {
      label: text((t, locale) => former ? t("objectives.onboarding.special.formerAction", { bird: birdName(former, locale) }) : t("objectives.onboarding.special.action")),
      available: canEditCommodoreAvatar,
      run: () => {
        const theaterId = targetTheaterId();
        if (theaterId) openCommodoreAvatarSpecial(theaterId, former);
      },
    },
  }],
};

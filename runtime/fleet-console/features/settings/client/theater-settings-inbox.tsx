import type { TheaterInboxBodyContext, TheaterInboxSectionDescriptor, TheaterInboxSectionState } from "../../workspace/shared/theater-inbox.js";

import { CommodoreTheaters } from "../../commodore/client/commodore-theater-tab.js";
import { getT } from "../../../core/client/src/i18n/index.js";

/** 호스트 정준 id 는 `console:settings` 다 — 코어 어댑터가 이 id 앞에 `console:` 을 붙인다. */
export const THEATER_SETTINGS_SECTION_ID = "settings";
export const THEATER_MEMBERSHIP_PAGE_ID = "theaters";

const sectionStates = new Map<string, TheaterInboxSectionState>();

/**
 * Theater Inbox 의 「Theater 설정」 — 사령관에 속한 Theater 목록.
 * 플러그인이 아니라 호스트의 기본 섹션이라, 사령관(실험 기능)이 꺼져 있거나 플러그인이 빠져도 남는다.
 */
export function createTheaterSettingsInboxSection({ icon }: { readonly icon: TheaterInboxSectionDescriptor["icon"] }): TheaterInboxSectionDescriptor {
  return {
    id: THEATER_SETTINGS_SECTION_ID,
    title: (language) => getT(language)("theaterInbox.settings.title"),
    // 표식은 합성 쪽이 넘긴다(사이드바 Theater 머리와 같은 모노그램) — 이 feature 는 다른 feature 를 가져오지 않는다.
    icon,
    pages: [
      { id: THEATER_MEMBERSHIP_PAGE_ID, title: (language) => getT(language)("theaterInbox.theaters.page"), applies: (language) => getT(language)("theaterInbox.theaters.applies") },
    ],
    read: (_theater, language) => {
      const cached = sectionStates.get(language);
      if (cached) return cached;
      const state: TheaterInboxSectionState = { availability: "available", scope: getT(language)("theaterInbox.settings.scope") };
      sectionStates.set(language, state);
      return state;
    },
    subscribe: () => () => undefined,
    render: (context) => <TheaterSettingsInboxBody context={context} />,
  };
}

function TheaterSettingsInboxBody({ context }: { readonly context: TheaterInboxBodyContext }) {
  const { pageId, visible } = context;
  const showTheaters = visible && pageId === THEATER_MEMBERSHIP_PAGE_ID;
  return showTheaters ? <div className="theater-inbox-theaters"><CommodoreTheaters commodoreId={context.theater.id} /></div> : null;
}

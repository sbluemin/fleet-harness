import { useRef } from "react";
import { useChromeHeightProperty } from "@fleet-console/ui/react";

import { commodoreListLoaded, commodoreSectionLabel, selectMobileCommodore, useCommodoreList } from "../../../../../features/commodore/client/commodore-list.js";
import type { ConsoleCommodoreSummary } from "../../../../../features/commodore/shared/contracts/theaters.js";
import { useAvatarClaims, KeyedAvatar } from "../../../../../features/workspace/client/avatars.js";
import { commodoreAvatarKey } from "../../../../../features/workspace/shared/avatars.js";
import { useT } from "../../i18n/index.js";
import { useMobileAppearance } from "../../integration/mobile-appearance-store.js";
import type { ConsoleState } from "../../integration/types.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { useConversationTime } from "./mobile-conversation-row.js";
import { MobileIcon } from "./mobile-icons.js";
import { MobileMonogram } from "./mobile-monogram.js";
import { MobileShortcutSheet } from "./mobile-shortcut-sheet.js";
import { useMobileUpdateReady } from "./mobile-update-sheet.js";
import { pushMobileSheet, setMobileDestination } from "./mobile-store.js";

/**
 * 홈 — 모든 사령관의 목록(메신저형). 머리(프로필 · +), 사령관 행(아바타 · 이름 · 마지막 말의 시각 · 한 줄 미리보기), 아래에 떠 있는 바로가기 단추와 검색 입력.
 * 지휘관 세션은 홈에 서지 않는다 — 각 사령관 화면의 「지휘관 세션」 탭이 그 사령관의 세션(확인 필요·진행 중·시작 전·완료)을 보인다.
 * 행을 누르면 그 사령관의 대화가 홈 자리에 서고, 뒤로가 이 목록으로 돌아온다. 사령관을 가로지르는 찾기는 검색이 맡는다.
 */
export function MobileHome({ state }: { readonly state: ConsoleState }) {
  const t = useT();
  const appearance = useMobileAppearance();
  const updateReady = useMobileUpdateReady();
  const commodores = useCommodoreList();
  const time = useConversationTime();
  // 사령관 얼굴은 몽글 아바타다 — 아직 모습이 없는 키를 한 번 묶음째 뽑아 저장한다.
  useAvatarClaims();
  // 이 화면이 자기 머리를 그린다 — 호스트 상단 막대는 숨긴다.
  useClaimMobileBar({ variant: "centered", title: "", leading: "back", hidden: true });

  const consoleName = appearance.console?.label ?? window.location.hostname;
  const fallbackName = t("sidebar.commodore.fallback");
  const open = (commodore: ConsoleCommodoreSummary) => {
    selectMobileCommodore(commodore.commodoreId);
    setMobileDestination({ kind: "plugin", entryId: "commodore", params: { commodoreId: commodore.commodoreId } });
  };
  // 머리는 목록 위에 떠 있다 — 목록이 그 높이(`--m-screen-head`)만큼 위를 비운다.
  const listRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLElement>(null);
  useChromeHeightProperty(headRef, listRef, "--m-screen-head");

  return (
    <section ref={listRef} className="mobile-conv-list mobile-home">
      <header ref={headRef} className="mobile-conv-head mobile-screen-head">
        {/* 프로필 아바타 — Console 정체. 프로필·설정 시트를 연다. */}
        <button type="button" data-press="r1" className="mobile-conv-round" aria-label={updateReady ? `${t("mobile.list.profileAria", { name: consoleName })} · ${t("chrome.system.helpUpdateReady")}` : t("mobile.list.profileAria", { name: consoleName })} onClick={() => pushMobileSheet({ kind: "profile" })}>
          <MobileMonogram label={consoleName} toneKey={consoleName} tone={appearance.console?.tone ?? null} letters={appearance.console?.monogram ?? consoleName.charAt(0).toUpperCase()} round size={36} />
          {updateReady ? <span className="mobile-update-dot" aria-hidden="true" /> : null}
          {state.connection !== "live" ? <span className="mobile-avatar-dot" data-state={state.connection === "offline" ? "failed" : "reconnecting"} aria-hidden="true" /> : null}
        </button>
        <span className="mobile-conv-gap" />
        <button type="button" data-press="r1" className="mobile-conv-round" aria-label={t("mobile.list.create")} onClick={() => pushMobileSheet({ kind: "create" })}><MobileIcon name="plus" /></button>
      </header>
      <div className="mobile-conv-scroll">
        {commodores.length === 0 && commodoreListLoaded() ? <p className="mobile-conv-empty-note">{t("mobile.home.noCommodore")}</p> : null}
        {commodores.map((commodore) => {
          const name = commodoreSectionLabel(commodore, fallbackName);
          return (
            <button key={commodore.commodoreId} type="button" data-press="r1" className="mobile-conv-row" data-commodore-id={commodore.commodoreId} onClick={() => open(commodore)}>
              <span className="mobile-conv-row-av"><KeyedAvatar avatarKey={commodoreAvatarKey(commodore.commodoreId)} role="commodore" state="idle" size={52} label="" decorative /></span>
              <span className="mobile-conv-row-copy">
                <span className="mobile-conv-row-top">
                  <span className="mobile-conv-row-title">{name}</span>
                  {commodore.last ? <span className="mobile-conv-row-aside">{time(commodore.last.at)}</span> : null}
                </span>
                <span className="mobile-conv-row-sub">{commodore.last?.text ?? t("mobile.home.noMessage")}</span>
              </span>
            </button>
          );
        })}
      </div>
      <footer className="mobile-home-dock">
        <button type="button" data-press="r1" className="mobile-conv-round" aria-label={t("mobile.list.shortcutsAria")} onClick={() => pushMobileSheet({ kind: "custom", render: (close) => <MobileShortcutSheet onClose={close} /> })}><MobileIcon name="grid" /></button>
        <button type="button" data-press="r1" className="mobile-conv-searchfield mobile-home-search" onClick={() => setMobileDestination({ kind: "search" })}>
          <MobileIcon name="search" size={18} />
          <span>{t("mobile.home.search")}</span>
        </button>
      </footer>
    </section>
  );
}

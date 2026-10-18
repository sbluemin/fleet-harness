import { useRef, useState, useSyncExternalStore } from "react";

import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { useT } from "../../../../core/client/src/i18n/index.js";
import type { ConsoleState } from "../../../../core/client/src/integration/types.js";
import { isDesktopShell } from "../../../../core/client/src/integration/desktop-shell.js";
import { ConsoleHelpMenu, useSideSubmenuGroup, useStandingAway } from "../../../../core/client/src/chrome/components/command-band-system-cluster.js";
import { ViewModeToggle } from "../../../../core/client/src/chrome/components/view-mode-toggle.js";
import { SettingsButton } from "../../../../core/client/src/chrome/toolbar/settings-button.js";
import { useMenuButtonKeyboard } from "../../../../core/client/src/chrome/components/use-menu-button-keyboard.js";
import { ArchiveEntry } from "../archive/archive-entry.js";
import { SideBarStatusViewToggle } from "../sidebar/side-bar-view-controls.js";
import { getSideBarStatusAxis, subscribeStatusAxis } from "../sidebar/operations-side-bar-store.js";
import "./conversation-dock.css";

/**
 * 대화 화면의 하단 줄 — 아바타의 앱 메뉴, 보관함, 상태별 보기 글리프를 둔다.
 * 콘솔 전환은 위 공용 섹션이 맡고, 앱 메뉴에는 보기 모드(브라우저만)와 도움말·설정이 남는다.
 */
export function ConversationSideBarBottom({ connection }: { readonly connection: ConsoleState["connection"] }) {
  const t = useT();
  const state = useConsoleState();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const name = state.consoleName || window.location.hostname;
  const label = t("chrome.system.menu");
  useMenuButtonKeyboard(rootRef, triggerRef, menuRef, open, setOpen, true);
  const statusAxis = useSyncExternalStore(subscribeStatusAxis, getSideBarStatusAxis, getSideBarStatusAxis);
  // 집에서 잘 붙어 있는 상태는 말할 것이 없다. 초록 점은 다른 호스트에 서 있을 때(호스트 칩의 is-away와 같은 판정)만,
  // 끊김·재연결 점은 어디서든 그대로 낸다.
  const standingAway = useStandingAway();
  const showStatus = connection !== "live" || standingAway;
  // 계정 전환·도움말처럼 옆 판은 한 번에 하나만. 부모가 이 상태를 갖고 두 항목에 넘긴다.
  const sideSubmenus = useSideSubmenuGroup();
  return (
    <div className="conversation-dock" role="group" aria-label={t("conversation.side.systemAria")}>
      <div className="conversation-dock-host" ref={rootRef}>
        <button ref={triggerRef} type="button" className="conversation-dock-avatar" aria-label={label} title={label}
          aria-haspopup="menu" aria-expanded={open} aria-controls="conversation-host-menu" onClick={() => setOpen((value) => !value)}>
          <span aria-hidden="true">{Array.from(name.trim())[0]?.toLocaleUpperCase() || "F"}</span>
          {showStatus ? <span className="conversation-dock-status" data-connection={connection} aria-hidden="true" /> : null}
        </button>
        {/* 설정의 aria-labelledby 닻은 닫혀 있을 때도 남긴다. 닫힌 닻은 열린 오버레이가 아니므로 메뉴 역할은 열렸을 때만 단다.
            다시 열면 자식 메뉴는 닫힌 상태로 시작한다. */}
        <div key={String(open)} ref={menuRef} id="conversation-host-menu" className="conversation-dock-menu" role={open ? "menu" : undefined} aria-label={label} hidden={!open}>
          {/* Desktop에는 보기 모드가 없다. 브라우저에서만 보기 설정과 도움말·설정을 구분한다. */}
          {!isDesktopShell() ? <><ViewModeToggle className="conversation-dock-view" menuItem /><div className="conversation-dock-divider" role="separator" /></> : null}
          <ConsoleHelpMenu menuItem sideSubmenuGroup={sideSubmenus} />
          <div className="conversation-dock-settings" onClick={() => setOpen(false)}><SettingsButton menuItem /></div>
        </div>
      </div>
      <ArchiveEntry compact />
      <span className="conversation-dock-toggles">
        <SideBarStatusViewToggle active={statusAxis} />
      </span>
    </div>
  );
}

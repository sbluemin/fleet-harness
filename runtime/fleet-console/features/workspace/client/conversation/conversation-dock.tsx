import { useRef, useState, useSyncExternalStore } from "react";

import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { useT } from "../../../../core/client/src/i18n/index.js";
import type { ConsoleState } from "../../../../core/client/src/integration/types.js";
import { isDesktopShell } from "../../../../core/client/src/integration/desktop-shell.js";
import { ConsoleHelpMenu, HostSwitcher } from "../../../../core/client/src/chrome/components/command-band-system-cluster.js";
import { ViewModeToggle } from "../../../../core/client/src/chrome/components/view-mode-toggle.js";
import { ToolbarSettingsButton } from "../../../../core/client/src/chrome/toolbar/console-toolbar.js";
import { useMenuButtonKeyboard } from "../../../../core/client/src/chrome/components/use-menu-button-keyboard.js";
import { ArchiveEntry } from "../archive/archive-entry.js";
import { SideBarStatusViewToggle } from "../sidebar/side-bar-collapse-control.js";
import { getSideBarStatusAxis, subscribeStatusAxis } from "../sidebar/operations-side-bar-store.js";
import "./conversation-dock.css";

/**
 * 대화 화면에서만 서는 한 줄 — [호스트 원] [보관함] [상태별 보기 글리프]. 호스트 원의 메뉴는 기존 호스트 제어를
 * 그대로 품는다. 브랜드(환경 진단)는 맨 위 줄 왼쪽에 서므로 메뉴에 두지 않는다. 상태별 보기는 메뉴가 아니라 켜짐/꺼짐이
 * 바로 보이는 글리프다.
 */
export function ConversationSideBarBottom({ connection }: { readonly connection: ConsoleState["connection"] }) {
  const t = useT();
  const state = useConsoleState();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const name = state.consoleName || window.location.hostname;
  const label = `${t("chrome.hosts.aria")}: ${name}`;
  useMenuButtonKeyboard(rootRef, triggerRef, menuRef, open, setOpen, true);
  const statusAxis = useSyncExternalStore(subscribeStatusAxis, getSideBarStatusAxis, getSideBarStatusAxis);
  return (
    <div className="conversation-dock" role="group" aria-label={t("conversation.side.systemAria")}>
      <div className="conversation-dock-host" ref={rootRef}>
        <button ref={triggerRef} type="button" className="conversation-dock-avatar" aria-label={label} title={label}
          aria-haspopup="menu" aria-expanded={open} aria-controls="conversation-host-menu" onClick={() => setOpen((value) => !value)}>
          <span aria-hidden="true">{Array.from(name.trim())[0]?.toLocaleUpperCase() || "F"}</span>
          <span className="conversation-dock-status" data-connection={connection} aria-hidden="true" />
        </button>
        {/* 설정의 aria-labelledby 닻은 닫혀 있을 때도 남긴다. 닫힌 닻은 열린 오버레이가 아니므로 메뉴 역할은 열렸을 때만 단다.
            다시 열면 자식 메뉴는 닫힌 상태로 시작한다. */}
        <div key={String(open)} ref={menuRef} id="conversation-host-menu" className="conversation-dock-menu" role={open ? "menu" : undefined} aria-label={label} hidden={!open}>
          <div className="conversation-dock-heading">{name}</div>
          <HostSwitcher menuItem />
          {!isDesktopShell() ? <ViewModeToggle className="conversation-dock-view" menuItem /> : null}
          <div className="conversation-dock-divider" role="separator" />
          <ConsoleHelpMenu menuItem />
          <div className="conversation-dock-settings" onClick={() => setOpen(false)}><ToolbarSettingsButton canvas menuItem /></div>
        </div>
      </div>
      <ArchiveEntry compact />
      <span className="conversation-dock-toggles">
        <SideBarStatusViewToggle active={statusAxis} />
      </span>
    </div>
  );
}

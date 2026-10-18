import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { SidebarFooterEntryContext } from "@fleet-console/sdk/plugin";
import { DEPUTY_COMMAND_BAND_ENTRY_ID, usePluginRegistry } from "../../../../core/client/src/integration/plugin-registry.js";

import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { useT } from "../../../../core/client/src/i18n/index.js";
import type { ConsoleState } from "../../../../core/client/src/integration/types.js";
import { isDesktopShell } from "../../../../core/client/src/integration/desktop-shell.js";
import { ConsoleHelpMenu, useSideSubmenuGroup, useStandingAway } from "../../../../core/client/src/chrome/components/command-band-system-cluster.js";
import { ViewModeToggle } from "../../../../core/client/src/chrome/components/view-mode-toggle.js";
import { SettingsButton } from "../../../../core/client/src/chrome/toolbar/settings-button.js";
import { useMenuButtonKeyboard } from "../../../../core/client/src/chrome/components/use-menu-button-keyboard.js";
import { ArchiveMenuItem } from "../archive/archive-entry.js";
import { BrandMarkIcon, BrandWordmark } from "./conversation-brand.js";
import "./conversation-dock.css";

/**
 * 대화 화면의 하단 줄 — 아바타의 앱 메뉴와 선언형 플러그인 요약을 둔다.
 * 콘솔 전환은 위 공용 섹션이 맡고, 앱 메뉴에는 보기 모드(브라우저만)와 도움말·설정이 남는다.
 */
function SidebarFooterEntries({ popoverAnchorRef }: SidebarFooterEntryContext) {
  const registry = usePluginRegistry();
  // 옛 Band 기여도 버리지 않는다. 부관 머리만 기존 맨 위 자리에 남고, 나머지는 이 호환 경로를 따른다.
  const sidebarFooterEntries = useMemo(() => [...registry.sidebarFooterEntries, ...registry.commandBandEntries.filter((entry) => entry.id !== DEPUTY_COMMAND_BAND_ENTRY_ID).map((entry) => ({ id: entry.id, render: (_context: SidebarFooterEntryContext) => entry.render() }))], [registry.sidebarFooterEntries, registry.commandBandEntries]);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    const content = root?.firstElementChild;
    const dock = root?.parentElement;
    if (!root || !(content instanceof HTMLElement) || !dock) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      // 폭이 모자라면 플러그인이 표시한 칸을 오른쪽부터 하나씩 숨긴다. 첫 칸은 남겨 요약이 통째로 사라지지 않게 한다.
      const units = Array.from(content.querySelectorAll<HTMLElement>("[data-sidebar-footer-unit]"));
      for (const unit of units) delete unit.dataset.sidebarFooterDropped;
      for (let index = units.length - 1; index > 0 && content.getBoundingClientRect().width > root.clientWidth; index -= 1) {
        units[index]!.dataset.sidebarFooterDropped = "";
      }
      // 사이드바 전체의 가운데를 겨누되, 아바타와 겹치는 폭이면 기존 오른쪽 안전 칸 시작으로 물러난다.
      const dockRect = dock.getBoundingClientRect();
      const centeredLeft = dockRect.left + (dockRect.width - content.getBoundingClientRect().width) / 2;
      const offset = Math.max(0, centeredLeft - root.getBoundingClientRect().left);
      content.style.setProperty("--sidebar-footer-offset", `${offset}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    resize.observe(root); resize.observe(content); resize.observe(dock);
    const mutation = new MutationObserver(schedule);
    mutation.observe(content, { childList: true, subtree: true, characterData: true });
    document.fonts?.addEventListener("loadingdone", schedule);
    measure();
    return () => { resize.disconnect(); mutation.disconnect(); document.fonts?.removeEventListener("loadingdone", schedule); if (frame) cancelAnimationFrame(frame); };
  }, [sidebarFooterEntries]);
  if (!sidebarFooterEntries.length) return null;
  return <div className="sidebar-footer-entries" ref={ref}><span className="sidebar-footer-entries-content">{sidebarFooterEntries.map((entry) => {
    const Render = entry.render;
    return <PluginErrorBoundary key={entry.id} fallback={null}><Render popoverAnchorRef={popoverAnchorRef} /></PluginErrorBoundary>;
  })}</span></div>;
}

export function ConversationSideBarBottom({ connection }: { readonly connection: ConsoleState["connection"] }) {
  const t = useT();
  const state = useConsoleState();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverAnchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const name = state.consoleName || window.location.hostname;
  const label = t("chrome.system.menu");
  useMenuButtonKeyboard(rootRef, triggerRef, menuRef, open, setOpen, true);
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
          <ArchiveMenuItem onBeforeOpen={() => { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); }} />
          <div className="conversation-dock-divider" role="separator" />
          {/* Desktop에는 보기 모드가 없다. 브라우저에서만 보기 설정과 도움말·설정을 구분한다. */}
          {!isDesktopShell() ? <><ViewModeToggle className="conversation-dock-view" menuItem /><div className="conversation-dock-divider" role="separator" /></> : null}
          <ConsoleHelpMenu menuItem sideSubmenuGroup={sideSubmenus} />
          <div className="conversation-dock-settings" onClick={() => setOpen(false)}><SettingsButton menuItem /></div>
        </div>
      </div>
      <span className="conversation-dock-popover-anchor" ref={popoverAnchorRef} aria-hidden="true" />
      <span className="conversation-dock-brand" aria-label={state.channel === "local" ? "Fleet·DEV" : "Fleet"}>
        <BrandMarkIcon local={state.channel === "local"} /><BrandWordmark local={state.channel === "local"} />
      </span>
      <SidebarFooterEntries popoverAnchorRef={popoverAnchorRef} />
    </div>
  );
}

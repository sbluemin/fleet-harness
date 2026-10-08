import { useRef } from "react";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { useSideBarShortcutLabel } from "../../../../core/client/src/integration/shortcuts.js";
import { revealOperationStage } from "../../../../core/client/src/integration/store.js";
import { toggleWarRoomSideBar } from "../../../../core/client/src/integration/war-room-chrome-toggles.js";
import { useWarRoomChromeState } from "../../../../core/client/src/integration/war-room-chrome.js";
import { ToolbarTipLayer } from "../../../../core/client/src/chrome/toolbar/toolbar-tip.js";
import { WarRoomModeTools } from "../canvas/canvas-mode-switch.js";
import { pickTriageOperation } from "../canvas/triage-store.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import { useSideBarState } from "../sidebar/operations-side-bar-store.js";
import { useAttentionQueue } from "./use-attention-queue.js";

export function WarRoomIslandControls() {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const { state, queue, next } = useAttentionQueue();
  const chromeState = useWarRoomChromeState();
  const sidebar = useSideBarState();
  const shown = chromeState.sideBarRevealed && !sidebar.collapsed;
  const shortcut = useSideBarShortcutLabel();
  const label = `${queue.length ? `${t("warRoomChrome.attention.count", { count: queue.length })} — ` : ""}${t(shown ? "warRoomChrome.attention.closeSidebar" : "warRoomChrome.attention.openSidebar")} ${shortcut}`;
  const nextTheater = next ? state.theaters.find((theater) => theater.id === next.theaterId)?.label ?? next.theaterId : "";
  return <div ref={rootRef} className="war-room-island-controls">
    <ToolbarTipLayer rootRef={rootRef} />
    <button type="button" className={`war-room-island-sidebar${queue.length ? " has-attention" : ""}`} data-war-room-sidebar-anchor=""
      aria-label={label} data-tip={label} aria-pressed={shown} onClick={toggleWarRoomSideBar}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M6 2.5v11" /></svg>
      {queue.length ? <span className="war-room-island-count">{queue.length}</span> : null}
    </button>
    <>
      <button type="button" className="war-room-island-next" disabled={next === null}
        aria-label={next ? t("warRoomChrome.attention.nextTitle", { title: next.title, theater: theaterInitials(nextTheater) }) : t("warRoomChrome.attention.noNext")}
        data-tip={next ? t("warRoomChrome.attention.nextTitle", { title: next.title, theater: theaterInitials(nextTheater) }) : t("warRoomChrome.attention.noNext")}
        onClick={() => { if (next) { revealOperationStage(); pickTriageOperation(next.id); } }}>
        {t("canvas.triage.next")} <span aria-hidden="true">▸</span>
      </button>
      <span className="war-room-island-war-tools"><WarRoomModeTools compact /></span>
    </>
    <span className="console-toolbar-sep" aria-hidden="true" />
  </div>;
}

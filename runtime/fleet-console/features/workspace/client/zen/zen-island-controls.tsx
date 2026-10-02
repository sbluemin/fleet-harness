import { useRef } from "react";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { useSideBarShortcutLabel } from "../../../../core/client/src/integration/shortcuts.js";
import { revealOperationStage } from "../../../../core/client/src/integration/store.js";
import { toggleZenSideBar } from "../../../../core/client/src/integration/zen-chrome-toggles.js";
import { useZenModeState } from "../../../../core/client/src/integration/zen-mode.js";
import { ToolbarTipLayer } from "../../../../core/client/src/chrome/toolbar/toolbar-tip.js";
import { CanvasModeSwitch, WarRoomModeTools } from "../canvas/canvas-mode-switch.js";
import { pickTriageOperation, useTriageActive } from "../canvas/triage-store.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import { useSideBarState } from "../sidebar/operations-side-bar-store.js";
import { useAttentionQueue } from "./use-attention-queue.js";

export function ZenIslandControls() {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const { state, queue, next } = useAttentionQueue();
  const warRoom = useTriageActive();
  const zenState = useZenModeState();
  const sidebar = useSideBarState();
  const shown = zenState.sideBarRevealed && !sidebar.collapsed;
  const shortcut = useSideBarShortcutLabel();
  const label = `${queue.length ? `${t("zen.attention.count", { count: queue.length })} — ` : ""}${t(shown ? "zen.attention.closeSidebar" : "zen.attention.openSidebar")} ${shortcut}`;
  const nextTheater = next ? state.theaters.find((theater) => theater.id === next.theaterId)?.label ?? next.theaterId : "";
  return <div ref={rootRef} className="zen-island-controls">
    <ToolbarTipLayer rootRef={rootRef} />
    <button type="button" className={`zen-island-sidebar${queue.length ? " has-attention" : ""}`} data-zen-sidebar-anchor=""
      aria-label={label} data-tip={label} aria-pressed={shown} onClick={toggleZenSideBar}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M6 2.5v11" /></svg>
      {queue.length ? <span className="zen-island-count">{queue.length}</span> : null}
    </button>
    <CanvasModeSwitch />
    {warRoom ? <>
      <button type="button" className="zen-island-next" disabled={next === null}
        aria-label={next ? t("zen.attention.nextTitle", { title: next.title, theater: theaterInitials(nextTheater) }) : t("canvas.triage.queueEmpty")}
        data-tip={next ? t("zen.attention.nextTitle", { title: next.title, theater: theaterInitials(nextTheater) }) : t("canvas.triage.queueEmpty")}
        onClick={() => { if (next) { revealOperationStage(); pickTriageOperation(next.id); } }}>
        {t("canvas.triage.next")} <span aria-hidden="true">▸</span>
      </button>
      <span className="zen-island-war-tools"><WarRoomModeTools compact /></span>
    </> : null}
    <span className="console-toolbar-sep" aria-hidden="true" />
  </div>;
}

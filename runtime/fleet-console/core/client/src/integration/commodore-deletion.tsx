import { useEffect, useState } from "react";
import { isCommodoreDeletionOpen, leaveCommodore, subscribeCommodoreDeletionComplete, subscribeCommodoreLifecycle, type CommodoreDeletionNotice } from "../../../../features/commodore/client/commodore-delete-events.js";
import { refreshCommodoreList, readMobileCommodoreId, readZoneCommodore, selectMobileCommodore, setZoneCommodore } from "../../../../features/commodore/client/commodore-list.js";
import { forgetObjectiveOwner, objectiveIdsForRemovedOwner } from "../../../../features/objectives/client/objectives-state.js";
import { closeConversationSurface, getConversationSurface } from "../../../../features/workspace/client/conversation/conversation-surface-store.js";
import { forgetWorkbenchConversation } from "../../../../features/workspace/client/conversation/workbench/workbench-store.js";
import { closeTheaterInbox, readTheaterInbox } from "../../../../features/workspace/client/theater-inbox/store.js";
import { forgetTheaterGroupCollapse } from "../../../../features/workspace/client/sidebar/group-collapse-store.js";
import { setTheaterCollapsed } from "../../../../features/workspace/client/sidebar/objective-records-side-bar-store.js";
import { refreshAvatarBook } from "../../../../features/workspace/client/avatar-events.js";
import { closeCodexReader } from "../../../../features/codex/client/reader-store.js";
import { forgetCodexWorkspace, lastResolvedCodexWorkspace } from "../../../../features/codex/client/workspace-store.js";
import { getExpandedSurfaceState, closeExpandedSurface } from "../chrome/expanded-surface/store.js";
import { closePane, getPaneStoreSnapshot } from "../chrome/pane/pane-store.js";
import { closeRailPanel } from "../chrome/rail/rail-store.js";
import { getMobileDestination, getMobileSheetStack, setMobileDestination, syncMobileDestinationUrl } from "../chrome/mobile/mobile-store.js";
import { runAfterSheetRelease } from "../chrome/mobile/mobile-sheet-host.js";
import { showMobileToast } from "../chrome/mobile/mobile-toast.js";
import { Toast } from "../chrome/components/toast.js";
import { getState } from "./store.js";
import { getViewModeSnapshot } from "./view-mode-store.js";

/** 기능은 삭제 사실만 알리고, 호스트가 자기 화면·URL·history·초점을 정리한다. */
export function CommodoreDeletionHost() {
  const [notice, setNotice] = useState<CommodoreDeletionNotice | null>(null);
  useEffect(() => {
    const offRemoved = subscribeCommodoreLifecycle((event) => {
      if (event.op !== "removed" || isCommodoreDeletionOpen(event.commodoreId)) return;
      removeCommodoreViews(event.commodoreId);
    });
    const offComplete = subscribeCommodoreDeletionComplete((next) => {
      removeCommodoreViews(next.commodoreId, () => {
        if (getViewModeSnapshot().effective === "mobile") showMobileToast([next.message, next.warning].filter(Boolean).join(" "));
        else { setNotice(next); focusRemainingCommodore(next.focusId); }
      });
    });
    return () => { offRemoved(); offComplete(); };
  }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 7000); return () => clearTimeout(timer); }, [notice]);
  return <Toast open={notice !== null} tone={notice?.warning ? "warn" : "info"} title={notice?.message ?? ""} message={notice?.warning} onDismiss={() => setNotice(null)} />;
}

function removeCommodoreViews(id: string, done: () => void = () => {}) {
  const mobile = getViewModeSnapshot().effective === "mobile";
  forgetObjectiveOwner(id);
  const objectiveIds = objectiveIdsForRemovedOwner(id);
  const destination = getMobileDestination();
  const destinationOwned = destination.kind === "plugin" && destination.params?.commodoreId === id;
  const surface = getConversationSurface();
  const surfaceOwned = surface?.params.commodoreId === id || (typeof surface?.params.objectiveId === "string" && objectiveIds.has(surface.params.objectiveId));
  const wikiOwned = lastResolvedCodexWorkspace()?.id === id;
  const inbox = readTheaterInbox();
  const inboxOwned = inbox?.theaterId === id || (inbox && getState().theaters.find((theater) => theater.id === inbox.theaterId)?.commodore?.id === id);
  const clean = () => {
    if (surfaceOwned) closeConversationSurface();
    if (inboxOwned) closeTheaterInbox();
    if (wikiOwned) { closeCodexReader(); closeRailPanel("codex"); }
    for (const pane of getPaneStoreSnapshot().rail) if (pane.params.commodoreId === id || pane.params.workspaceId === id || pane.params.theaterId === id || objectiveIds.has(pane.params.objectiveId ?? "")) closePane(pane.paneId);
    for (const surface of getExpandedSurfaceState().instances) if (surface.params.commodoreId === id || surface.params.workspaceId === id || surface.params.theaterId === id || objectiveIds.has(surface.params.objectiveId ?? "")) closeExpandedSurface(surface.instanceId);
    forgetCodexWorkspace(id);
    forgetWorkbenchConversation(`session:commodore:commodore:${id}`);
    for (const objectiveId of objectiveIds) forgetWorkbenchConversation(`operation:${objectiveId}`);
    forgetTheaterGroupCollapse(id); setTheaterCollapsed(id, false);
    if (readZoneCommodore() === id) setZoneCommodore(null);
    if (readMobileCommodoreId() === id) selectMobileCommodore(null);
    if (destinationOwned) { setMobileDestination({ kind: "home" }); syncMobileDestinationUrl(); }
    else {
      // 데스크톱에서 화면과 URL이 어긋났어도 삭제된 주소만 걷는다. 다른 사령관 화면은 그대로 둔다.
      const raw = new URLSearchParams(window.location.search).get("dest");
      if (raw?.startsWith("plugin:") && new URLSearchParams(raw.slice(raw.indexOf("?") + 1)).get("commodoreId") === id) { setMobileDestination({ kind: "home" }); syncMobileDestinationUrl(); }
    }
    void refreshCommodoreList(); void refreshAvatarBook();
    done();
  };
  const leave = () => { if (mobile && destinationOwned) leaveCommodore(id, clean); else clean(); };
  if (mobile && destinationOwned && getMobileSheetStack().length) runAfterSheetRelease(leave); else leave();
}
function focusRemainingCommodore(id: string | null): void {
  requestAnimationFrame(() => {
    const next = id ? document.querySelector<HTMLElement>(`[data-theater-id="${CSS.escape(id)}"] .side-bar-theater-activate`) : null;
    (next ?? document.querySelector<HTMLElement>(".side-bar-starter-primary, .side-bar-theater-activate"))?.focus({ preventScroll: true });
  });
}

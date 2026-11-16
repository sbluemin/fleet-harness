import { getT as getBrowserT } from "./i18n.js";
import { useBrowserEngine } from "./browser-engine.js";
import { useBrowserClosedTabs, useBrowserDriving, useBrowserTabCount, useBrowserSurface, openBrowserPane } from "./browser-surface.js";
import { toggleBrowserViewerShell, useBrowserViewerShell } from "./browser-viewer-shell.js";
import { useObjectiveUse } from "../../computer-use/client/computer-screen-share.js";
import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";

/**
 * 대화 타임라인의 플릿 브라우저 사건 줄.
 *
 * 칸이 열려 있으면 무엇을 하는지 한 줄로 말하고(에이전트가 쓰는 동안은 그 사실이 먼저다), 칸이 닫히면 마지막 탭 수와
 * 「다시 열기」를 남긴다. 사건마다 줄을 쌓지 않는다 — 지금 상태 하나가 한 줄이고, 다시 열면 닫힘 줄은 사라진다.
 * 그래서 연속으로 여닫아도 타임라인이 도배되지 않는다.
 */
export function BrowserActivityLines({ objectiveId }: { readonly objectiveId: string }) {
  const t = getBrowserT(useConsoleLocale());
  const engine = useBrowserEngine();
  const surface = useBrowserSurface();
  const driving = useBrowserDriving();
  const tabs = useBrowserTabCount();
  const closedTabs = useBrowserClosedTabs();
  const agentUsing = useObjectiveUse(objectiveId).browser;
  const viewer = engine?.surfaceMode === "viewer" || (engine === null && !isDesktopShell());
  const streamedShell = viewer || engine?.surfaceMode === "remote";
  const viewerShell = useBrowserViewerShell();
  const engineMissing = !streamedShell && engine !== null && !engine.available;
  const canLaunch = !engineMissing && (!streamedShell || viewerShell);
  const openAction = () => {
    if (streamedShell) toggleBrowserViewerShell();
    else openBrowserPane();
  };
  // 에이전트가 이 대화의 세션으로 쓰는 중이거나, 전역 브라우저가 구동 중이면 그 사실이 먼저다.
  // 칸이 닫혀 있어도 에이전트가 쓰는 동안은 이 줄이 남는다 — 보기로 다시 열 수 있다.
  const live = driving || agentUsing;
  if (surface !== null || live) {
    const label = live
      ? t("terminal.browser.activity.agentUsing", { count: tabs })
      : t("terminal.browser.activity.open", { count: tabs });
    const canOpen = canLaunch && (streamedShell || surface === null || surface.mode === "window");
    return (
      <div className="agent-chat-browser-line is-live">
        <span className="agent-chat-browser-dot" aria-hidden="true" />
        <span className="agent-chat-browser-text">{label}</span>
        {canOpen ? (
          <button
            type="button"
            className="agent-chat-browser-action"
            onClick={openAction}
          >
            {t(surface?.mode === "window" ? "terminal.browser.activity.focus" : "terminal.browser.activity.view")}
          </button>
        ) : null}
      </div>
    );
  }
  // 닫힘 줄은 이 화면에서 브라우저를 한 번 연 뒤에만 선다 — 한 번도 연 적 없는 화면에 "닫힘"을 말하지 않는다.
  if (closedTabs !== null && closedTabs > 0) {
    return (
      <div className="agent-chat-browser-line">
        <span className="agent-chat-browser-text">{t("terminal.browser.activity.closed", { count: closedTabs })}</span>
        {canLaunch ? (
          <button type="button" className="agent-chat-browser-action" onClick={openAction}>
            {t("terminal.browser.activity.reopen")}
          </button>
        ) : null}
      </div>
    );
  }
  return null;
}

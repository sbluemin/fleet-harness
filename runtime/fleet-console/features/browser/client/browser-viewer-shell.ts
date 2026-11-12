import { DESKTOP_BROWSER_VIEWER_CAPABILITY, DESKTOP_WINDOW_COMMAND_PATH } from "@fleet-console/protocol/desktop";
import { isDesktopShell, useDesktopShellHome } from "../../../core/client/src/integration/desktop-shell.js";

/**
 * 보기 전용 플릿 브라우저 셸의 Console 쪽 손잡이. 이 Console 을 관리하지 않는 Desktop 창(원격·비관리)에서는 그 Desktop 이 플릿 브라우저 셸을
 * 보기 전용으로 그리고 소유한다 — Console 은 그 셸에게 "열거나 닫아 달라"는 창 명령만 보내고, 화면도 열림 상태도 갖지 않는다.
 * 웹·모바일과 이 능력을 모르는 옛 Desktop 에는 보기 화면이 없다.
 */
export function useBrowserViewerShell(): boolean {
  const capabilities = useDesktopShellHome().capabilities;
  return isDesktopShell() && capabilities.includes(DESKTOP_BROWSER_VIEWER_CAPABILITY);
}

/** 이 창을 든 Desktop 셸에게 보기 전용 브라우저 셸을 열거나 닫아 달라고 한다. 명령은 걸어 두지 않으므로 실패는 조용히 지나간다. */
export function toggleBrowserViewerShell(): void {
  void fetch(DESKTOP_WINDOW_COMMAND_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "toggle-browser-viewer" }), signal: AbortSignal.timeout(3000) }).catch(() => undefined);
}

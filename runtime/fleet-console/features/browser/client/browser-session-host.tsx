import type { ConsoleLocale } from "@fleet-console/i18n";
import * as React from "react";
import { createPortal } from "react-dom";

import { Toast } from "../../../core/client/src/chrome/components/toast.js";
import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import { subscribeConsoleChannel } from "../../../core/client/src/integration/objective-records-sse.js";
import { getState, subscribe } from "../../../core/client/src/integration/store.js";
import { publishBrowserEngine, useBrowserPluginAttach, type BrowserUnavailableReason } from "./browser-engine.js";
import { useBrowserShortcutsSync } from "./browser-shortcuts-sync.js";
import { dismissSharedFallback, useSharedFallbackNotice } from "./browser-shared-fallback.js";
import { getT } from "./i18n.js";

export interface BrowserClientServices {
  readonly pushComposerInbox: (objectiveId: string, entry: { readonly files: readonly File[] }) => void;
}

/** Desktop 이 그린 크롬이 만든 이미지(스크린샷·주석 결과)가 서버를 거쳐 오는 채널 — Console 이 크롬에서 받는 유일한 것. */
const BROWSER_ATTACH_EVENT = "browser:attach";
interface AttachPayload { readonly kind: "screenshot" | "annotation"; readonly mime: "image/png"; readonly data: string }

/** 지금 보는 대화(활성 Objective) — 첨부가 향하는 곳. */
function useActiveAttachTarget(): { readonly objectiveId: string; readonly chat: boolean } | null {
  const key = React.useSyncExternalStore(subscribe, () => {
    const state = getState();
    const record = state.activeObjectiveId === null ? undefined : state.objectiveRecords.find((entry) => entry.id === state.activeObjectiveId);
    return record ? `${record.chatMode === true ? "chat" : "terminal"}|${record.id}` : "";
  }, () => "");
  return React.useMemo(() => {
    if (key === "") return null;
    const split = key.indexOf("|");
    return { chat: key.slice(0, split) === "chat", objectiveId: key.slice(split + 1) };
  }, [key]);
}

function pngFile(payload: AttachPayload): File {
  const bytes = Uint8Array.from(atob(payload.data), (char) => char.charCodeAt(0));
  return new File([bytes], `browser-${payload.kind}-${Date.now()}.png`, { type: "image/png" });
}

/**
 * Session 브라우저가 쓰는 Console 전역 호스트. 표면과 크롬은 Desktop 이 그리므로 여기에는 그릴 것이 없다.
 * - 네이티브 뷰가 포커스를 가져도 단축키가 따라가게 한다.
 * - 엔진 가용성을 지구본에 알린다.
 * - Desktop 이 넘긴 이미지를 지금 보는 대화의 입력창으로 올린다: 채팅이면 컴포저 칩, 터미널이면 서버가 CLI 기계의 클립보드에 올려 붙여넣는다.
 * - shared 중 내 브라우저로 연 링크를 한 번 안내한다.
 */
export function BrowserSessionHost({ language, services }: {
  readonly language: ConsoleLocale | undefined;
  readonly services: BrowserClientServices;
}) {
  useBrowserShortcutsSync(isDesktopShell());
  useBrowserAvailabilityWatch();
  const t = getT(language);
  const fallbackNotice = useSharedFallbackNotice();
  const toastHost = typeof document === "undefined" ? null : document.querySelector(".app-toast-host");
  const attach = useActiveAttachTarget();
  const pluginAttach = useBrowserPluginAttach();
  const { pushComposerInbox } = services;
  const [notice, setNotice] = React.useState<string | null>(null);
  const deliver = React.useRef<(payload: AttachPayload) => void>(() => undefined);
  deliver.current = (payload) => {
    // 컴포저에 칩이 서는 것이 곧 결과다 — 안내 문구를 따로 띄우지 않는다.
    if (attach?.chat) { pushComposerInbox(attach.objectiveId, { files: [pngFile(payload)] }); return; }
    if (attach === null && pluginAttach) { pluginAttach([pngFile(payload)]); return; }
    if (attach === null) { setNotice(t("terminal.browser.requestFailed")); return; }
    // 터미널 Objective: 서버가 이 기계의 클립보드에 올린 뒤 Ctrl+V 를 눌러 준다 — CLI 는 자기가 도는 기계의 클립보드를 읽는다.
    void fetch(`/api/v1/browser/objectives/${encodeURIComponent(attach.objectiveId)}/paste`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: payload.data }) })
      .then(async (response) => {
        // 터미널에 이미지가 붙는 것이 곧 결과다 — 성공 안내는 없고 실패만 말한다.
        if (response.ok) return;
        let code: string | null = null;
        try { code = ((await response.json()) as { error?: string }).error ?? null; } catch { /* 본문 없음 */ }
        setNotice(code === "terminal_not_running" ? t("terminal.browser.terminalNotRunning") : code === "clipboard_failed" ? t("terminal.browser.clipboardFailed") : t("terminal.browser.requestFailed"));
      })
      .catch(() => setNotice(t("terminal.browser.requestFailed")));
  };
  React.useEffect(() => {
    if (!isDesktopShell()) return;
    return subscribeConsoleChannel(BROWSER_ATTACH_EVENT, (payload) => {
      const body = payload as Partial<AttachPayload> | null;
      if (!body || (body.kind !== "screenshot" && body.kind !== "annotation") || body.mime !== "image/png" || typeof body.data !== "string") return;
      deliver.current(body as AttachPayload);
    });
  }, []);
  React.useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 4000); return () => clearTimeout(timer); }, [notice]);
  return (
    <>
      {fallbackNotice && toastHost ? createPortal(
        <Toast open tone="info" title={t("terminal.browser.sharedFallback")} onDismiss={() => dismissSharedFallback()} />,
        toastHost,
      ) : null}
      {notice && toastHost ? createPortal(<Toast open tone="info" title={notice} onDismiss={() => setNotice(null)} />, toastHost) : null}
    </>
  );
}

function publishAvailability(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const body = payload as { available?: unknown; reason?: unknown };
  if (typeof body.available !== "boolean") return;
  const reason: BrowserUnavailableReason = body.reason === "shared" ? "shared" : "desktop_required";
  publishBrowserEngine(body.available ? { available: true } : { available: false, reason });
}

function useBrowserAvailabilityWatch(): void {
  React.useEffect(() => {
    if (!isDesktopShell()) return;
    const unsubscribeState = subscribeConsoleChannel("browser:state", publishAvailability);
    const unsubscribeAvailability = subscribeConsoleChannel("browser:availability", publishAvailability);
    return () => { unsubscribeState(); unsubscribeAvailability(); };
  }, []);
}

import type { ConsoleLocale } from "@fleet-console/i18n";
import * as React from "react";
import { createPortal } from "react-dom";

import { Toast } from "../../../core/client/src/chrome/components/toast.js";
import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import { subscribeConsoleChannel } from "../../../core/client/src/integration/objective-records-sse.js";
import { getState, subscribe } from "../../../core/client/src/integration/store.js";
import { BrowserWindowPanel, type BrowserClientServices } from "./browser-panel.js";
import { publishBrowserEngine, type BrowserUnavailableReason } from "./browser-panel-store.js";
import { useBrowserShortcutsSync } from "./browser-shortcuts-sync.js";
import { dismissSharedFallback, useSharedFallbackNotice } from "./browser-shared-fallback.js";
import { getT } from "./i18n.js";

/** 지금 보는 대화(활성 Objective) — 분리 창의 스크린샷 첨부가 향하는 곳. 대화 칸이 없어도 창은 이 값으로 첨부한다. */
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

/**
 * Session 브라우저가 쓰는 Console 전역 호스트.
 * 네이티브 뷰가 포커스를 가져도 단축키가 따라가게 하고, 패널이 닫혀 있어도 엔진 가용성을 지구본에 알리며,
 * shared 중 내 브라우저로 연 링크를 한 번 안내한다. 분리 창이 열려 있으면 그 안의 패널을 여기서 세운다 — 창은 보고 있는 대화가
 * 아니라 Console 의 것이므로 대화를 오가도 풀리지 않는다.
 */
export function BrowserSessionHost({ language, theme, services }: {
  readonly language: ConsoleLocale | undefined;
  readonly theme: React.ComponentProps<typeof BrowserWindowPanel>["theme"];
  readonly services: BrowserClientServices;
}) {
  useBrowserShortcutsSync(isDesktopShell());
  useBrowserAvailabilityWatch();
  const t = getT(language);
  const fallbackNotice = useSharedFallbackNotice();
  const toastHost = typeof document === "undefined" ? null : document.querySelector(".app-toast-host");
  const attach = useActiveAttachTarget();
  const { pushComposerInbox } = services;
  const onAttach = React.useMemo(
    () => attach?.chat ? (files: readonly File[]) => pushComposerInbox(attach.objectiveId, { files }) : undefined,
    [attach, pushComposerInbox],
  );
  return (
    <>
      <BrowserWindowPanel
        language={language}
        theme={theme}
        services={services}
        {...(onAttach ? { onAttach } : {})}
        terminalPaste={attach !== null && !attach.chat}
        {...(attach ? { pasteTargetId: attach.objectiveId } : {})}
      />
      {fallbackNotice && toastHost ? createPortal(
        <Toast open tone="info" title={t("terminal.browser.sharedFallback")} onDismiss={() => dismissSharedFallback()} />,
        toastHost,
      ) : null}
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

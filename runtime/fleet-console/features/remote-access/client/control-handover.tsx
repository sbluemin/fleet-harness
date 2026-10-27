import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { SessionEndedReason } from "./control-session.js";
import { revokeRemoteAccessSession } from "../../settings/client/global-settings-api.js";
import { useConsoleState } from "../../../core/client/src/hooks/use-store.js";
import { formatRelativeTime, useConsoleLocale, useT, type CoreMessageKey } from "../../../core/client/src/i18n/index.js";
import { resumeConsoleSession } from "../../../core/client/src/integration/api.js";
import { dismissControlCurtain } from "../../../core/client/src/integration/store.js";
import { desktopPickerUrl, isDesktopShell, useDesktopShellHome } from "../../../core/client/src/integration/desktop-shell.js";

export function ControlBar() {
  const state = useConsoleState();
  const locale = useConsoleLocale();
  const t = useT();
  const [reclaiming, setReclaiming] = useState(false);
  const [reclaimError, setReclaimError] = useState(false);
  const holder = state.controlHolder;

  if (holder === null || !state.controlCurtainDismissed) return null;
  const device = holder.device ?? t("settings.remote.table.unnamedDevice");
  const joined = formatRelativeTime(holder.openedAt, locale);
  const takeBackControl = () => {
    if (reclaiming) return;
    setReclaiming(true);
    setReclaimError(false);
    void revokeRemoteAccessSession(holder.handle)
      .catch(() => setReclaimError(true))
      .finally(() => setReclaiming(false));
  };

  return (
    <div className="control-bar" role="status" aria-live="polite">
      <span className="control-bar-signal" aria-hidden="true" />
      <span className="control-bar-copy">
        <strong>{t("chrome.control.bar.title", { name: device })}</strong>
        <span>{t("chrome.control.bar.joined", { time: joined })}</span>
        {reclaimError ? <span className="control-bar-error" role="alert">{t("chrome.control.reclaimError")}</span> : null}
      </span>
      <button type="button" disabled={reclaiming} onClick={takeBackControl}>
        {reclaiming ? t("chrome.control.reclaiming") : t("chrome.control.takeBack")}
      </button>
    </div>
  );
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function ControlCurtain() {
  const state = useConsoleState();
  const t = useT();
  const [reclaiming, setReclaiming] = useState(false);
  const [reclaimError, setReclaimError] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const primaryActionRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const holder = state.controlHolder;
  const open = holder !== null && !state.controlCurtainDismissed;

  useEffect(() => {
    if (!open) return;
    const shell = document.querySelector<HTMLElement>(".console-shell");
    if (shell) shell.inert = true;
    return () => {
      if (shell) shell.inert = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    primaryActionRef.current?.focus();
    return () => {
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      target?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissControlCurtain();
      } else if (event.key === "Tab") {
        trapFocus(event, cardRef.current);
      }
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open]);

  if (!open || holder === null) return null;
  const device = holder.device ?? t("settings.remote.table.unnamedDevice");
  const takeBackControl = () => {
    if (reclaiming) return;
    setReclaiming(true);
    setReclaimError(false);
    void revokeRemoteAccessSession(holder.handle)
      .catch(() => setReclaimError(true))
      .finally(() => setReclaiming(false));
  };

  return createPortal(
    <div className="control-curtain" role="dialog" aria-modal="true" aria-labelledby="control-curtain-title">
      <div className="control-curtain-scrim" aria-hidden="true" />
      <section className="control-curtain-card" ref={cardRef}>
        <span className="control-curtain-signal" aria-hidden="true" />
        <div className="control-curtain-copy">
          <span className="control-curtain-eyebrow">{t("chrome.control.curtain.eyebrow")}</span>
          <h2 id="control-curtain-title">{t("chrome.control.curtain.title", { name: device })}</h2>
          <p>{t("chrome.control.curtain.body")}</p>
        </div>
        {reclaimError ? <p className="control-curtain-error" role="alert">{t("chrome.control.reclaimError")}</p> : null}
        <div className="control-curtain-actions">
          <button
            ref={primaryActionRef}
            type="button"
            className="control-curtain-primary"
            disabled={reclaiming}
            onClick={takeBackControl}
          >
            {reclaiming ? t("chrome.control.reclaiming") : t("chrome.control.takeBack")}
          </button>
          <button type="button" className="control-curtain-secondary" onClick={dismissControlCurtain}>
            {t("chrome.control.keepWatching")}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function trapFocus(event: KeyboardEvent, container: HTMLElement | null): void {
  if (!container) return;
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * 화면은 하나지만 문구는 갈린다. 아무도 회수하지 않았는데 "회수되었습니다"가 뜨면, 이어받은
 * 기기를 찾아가야 할 사람이 자기 콘솔 주인을 의심한다.
 */
const NOTICE_COPY = {
  reclaimed: {
    eyebrow: "chrome.control.reclaimed.eyebrow",
    title: "chrome.control.reclaimed.title",
    body: "chrome.control.reclaimed.body",
  },
  superseded: {
    eyebrow: "chrome.control.superseded.eyebrow",
    title: "chrome.control.superseded.title",
    body: "chrome.control.superseded.body",
  },
} as const satisfies Record<SessionEndedReason, Record<"eyebrow" | "title" | "body", CoreMessageKey>>;

export function ControlReclaimedNotice() {
  const t = useT();
  const reason = useConsoleState().controlReclaimed;
  const home = useDesktopShellHome();
  const [reclaiming, setReclaiming] = useState(false);
  const [reclaimError, setReclaimError] = useState(false);

  if (reason === null) return null;
  const copy = NOTICE_COPY[reason];
  /**
   * 종료 안내는 세션이 끝난 문서에 남는다. 토큰 없는 join이 페어링 쿠키를 새 세션으로
   * 바꾼 뒤에만 다시 읽는다 — 그 전에 다시 읽으면 세션 없는 `/console/`이 401 문서가 된다.
   * 이 요청은 창의 fetch라 같은 Electron 세션의 HttpOnly 페어링 쿠키가 실린다.
   */
  const takeBackControl = () => {
    if (reclaiming) return;
    setReclaiming(true);
    setReclaimError(false);
    void resumeConsoleSession()
      .then(() => { location.reload(); })
      .catch(() => {
        setReclaimError(true);
        setReclaiming(false);
      });
  };
  /**
   * 돌아갈 origin은 셸이 게시한 집뿐이다. 브라우저와 모바일은 그 게시가 없어 버튼을 두지 않는다.
   * Desktop은 이 항해를 가로채 `/console/`으로 열고, 호스트 목록 신호는 싣지 않는다.
   */
  const localConsole = isDesktopShell() && home.origin !== null ? home.origin : null;
  const returnToLocalConsole = () => {
    if (localConsole === null) return;
    location.assign(new URL("/console/", `${localConsole}/`).toString());
  };

  return createPortal(
    <div className="control-reclaimed-notice" role="alert" aria-live="assertive">
      <section className="control-reclaimed-card">
        <span className="control-reclaimed-signal" aria-hidden="true" />
        <span className="control-reclaimed-eyebrow">{t(copy.eyebrow)}</span>
        <h2>{t(copy.title)}</h2>
        <p>{t(copy.body)}</p>
        {reason === "reclaimed" && isDesktopShell() && home.origin !== null ? <a className="control-reclaimed-home" href={desktopPickerUrl(home.origin)}>{t("chrome.control.chooseHost")}</a> : null}
        {reason === "superseded" ? (
          <>
            {reclaimError ? <p className="control-curtain-error" role="alert">{t("chrome.control.reclaimError")}</p> : null}
            <div className="control-curtain-actions">
              <button type="button" className="control-curtain-primary" disabled={reclaiming} onClick={takeBackControl}>
                {reclaiming ? t("chrome.control.reclaiming") : t("chrome.control.takeBack")}
              </button>
              {localConsole !== null ? (
                <button type="button" className="control-curtain-secondary" onClick={returnToLocalConsole}>
                  {t("chrome.control.returnLocal")}
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}

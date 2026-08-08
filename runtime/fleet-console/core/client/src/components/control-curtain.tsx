import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { revokeRemoteAccessSession } from "../global-settings-api.js";
import { useConsoleState } from "../hooks/use-store.js";
import { useT } from "../i18n/index.js";
import { dismissControlCurtain } from "../store.js";

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

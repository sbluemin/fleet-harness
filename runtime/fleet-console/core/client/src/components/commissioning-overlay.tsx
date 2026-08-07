import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { addTheater, issueTheaterFolderGrant } from "../api.js";
import { useGlobalSettingsStore } from "../global-settings-store.js";
import { useT } from "../i18n/index.js";
import { beginAddTheater, closeOnboarding, completeAddTheater, failAddTheater } from "../store.js";
import type { ConsoleState } from "../types.js";
import { DirectoryBrowserModal } from "./directory-browser-modal.js";

interface CommissioningOverlayProps {
  readonly state: ConsoleState;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function CommissioningOverlay({ state }: CommissioningOverlayProps) {
  const t = useT();
  const globalSettings = useGlobalSettingsStore();
  const [browserOpen, setBrowserOpen] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const primaryActionRef = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const theaterRegistered = state.theaters.length > 0;

  useEffect(() => {
    if (!state.onboardingOpen) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    primaryActionRef.current?.focus();
    return () => {
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      target?.focus?.();
    };
  }, [state.onboardingOpen]);

  useEffect(() => {
    if (!state.onboardingOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (browserOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeOnboarding();
      } else if (event.key === "Tab") {
        trapFocus(event, cardRef.current);
      }
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [browserOpen, state.onboardingOpen]);

  if (globalSettings.loadStatus !== "ready" || !state.onboardingOpen) return null;

  const handleChooseFolder = () => {
    setBrowserOpen(true);
  };

  const handleBrowserCancel = () => {
    setBrowserOpen(false);
  };

  const handleBrowserConfirm = async (path: string) => {
    setBrowserOpen(false);
    beginAddTheater();
    try {
      const folderGrantId = await issueTheaterFolderGrant(path);
      const result = await addTheater(folderGrantId);
      completeAddTheater(result);
    } catch (error) {
      failAddTheater(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="commissioning-overlay" role="dialog" aria-modal="true" aria-labelledby="commissioning-title">
      <button type="button" className="commissioning-scrim" onClick={closeOnboarding} aria-label={t("chrome.commissioning.closeAria")} />
      <section className="commissioning-card" ref={cardRef}>
        <header className="commissioning-header">
          <span className="commissioning-eyebrow">{t("chrome.commissioning.eyebrow")}</span>
          <h2 id="commissioning-title">{t("chrome.commissioning.title")}</h2>
          <p>{t("chrome.commissioning.lead")}</p>
        </header>

        <ol className="commissioning-steps">
          <li className={`commissioning-step commissioning-step--primary ${theaterRegistered ? "is-complete" : "is-current"}`}>
            <span className="commissioning-step-node" aria-hidden="true">{theaterRegistered ? "✓" : "01"}</span>
            <div className="commissioning-step-body">
              <h3>{t("chrome.commissioning.step1Title")}</h3>
              <p>{t("chrome.commissioning.step1Body")}</p>
              {theaterRegistered ? (
                <Link
                  ref={(node) => {
                    primaryActionRef.current = node;
                  }}
                  className="commissioning-primary-action"
                  to="/operations"
                  onClick={closeOnboarding}
                >
                  {t("chrome.commissioning.goToOperationsArrow")}
                </Link>
              ) : (
                <button
                  ref={(node) => {
                    primaryActionRef.current = node;
                  }}
                  type="button"
                  className="commissioning-primary-action is-live"
                  disabled={state.addingTheater}
                  onClick={handleChooseFolder}
                >
                  {state.addingTheater ? t("chrome.commissioning.addingTheater") : t("chrome.commissioning.chooseFolder")}
                </button>
              )}
              {state.theaterError ? <p className="commissioning-error" role="alert">{state.theaterError}</p> : null}
            </div>
          </li>

          <li className="commissioning-step">
            <span className="commissioning-step-node" aria-hidden="true">02</span>
            <div className="commissioning-step-body">
              <h3>{t("chrome.commissioning.step2Title")}</h3>
              <p>{t("chrome.commissioning.step2Body")}</p>
              <Link className="commissioning-secondary-link" to="/operations" onClick={closeOnboarding}>
                {t("chrome.commissioning.goToOperations")}
              </Link>
            </div>
          </li>
        </ol>

        <footer className="commissioning-footer">
          <p>{t("chrome.commissioning.footer")}</p>
          <button type="button" className="commissioning-skip" onClick={closeOnboarding}>{t("chrome.commissioning.skip")}</button>
        </footer>
      </section>
      <DirectoryBrowserModal open={browserOpen} onCancel={handleBrowserCancel} onConfirm={handleBrowserConfirm} />
    </div>
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

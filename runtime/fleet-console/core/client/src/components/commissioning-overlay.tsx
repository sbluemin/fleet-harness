import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { addTheater, issueTheaterFolderGrant } from "../api.js";
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

  if (!state.onboardingOpen) return null;

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
      <button type="button" className="commissioning-scrim" onClick={closeOnboarding} aria-label="Close Commissioning guide" />
      <section className="commissioning-card" ref={cardRef}>
        <header className="commissioning-header">
          <span className="commissioning-eyebrow">COMMISSIONING · FLEET CONSOLE</span>
          <h2 id="commissioning-title">Bring your fleet online</h2>
          <p>Three steps to go from an empty bridge to live carrier operations.</p>
        </header>

        <ol className="commissioning-steps">
          <li className={`commissioning-step commissioning-step--primary ${theaterRegistered ? "is-complete" : "is-current"}`}>
            <span className="commissioning-step-node" aria-hidden="true">{theaterRegistered ? "✓" : "01"}</span>
            <div className="commissioning-step-body">
              <h3>Register a Theater</h3>
              <p>A Theater is a project directory the fleet operates in. Choose the folder you want to work from.</p>
              {theaterRegistered ? (
                <Link
                  ref={(node) => {
                    primaryActionRef.current = node;
                  }}
                  className="commissioning-primary-action"
                  to="/operations"
                  onClick={closeOnboarding}
                >
                  Go to Operations →
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
                  {state.addingTheater ? "Adding Theater…" : "Choose a folder…"}
                </button>
              )}
              {state.theaterError ? <p className="commissioning-error" role="alert">{state.theaterError}</p> : null}
            </div>
          </li>

          <li className="commissioning-step">
            <span className="commissioning-step-node" aria-hidden="true">02</span>
            <div className="commissioning-step-body">
              <h3>Open an Operation</h3>
              <p>An Operation is a live terminal session running an Agent CLI. Start one from the Operations tab to begin a working session.</p>
              <Link className="commissioning-secondary-link" to="/operations" onClick={closeOnboarding}>
                Go to Operations
              </Link>
            </div>
          </li>

          <li className="commissioning-step">
            <span className="commissioning-step-node" aria-hidden="true">03</span>
            <div className="commissioning-step-body">
              <h3>Observe carriers</h3>
              <p>Carriers are specialist agents your Admiral dispatches. Their sorties stream here in real time as they run.</p>
            </div>
          </li>
        </ol>

        <footer className="commissioning-footer">
          <p>Theaters with a Fleet Wiki knowledge root also unlock Codex — your decision log and reference library.</p>
          <button type="button" className="commissioning-skip" onClick={closeOnboarding}>Skip for now</button>
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

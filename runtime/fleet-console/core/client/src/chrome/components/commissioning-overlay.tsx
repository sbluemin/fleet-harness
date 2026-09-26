import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { addTheater, issueTheaterFolderGrant } from "../../integration/api.js";
import { useGlobalSettingsStore } from "../../../../../features/settings/client/global-settings-store.js";
import { takeCommissioningReturnFocus } from "../../integration/shortcuts.js";
import { useT } from "../../i18n/index.js";
import { beginAddTheater, closeOnboarding, completeAddTheater, failAddTheater } from "../../integration/store.js";
import type { ConsoleState } from "../../integration/types.js";
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
    // 팔레트처럼 자신이 닫히며 여는 표면은 opener를 채널로 넘긴다 — 그 경우 activeElement는 이미 body다.
    returnFocusRef.current = takeCommissioningReturnFocus()
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
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

  // pending 동안만 숨긴다 — 첫 부팅의 자동 열림은 설정이 결정되기 전에 번쩍이면 안 된다. 설정 조회가
  // 실패한 뒤에도 사용자가 팔레트·시작 블록에서 명시적으로 열면 가이드는 서야 한다. 그렇지 않으면
  // onboardingOpen만 켜진 채 아무것도 보이지 않고, 다음 시도는 이미 열린 것으로 보아 무시된다.
  if (globalSettings.loadStatus === "pending" || !state.onboardingOpen) return null;

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
          <FleetMark />
          <span className="commissioning-eyebrow">{t("chrome.commissioning.eyebrow")}</span>
          <h2 id="commissioning-title">{t("chrome.commissioning.title")}</h2>
          <p>{t("chrome.commissioning.lead")}</p>
        </header>

        <ol className="commissioning-steps">
          <li className={`commissioning-step ${theaterRegistered ? "is-complete" : "is-current"}`}>
            <span className="commissioning-step-node" aria-hidden="true">{theaterRegistered ? <CheckGlyph /> : "1"}</span>
            <div className="commissioning-step-body">
              <h3>{t("chrome.commissioning.step1Title")}</h3>
              <p>{t("chrome.commissioning.step1Body")}</p>
              {theaterRegistered ? null : (
                <button
                  ref={(node) => {
                    primaryActionRef.current = node;
                  }}
                  type="button"
                  className="commissioning-primary-action"
                  disabled={state.addingTheater}
                  onClick={handleChooseFolder}
                >
                  <FolderGlyph />
                  {state.addingTheater ? t("chrome.commissioning.addingTheater") : t("chrome.commissioning.chooseFolder")}
                </button>
              )}
              {state.theaterError ? <p className="commissioning-error" role="alert">{state.theaterError}</p> : null}
            </div>
          </li>

          <li className={`commissioning-step ${theaterRegistered ? "is-current" : ""}`}>
            <span className="commissioning-step-node" aria-hidden="true">2</span>
            <div className="commissioning-step-body">
              <h3>{t("chrome.commissioning.step2Title")}</h3>
              <p>{t("chrome.commissioning.step2Body")}</p>
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
              ) : null}
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

/** 첫 실행 카드 머리의 작은 표식 — 캔버스 위에 떠 있는 두 패널. 테마 토큰만 쓴다. */
function FleetMark() {
  return (
    <svg className="commissioning-mark" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <rect className="commissioning-mark-plate" x="1" y="1" width="38" height="38" rx="11" />
      <rect className="commissioning-mark-panel" x="10" y="12" width="12" height="16" rx="3" />
      <rect className="commissioning-mark-fill" x="24" y="12" width="6" height="7" rx="2" />
      <rect className="commissioning-mark-panel" x="24" y="21" width="6" height="7" rx="2" opacity="0.7" />
    </svg>
  );
}

function FolderGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 6.3 4.8 8.6 9.5 3.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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

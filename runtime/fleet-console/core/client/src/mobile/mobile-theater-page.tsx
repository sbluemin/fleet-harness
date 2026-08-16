import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { DirectoryBrowserModal } from "../components/directory-browser-modal.js";
import { useT } from "../i18n/index.js";
import { resolveOperationActivity } from "../operation-activity.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import { setActiveTheater } from "../store.js";
import { registerTheaterFromPath } from "../theater-crud.js";
import type { ConsoleState } from "../types.js";
import { setMobileTab } from "./mobile-store.js";
import "../styles/mobile.css";

/**
 * The phone's Theater surface. The desktop switches Theater from the command band, which this
 * layout hides, so on a phone the only way across was launching a new Operation into another
 * Theater. This is a page rather than a menu over the list: a tab is a destination, so each row
 * carries what is happening inside that Theater — how many Operations, how many waiting — and the
 * screen is worth opening even when nothing is switched.
 */
export function MobileTheaterPage({ state }: { readonly state: ConsoleState }) {
  const t = useT();
  const navigate = useNavigate();
  const [browserOpen, setBrowserOpen] = useState(false);

  const enter = (theaterId: string) => {
    setActiveTheater(theaterId);
    // Arriving at a Theater means its Operations, not the alerts tab a previous visit left behind.
    setMobileTab("operations");
    navigate("/operations");
  };

  return (
    <section className="mobile-theater-page" aria-labelledby="mobile-theater-page-title">
      <header className="mobile-list-header">
        <h1 id="mobile-theater-page-title">{t("mobile.theaters.title")}</h1>
        <div className="mobile-list-actions">
          <span className="mobile-total-count">{state.theaters.length}</span>
        </div>
      </header>
      <div className="mobile-theater-rows">
        {state.theaters.length === 0 ? (
          <p className="mobile-operation-empty">{t("mobile.theaters.empty")}</p>
        ) : state.theaters.map((theater) => {
          const operations = state.operations.filter((operation) => operation.theaterId === theater.id);
          const awaiting = operations.filter((operation) => resolveOperationActivity(operation, state.operationRuntime) === "awaiting").length;
          const here = theater.id === state.activeTheaterId;
          return (
            <button
              type="button"
              className="mobile-theater-row"
              key={theater.id}
              aria-current={here ? "true" : undefined}
              onClick={() => enter(theater.id)}
            >
              <span className="mobile-theater-mark" aria-hidden="true">{theaterInitials(theater.label)}</span>
              <span className="mobile-theater-copy">
                <strong>{theater.label}</strong>
                <span className="mobile-theater-summary">
                  <span>{t(operations.length === 1 ? "mobile.theaters.opCount_one" : "mobile.theaters.opCount_other", { count: operations.length })}</span>
                  {awaiting > 0 ? <span className="mobile-theater-awaiting">{t("mobile.theaters.awaiting", { count: awaiting })}</span> : null}
                </span>
              </span>
              {here
                ? <span className="mobile-theater-here">{t("mobile.theaters.here")}</span>
                : <span className="mobile-operation-chevron" aria-hidden="true">›</span>}
            </button>
          );
        })}
        <button
          type="button"
          className="mobile-theater-add"
          onClick={() => setBrowserOpen(true)}
          disabled={state.addingTheater}
        >
          <span aria-hidden="true">+</span>
          {t("mobile.theaters.add")}
        </button>
        {state.theaterError !== null ? <p className="mobile-theater-error" role="alert">{state.theaterError}</p> : null}
      </div>
      <DirectoryBrowserModal
        open={browserOpen}
        onCancel={() => setBrowserOpen(false)}
        onConfirm={(path) => {
          setBrowserOpen(false);
          void registerTheaterFromPath(path);
        }}
      />
    </section>
  );
}

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { fetchTheaterSystemPrompt, type TheaterSystemPrompt } from "../../../../../features/settings/client/execution-settings.js";
import { openTheaterSystemPrompt, subscribeTheaterSystemPromptChange } from "../../../../../features/settings/client/theater-system-prompt-sheet.js";
import { useNavigate } from "react-router-dom";

import { DirectoryBrowserModal } from "../components/directory-browser-modal.js";
import { useT } from "../../i18n/index.js";
import { resolveOperationActivity } from "../../../../../features/execution/client/operation-activity.js";
import { theaterInitials } from "../../../../../features/workspace/client/sidebar/theater-initials.js";
import { TheaterMonogram } from "../../../../../features/workspace/client/sidebar/theater-monogram.js";
import { setActiveTheater } from "../../integration/store.js";
import { registerTheaterFromPath } from "../../../../../features/workspace/client/theater.js";
import type { ConsoleState } from "../../integration/types.js";
import { useClaimMobileBar } from "./mobile-bar-context.js";
import { setMobileDestination } from "./mobile-store.js";
import "../../styles/mobile.css";

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
  const [menuId, setMenuId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<TheaterSystemPrompt | null>(null);
  const [promptLoaded, setPromptLoaded] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuId) return;
    const controller = new AbortController();
    void fetchTheaterSystemPrompt(menuId, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setPrompt(value.prompt);
      setPromptLoaded(true);
    }).catch(() => undefined);
    const unsubscribe = subscribeTheaterSystemPromptChange((id, value) => { if (id === menuId) { setPrompt(value); setPromptLoaded(true); } });
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !openerRef.current?.contains(event.target)) setMenuId(null); };
    document.addEventListener("pointerdown", outside);
    window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
    return () => { controller.abort(); unsubscribe(); document.removeEventListener("pointerdown", outside); };
  }, [menuId]);
  const menuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); setMenuId(null); openerRef.current?.focus(); return; }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? []);
    if (!items.length) return;
    const index = items.findIndex((item) => item === document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (index + 1) % items.length : event.key === "ArrowUp" ? (index - 1 + items.length) % items.length : -1;
    if (next >= 0) { event.preventDefault(); items[next]?.focus(); }
  };

  const enter = (theaterId: string) => {
    setActiveTheater(theaterId);
    // Arriving at a Theater means its Operations (the last one opened), not whichever destination a previous visit left behind.
    setMobileDestination({ kind: "home" });
    navigate("/operations");
  };

  useClaimMobileBar({ variant: "centered", title: t("mobile.theaters.title"), leading: "menu" });

  return (
    <section className="mobile-theater-page" aria-labelledby="mobile-theater-page-title">
      <h1 id="mobile-theater-page-title" className="mobile-visually-hidden">{t("mobile.theaters.title")}</h1>
      <div className="mobile-theater-rows">
        {state.theaters.length === 0 ? (
          <p className="mobile-operation-empty">{t("mobile.theaters.empty")}</p>
        ) : state.theaters.map((theater) => {
          const operations = state.operations.filter((operation) => operation.theaterId === theater.id);
          const awaiting = operations.filter((operation) => resolveOperationActivity(operation, state.operationRuntime) === "awaiting").length;
          const here = theater.id === state.activeTheaterId;
          return (
            <div className="mobile-theater-card" key={theater.id}>
              <button type="button" className="mobile-theater-row" aria-current={here ? "true" : undefined} onClick={() => enter(theater.id)}>
                <span className="mobile-theater-mark" aria-hidden="true"><TheaterMonogram>{theaterInitials(theater.label)}</TheaterMonogram></span>
                <span className="mobile-theater-copy">
                  <strong>{theater.label}</strong>
                  <span className="mobile-theater-summary">
                    <span>{t(operations.length === 1 ? "mobile.theaters.opCount_one" : "mobile.theaters.opCount_other", { count: operations.length })}</span>
                    {awaiting > 0 ? <span className="mobile-theater-awaiting">{t("mobile.theaters.awaiting", { count: awaiting })}</span> : null}
                  </span>
                </span>
                {here ? <span className="mobile-theater-here">{t("mobile.theaters.here")}</span> : <span className="mobile-operation-chevron" aria-hidden="true">›</span>}
              </button>
              <button type="button" className="mobile-theater-more" ref={menuId === theater.id ? openerRef : undefined} aria-label={t("sidebar.theater.actionsMenuAria", { theater: theater.label })} aria-haspopup="menu" aria-expanded={menuId === theater.id} onClick={(event) => { openerRef.current = event.currentTarget; setPrompt(null); setPromptLoaded(false); setMenuId(menuId === theater.id ? null : theater.id); }}>···</button>
              {menuId === theater.id ? <div className="theater-menu mobile-theater-menu" role="menu" ref={menuRef} onKeyDown={menuKeyDown} aria-label={t("sidebar.theater.actionsMenuAria", { theater: theater.label })}>
                <button type="button" role="menuitem" className="theater-menu-item" onClick={() => { setMenuId(null); openTheaterSystemPrompt(theater, openerRef.current); }}>
                  <span className="theater-menu-label">{t("sidebar.theater.prompt.menu")}</span>
                  <span className="theater-prompt-menu-state">{promptLoaded ? (prompt ? t(`sidebar.theater.prompt.mode${prompt.mode === "on" ? "On" : prompt.mode === "append" ? "Append" : "Off"}`) : t("sidebar.theater.prompt.unset")) : null}</span>
                </button>
              </div> : null}
            </div>
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

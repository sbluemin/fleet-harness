import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import { shortcutCommandLabel, useShortcutOverrides } from "../../../../core/client/src/integration/shortcut-bindings.js";
import { requestCommodoreCreate } from "../commodore-create-modal.js";
import { requestTaskforceCreate } from "./taskforce.js";
import { taskforceT } from "./i18n.js";

export function TaskforceCreateMenu({ children }: { readonly children: ReactNode }) {
  const language = useConsoleLocale(); const t = taskforceT(language);
  useShortcutOverrides();
  const shortcut = shortcutCommandLabel("console.new-taskforce");
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const button = useRef<HTMLButtonElement>(null); const menu = useRef<HTMLDivElement>(null);
  const close = () => { setAnchor(null); button.current?.focus(); };
  useEffect(() => {
    if (!anchor) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = () => setAnchor(null);
    window.addEventListener("resize", dismiss); window.addEventListener("blur", dismiss);
    return () => { window.removeEventListener("resize", dismiss); window.removeEventListener("blur", dismiss); };
  }, [anchor]);
  return <><button ref={button} type="button" className="conversation-round" aria-label={t("taskforce.createMenu")} title={t("taskforce.createMenu")} aria-haspopup="menu" aria-expanded={anchor !== null} data-new-session-entry="sidebar" onClick={() => setAnchor(anchor ? null : button.current?.getBoundingClientRect() ?? null)}>{children}</button>
    {anchor ? createPortal(<div className="group-context-menu-overlay" data-native-browser-transparent role="presentation" onPointerDown={() => setAnchor(null)}><div ref={menu} className="theater-menu taskforce-create-menu" role="menu" aria-label={t("taskforce.createMenu")} style={{ position: "fixed", left: Math.max(8, Math.min(anchor.right - 220, window.innerWidth - 228)), top: Math.min(anchor.bottom + 6, window.innerHeight - 90), minWidth: 220 }} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
      const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]; const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); close(); }
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; items[next]?.focus(); }
    }}>
      <button type="button" role="menuitem" className="theater-menu-item" onClick={() => { close(); requestCommodoreCreate(); }}><span className="theater-menu-check" aria-hidden="true">✦</span><span className="theater-menu-label">{t("taskforce.newCommodore")}</span></button>
      <button type="button" role="menuitem" className="theater-menu-item" onClick={() => { close(); requestTaskforceCreate(); }}><span className="theater-menu-check" aria-hidden="true">⧉</span><span className="theater-menu-label">{t("taskforce.new")}</span>{shortcut ? <kbd className="taskforce-menu-shortcut">{shortcut}</kbd> : null}</button>
    </div></div>, document.body) : null}</>;
}

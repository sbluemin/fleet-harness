import { useLocation, useNavigate } from "react-router-dom";

import { useT } from "../i18n/index.js";
import { setMobileTab, useMobileTab, type MobileTab } from "./mobile-store.js";

type TabId = MobileTab | "settings";

const TABS: readonly TabId[] = ["operations", "alerts", "settings"];

export function MobileTabBar({ onSelect }: { readonly onSelect?: (tab: MobileTab) => void }) {
  const t = useT();
  const activeTab = useMobileTab();
  const navigate = useNavigate();
  const location = useLocation();
  const onSettings = location.pathname.replace(/\/+$/, "") === "/settings";
  return (
    <nav className="mobile-tab-bar" aria-label={t("mobile.tabs.aria")}>
      {TABS.map((tab) => {
        const active = tab === "settings" ? onSettings : !onSettings && activeTab === tab;
        return (
          <button
            key={tab}
            type="button"
            className={`mobile-tab ${active ? "is-active" : ""}`}
            aria-current={active ? "page" : undefined}
            onClick={() => {
              if (tab === "settings") {
                navigate("/settings");
                return;
              }
              setMobileTab(tab);
              // A tab is a destination, so an operations tab pressed from settings returns there.
              if (onSettings) navigate("/operations");
              onSelect?.(tab);
            }}
          >
            <MobileTabIcon tab={tab} />
            <span>{t(`mobile.tabs.${tab}`)}</span>
          </button>
        );
      })}
    </nav>
  );
}

function MobileTabIcon({ tab }: { readonly tab: TabId }) {
  if (tab === "operations") {
    return (
      <svg className="mobile-tab-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
        <path d="M7 5h9M7 10h9M7 15h9" />
        <path d="M4 5h.01M4 10h.01M4 15h.01" strokeWidth="2.5" />
      </svg>
    );
  }
  if (tab === "alerts") {
    return (
      <svg className="mobile-tab-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
        <path d="M5.5 8a4.5 4.5 0 0 1 9 0c0 5 2 5 2 6H3.5c0-1 2-1 2-6Z" />
        <path d="M8.5 16a1.75 1.75 0 0 0 3 0" />
      </svg>
    );
  }
  return (
    <svg className="mobile-tab-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M8.4 3.6h3.2l.35 1.9 1.6.92 1.8-.68 1.6 2.77-1.45 1.24v1.84l1.45 1.24-1.6 2.77-1.8-.68-1.6.92-.35 1.9H8.4l-.35-1.9-1.6-.92-1.8.68-1.6-2.77 1.45-1.24V10.4L3.05 9.16l1.6-2.77 1.8.68 1.6-.92Z" />
      <circle cx="10" cy="10" r="2.1" />
    </svg>
  );
}

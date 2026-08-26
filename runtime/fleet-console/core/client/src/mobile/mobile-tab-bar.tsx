import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { RailPanelDescriptor } from "@fleet-console/sdk/rail";

import { useConsoleLocale, useT } from "../i18n/index.js";
import { setMobileTab, useMobileTab, type MobileTab } from "./mobile-store.js";

type RouteTab = "theaters" | "settings";
type TabId = MobileTab | RouteTab;

// Theater leads because it contains the rest: a Theater holds Operations, and their alerts follow.
const TABS: readonly TabId[] = ["theaters", "operations", "alerts", "skills", "settings"];
const ROUTE_TABS: Readonly<Record<RouteTab, string>> = { theaters: "/theaters", settings: "/settings" };

export function MobileTabBar({ mobilePanels, onSelect }: {
  readonly mobilePanels: readonly RailPanelDescriptor[];
  readonly onSelect?: (tab: MobileTab) => void;
}) {
  const t = useT();
  const locale = useConsoleLocale();
  const skillsPanel = mobilePanels.find((panel) => panel.id === "skills");
  const skillsLabel = skillsPanel ? resolveLocalizedText(skillsPanel.title, locale) : "Skills";
  const tabs = skillsPanel ? TABS : TABS.filter((tab) => tab !== "skills");
  const activeTab = useMobileTab();
  const navigate = useNavigate();
  const location = useLocation();
  const path = location.pathname.replace(/\/+$/, "");
  const routeTab = (Object.keys(ROUTE_TABS) as readonly RouteTab[]).find((tab) => ROUTE_TABS[tab] === path) ?? null;

  useEffect(() => {
    if (!skillsPanel && activeTab === "skills") setMobileTab("operations");
  }, [activeTab, skillsPanel]);

  return (
    <nav className="mobile-tab-bar" aria-label={t("mobile.tabs.aria")}>
      {tabs.map((tab) => {
        const active = isRouteTab(tab) ? tab === routeTab : routeTab === null && activeTab === tab;
        return (
          <button
            key={tab}
            type="button"
            className={`mobile-tab ${active ? "is-active" : ""}`}
            aria-current={active ? "page" : undefined}
            onClick={() => {
              if (isRouteTab(tab)) {
                navigate(ROUTE_TABS[tab]);
                return;
              }
              setMobileTab(tab);
              // A tab is a destination, so an operations tab pressed from a route tab returns there.
              if (routeTab !== null) navigate("/operations");
              onSelect?.(tab);
            }}
          >
            {tab === "skills" && skillsPanel
              ? <span className="mobile-tab-icon">{typeof skillsPanel.icon === "function" ? skillsPanel.icon() : skillsPanel.icon}</span>
              : <MobileTabIcon tab={tab} />}
            <span>{tab === "skills" ? skillsLabel : t(`mobile.tabs.${tab}`)}</span>
          </button>
        );
      })}
    </nav>
  );
}

function isRouteTab(tab: TabId): tab is RouteTab {
  return tab === "theaters" || tab === "settings";
}

function MobileTabIcon({ tab }: { readonly tab: TabId }) {
  if (tab === "theaters") {
    return (
      <svg className="mobile-tab-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
        <rect x="3" y="4" width="6" height="12" rx="1.5" />
        <rect x="11" y="4" width="6" height="5" rx="1.5" />
        <rect x="11" y="11" width="6" height="5" rx="1.5" />
      </svg>
    );
  }
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
  if (tab === "skills") return null;
  return (
    <svg className="mobile-tab-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M8.4 3.6h3.2l.35 1.9 1.6.92 1.8-.68 1.6 2.77-1.45 1.24v1.84l1.45 1.24-1.6 2.77-1.8-.68-1.6.92-.35 1.9H8.4l-.35-1.9-1.6-.92-1.8.68-1.6-2.77 1.45-1.24V10.4L3.05 9.16l1.6-2.77 1.8.68 1.6-.92Z" />
      <circle cx="10" cy="10" r="2.1" />
    </svg>
  );
}

import { useT } from "../i18n/index.js";
import { setMobileTab, useMobileTab, type MobileTab } from "./mobile-store.js";

const TABS: readonly MobileTab[] = ["operations", "alerts", "tools"];

export function MobileTabBar({ onSelect }: { readonly onSelect?: (tab: MobileTab) => void }) {
  const t = useT();
  const activeTab = useMobileTab();
  return (
    <nav className="mobile-tab-bar" aria-label={t("mobile.tabs.aria")}>
      {TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          className={`mobile-tab ${activeTab === tab ? "is-active" : ""}`}
          aria-current={activeTab === tab ? "page" : undefined}
          onClick={() => {
            setMobileTab(tab);
            onSelect?.(tab);
          }}
        >
          <MobileTabIcon tab={tab} />
          <span>{t(`mobile.tabs.${tab}`)}</span>
        </button>
      ))}
    </nav>
  );
}

function MobileTabIcon({ tab }: { readonly tab: MobileTab }) {
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
      <rect x="3" y="3" width="5" height="5" rx="1" />
      <rect x="12" y="3" width="5" height="5" rx="1" />
      <rect x="3" y="12" width="5" height="5" rx="1" />
      <rect x="12" y="12" width="5" height="5" rx="1" />
    </svg>
  );
}

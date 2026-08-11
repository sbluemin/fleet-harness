import { useT } from "../i18n/index.js";
import { cycleViewModePreference, useViewMode } from "../view-mode-store.js";

/**
 * The one control that cycles auto / mobile / desktop. The command band carries it on a desktop
 * layout; the mobile layout carries it in its own header, because that layout hides the band.
 */
export function ViewModeToggle({ className }: { readonly className?: string }) {
  const t = useT();
  const viewMode = useViewMode();
  const label = t(viewMode.preference === "auto"
    ? "chrome.commandBand.viewModeAuto"
    : viewMode.preference === "mobile"
      ? "chrome.commandBand.viewModeMobile"
      : "chrome.commandBand.viewModeDesktop");
  return (
    <button
      type="button"
      className={className}
      onClick={cycleViewModePreference}
      aria-label={label}
      aria-pressed={viewMode.preference !== "auto"}
      title={label}
    >
      {viewMode.preference === "auto" ? <ViewModeAutoIcon /> : viewMode.preference === "mobile" ? <ViewModeMobileIcon /> : <ViewModeDesktopIcon />}
    </button>
  );
}

function ViewModeAutoIcon() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><rect x="1.5" y="2.5" width="10" height="7.5" rx="1.4" strokeWidth="1.2" /><path d="M4.5 12.5h4M6.5 10v2.5" strokeWidth="1.2" strokeLinecap="round" /><rect x="9.5" y="6.5" width="4.5" height="7" rx="1" strokeWidth="1.2" /></svg>;
}

function ViewModeMobileIcon() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><rect x="4.25" y="1.5" width="7.5" height="13" rx="1.6" strokeWidth="1.3" /><path d="M6.7 3.3h2.6M7.4 12.7h1.2" strokeWidth="1.2" strokeLinecap="round" /></svg>;
}

function ViewModeDesktopIcon() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><rect x="1.5" y="2.25" width="13" height="9" rx="1.5" strokeWidth="1.3" /><path d="M5 14h6M8 11.25V14" strokeWidth="1.3" strokeLinecap="round" /></svg>;
}

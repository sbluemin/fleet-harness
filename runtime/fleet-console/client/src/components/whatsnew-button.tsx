import { RELEASE_NOTES } from "../release-notes.generated.js";
import { openWhatsNew } from "../store.js";
import type { ConsoleState } from "../types.js";

interface WhatsNewButtonProps {
  readonly state: ConsoleState;
}

export function WhatsNewButton({ state }: WhatsNewButtonProps) {
  if (RELEASE_NOTES === null) return null;
  const versionLabel = RELEASE_NOTES.version === state.version && state.version ? ` v${RELEASE_NOTES.version}` : "";
  return (
    <button
      type="button"
      className="topbar-whatsnew-button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={openWhatsNew}
      aria-label={`What's new${versionLabel}`}
      title={`What's new${versionLabel}`}
    >
      <span>What's new</span>
    </button>
  );
}

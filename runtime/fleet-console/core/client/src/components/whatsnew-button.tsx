import { openWhatsNew } from "../store.js";
import type { ConsoleState } from "../types.js";

interface WhatsNewButtonProps {
  readonly state: ConsoleState;
}

export function WhatsNewButton({ state }: WhatsNewButtonProps) {
  if (state.releaseNotesLoading || state.releaseNotes.length === 0 || (state.releaseNotesError && !state.releaseNotesStale)) return null;
  const current = state.releaseNotes.find((note) => note.version === state.version);
  const versionLabel = current && state.version ? ` v${current.version}` : "";
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

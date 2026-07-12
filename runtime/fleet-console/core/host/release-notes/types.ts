export type ReleaseNoteProduct = "fleet-cli" | "fleet-console" | "fleet-desktop" | "fleet-plugin" | "fleet-core";

export interface ConsoleReleaseNoteItem {
  readonly packageTags: readonly string[];
  readonly text: string;
  readonly product?: ReleaseNoteProduct;
}

export interface ConsoleReleaseNoteSection {
  readonly heading: "Added" | "Changed" | "Fixed" | "Removed" | "Breaking Changes";
  readonly items: readonly ConsoleReleaseNoteItem[];
}

export interface ConsoleReleaseNotes {
  readonly version: string;
  readonly date: string | null;
  readonly sections: readonly ConsoleReleaseNoteSection[];
}

export interface LocalizedConsoleReleaseNotes extends ConsoleReleaseNotes {
  readonly localizationFallback: boolean;
}

export interface ConsoleReleaseNotesResponse {
  readonly notes: readonly LocalizedConsoleReleaseNotes[];
  readonly sourceRef: "main";
  readonly fetchedAt: number;
  readonly stale: boolean;
}

export type ReleaseNotesLocale = "en" | "ko";

export type ConsoleReleaseNotesUnavailableReason = "cold_unavailable" | "negative_cache";

export class ConsoleReleaseNotesUnavailableError extends Error {
  readonly reason: ConsoleReleaseNotesUnavailableReason;

  constructor(reason: ConsoleReleaseNotesUnavailableReason) {
    super("Console release notes are unavailable");
    this.name = "ConsoleReleaseNotesUnavailableError";
    this.reason = reason;
  }
}

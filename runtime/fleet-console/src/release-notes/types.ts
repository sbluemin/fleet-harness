export interface ConsoleReleaseNoteItem {
  readonly packageTags: readonly string[];
  readonly text: string;
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

export interface ConsoleReleaseNotesResponse {
  readonly notes: readonly ConsoleReleaseNotes[];
  readonly sourceRef: "main";
  readonly fetchedAt: number;
  readonly stale: boolean;
}

export type ConsoleReleaseNotesUnavailableReason = "cold_unavailable" | "negative_cache";

export class ConsoleReleaseNotesUnavailableError extends Error {
  readonly reason: ConsoleReleaseNotesUnavailableReason;

  constructor(reason: ConsoleReleaseNotesUnavailableReason) {
    super("Console release notes are unavailable");
    this.name = "ConsoleReleaseNotesUnavailableError";
    this.reason = reason;
  }
}

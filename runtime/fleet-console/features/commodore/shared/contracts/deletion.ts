import type { ConsoleCommodoreSummary } from "./theaters.js";

export interface CommodoreDeletePreview {
  readonly commodore: ConsoleCommodoreSummary;
  readonly confirmationAlias: string;
  readonly objectives: { readonly total: number; readonly active: number; readonly archived: number };
  readonly runningSessions: number;
  readonly activeTurn: boolean;
  readonly memoryEntries: number;
  readonly diskBytes: number;
  readonly diskBytesTruncated: boolean;
  readonly legacyWarning: boolean;
}

export interface CommodoreDeleteResult {
  readonly deleted: string;
  readonly removedObjectives: number;
  readonly warnings: readonly string[];
}

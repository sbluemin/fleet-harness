export const MEMORY_BRANCHES = ["person", "theater", "lessons", "crew"] as const;
export type MemoryBranch = (typeof MEMORY_BRANCHES)[number];

export interface MemorySource {
  readonly objectiveId: string;
  readonly title: string;
}

export interface MemoryEntry {
  readonly ref: string;
  readonly branch: MemoryBranch;
  readonly topic: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly why: string;
  readonly how: string;
  readonly sources: readonly MemorySource[];
  readonly links: readonly string[];
  readonly created: number;
  readonly updated: number;
  readonly verified: number;
}

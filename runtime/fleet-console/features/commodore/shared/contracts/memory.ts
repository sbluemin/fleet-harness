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

/**
 * fleet-memory 항목이 마지막 검증 뒤 이만큼 지나면 다시 확인할 때로 보인다 — 사령관 도구와 화면이 같은 값을 읽는다.
 * 브라우저 번들도 읽으므로 이 모듈은 아무것도 가져오지 않는다.
 */
export const MEMORY_STALE_MS = 30 * 24 * 60 * 60 * 1000;

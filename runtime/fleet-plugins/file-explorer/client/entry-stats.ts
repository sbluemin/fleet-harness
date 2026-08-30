import type { FolderEntry } from "../server/types.js";

/**
 * 목록이 알려 준 파일의 mtime과 크기 — Theater마다 따로 산다.
 *
 * 트리와 문서 창이 한 컴포넌트였을 때 이 캐시는 ref 두 개였다. 열이 갈라지면서 **알아내는
 * 쪽(트리의 폴더 목록)과 쓰는 쪽(문서 창의 낡음 표식·이미지 캐시버스터)이 달라졌으므로**,
 * 두 페인이 함께 보는 자리로 나왔다.
 *
 * Theater로 키를 나누는 것이 핵심이다. 경로 공간이 Theater마다 다르므로, 한 통에 담으면
 * A의 `foo.png` mtime이 B의 같은 이름 파일에 실려 바뀌지도 않은 문서를 낡음으로 표시한다.
 */

interface TheaterStats {
  readonly mtimes: Map<string, number>;
  readonly sizes: Map<string, number>;
}

const byTheater = new Map<string, TheaterStats>();

function statsFor(theaterId: string): TheaterStats {
  const existing = byTheater.get(theaterId);
  if (existing) return existing;
  const created: TheaterStats = { mtimes: new Map(), sizes: new Map() };
  byTheater.set(theaterId, created);
  return created;
}

export function noteEntryStats(
  theaterId: string | null,
  entries: readonly Pick<FolderEntry, "relativePath" | "mtimeMs" | "sizeBytes">[],
): void {
  if (!theaterId) return;
  const stats = statsFor(theaterId);
  for (const entry of entries) {
    if (entry.mtimeMs !== undefined) stats.mtimes.set(entry.relativePath, entry.mtimeMs);
    if (entry.sizeBytes !== undefined) stats.sizes.set(entry.relativePath, entry.sizeBytes);
  }
}

export function noteEntryMtime(theaterId: string | null, relativePath: string, mtimeMs: number): void {
  if (!theaterId) return;
  statsFor(theaterId).mtimes.set(relativePath, mtimeMs);
}

export function knownMtime(theaterId: string | null, relativePath: string): number | undefined {
  if (!theaterId) return undefined;
  return byTheater.get(theaterId)?.mtimes.get(relativePath);
}

export function knownSize(theaterId: string | null, relativePath: string): number | undefined {
  if (!theaterId) return undefined;
  return byTheater.get(theaterId)?.sizes.get(relativePath);
}

/** 테스트 전용 — 모듈 스코프 캐시를 비운다. */
export function __resetEntryStatsForTests(): void {
  byTheater.clear();
}

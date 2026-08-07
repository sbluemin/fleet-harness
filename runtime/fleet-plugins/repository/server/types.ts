// /file 엔드포인트에서 hunk 모드를 구분하는 타입. staged/workdir/commit 분기는 git diff HEAD 통합으로 제거.
export type DiffFileMode = "unified" | "untracked";

export interface DiffFileEntry {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: "M" | "A" | "D" | "R" | "T" | "U";
  readonly additions: number;
  readonly deletions: number;
}

export interface DiffListResult {
  readonly files: readonly DiffFileEntry[];
  readonly truncated?: boolean;
}

export interface DiffHunkResult {
  readonly content: string;
  readonly truncated?: boolean;
}

export interface RepoCandidate {
  readonly relPath: string;
  readonly name: string;
  readonly branch: string;
  readonly kind: "root" | "nested";
}

export interface ReposResult {
  readonly repos: readonly RepoCandidate[];
  readonly truncated?: boolean;
}

export interface WorktreeCandidate {
  readonly relPath: string;
  readonly name: string;
  readonly branch: string;
  readonly current: boolean;
}

export interface WorktreesResult {
  readonly worktrees: readonly WorktreeCandidate[];
}

/**
 * 커밋 목록의 정렬 축.
 * - `topo`: 브랜치 체인을 끊지 않고 연속 배치한다(`git log --topo-order`). 그래프 레인이 짧게 유지된다.
 * - `date`: 저장소 전체를 커밋 시각 역순으로 인터리브한다(`git log --date-order`).
 */
export type LogOrder = "topo" | "date";

export interface LogCommitEntry {
  readonly shortHash: string;
  readonly fullHash: string;
  readonly subject: string;
  readonly authorName: string;
  readonly relTime: string;
  readonly authorAt: number;
  readonly refs: readonly string[];
  readonly parents: readonly string[];
  /** 현재 체크아웃 HEAD에서 도달 가능한 커밋인지 — false면 UI가 dim 처리한다 */
  readonly onHead: boolean;
  /** 제목 뒤에 본문이 더 있는지 — 목록이 "열어 볼 값이 있는 커밋"을 표시하는 데만 쓴다(본문 자체는 싣지 않는다) */
  readonly hasBody: boolean;
}

export interface WorktreeCheckout {
  readonly sha: string;
  readonly branch: string | null;
  readonly isCurrent: boolean;
}

export interface LogResult {
  readonly commits: readonly LogCommitEntry[];
  readonly checkouts: readonly WorktreeCheckout[];
  readonly hasMore: boolean;
  readonly truncated?: boolean;
}

export interface RepositorySearchItem {
  readonly fullHash: string;
  readonly shortHash: string;
  readonly subject: string;
}

export interface RepositorySearchResult {
  readonly repoRel: string;
  readonly commits: readonly RepositorySearchItem[];
}

export interface CommitParent {
  readonly full: string;
  readonly short: string;
}

export interface CommitMeta {
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorAt: number;
  readonly subject: string;
  readonly body: string;
  readonly parents: readonly CommitParent[];
}

export interface CommitResult {
  readonly meta: CommitMeta;
  readonly files: readonly DiffFileEntry[];
  readonly truncated?: boolean;
}

export interface CompareResult {
  readonly files: readonly DiffFileEntry[];
  readonly mergeBase?: string;
  readonly truncated?: boolean;
}

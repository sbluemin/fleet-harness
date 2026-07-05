// /file 엔드포인트에서 hunk 모드를 구분하는 타입. staged/workdir/commit 분기는 git diff HEAD 통합으로 제거.
export type DiffFileMode = "unified" | "untracked";

export interface DiffFileEntry {
  readonly path: string;
  readonly status: "M" | "A" | "D" | "R" | "U";
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

export interface RepoEntry {
  readonly relPath: string;
  readonly name: string;
  readonly branch: string;
  /** 링크드 워크트리인 경우 true. 고아 워크트리(부모가 theater 밖)도 포함 */
  readonly isWorktree?: boolean;
  /** 부모 저장소의 relPath. 부모가 동일 theater 내에 있을 때만 설정됨 */
  readonly worktreeOf?: string;
}

export interface ReposDiscoveryResult {
  readonly repos: readonly RepoEntry[];
  readonly truncated?: boolean;
}

export interface LogCommitEntry {
  readonly shortHash: string;
  readonly fullHash: string;
  readonly subject: string;
  readonly authorName: string;
  readonly relTime: string;
  readonly refs: readonly string[];
  readonly parents: readonly string[];
  readonly additions: number;
  readonly deletions: number;
}

export interface LogResult {
  readonly commits: readonly LogCommitEntry[];
  readonly truncated?: boolean;
}

export interface CommitDiffResult {
  readonly content: string;
  readonly truncated?: boolean;
}

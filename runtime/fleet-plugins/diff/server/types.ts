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
}

export interface ReposDiscoveryResult {
  readonly repos: readonly RepoEntry[];
  readonly truncated?: boolean;
}

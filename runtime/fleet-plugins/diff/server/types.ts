export type DiffMode = "workdir" | "staged" | "commit" | "untracked";

export type DiffSection = "staged" | "workdir";

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

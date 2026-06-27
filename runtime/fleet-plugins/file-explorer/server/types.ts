export interface FolderEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly kind: "dir" | "file";
}

export interface FolderListResult {
  readonly relativePath: string;
  readonly parentRelativePath: string | null;
  readonly entries: readonly FolderEntry[];
  readonly truncated?: true;
}

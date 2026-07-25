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

export interface FileReadResult {
  readonly relativePath: string;
  readonly content: string;
  readonly lang: string;
  readonly truncated?: boolean;
  readonly binary?: boolean;
}

export interface FileSearchItem {
  readonly relativePath: string;
}

export interface FileSearchResult {
  readonly files: readonly FileSearchItem[];
}

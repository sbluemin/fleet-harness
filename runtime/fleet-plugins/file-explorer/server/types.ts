export interface FolderEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly kind: "dir" | "file";
}

export interface FolderListResult {
  readonly relativePath: string;
  readonly parentRelativePath: string | null;
  readonly entries: readonly FolderEntry[];
  /** 목록이 DIRECTORY_ENTRY_CAP에서 잘린 경우에만 존재 — cap에는 상한 값이 들어 있다. */
  readonly truncated?: true;
  readonly cap?: number;
  /** 이 수준에서 목록에서 제외된 VCS 날것 이름(.git 등) — 클라이언트가 명명된 muted 행으로 표시한다. */
  readonly hiddenVcsInternals?: readonly string[];
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
  /** limit로 자르기 전의 전체 매치 수 */
  readonly totalMatches: number;
  /** 탐색 상한(디렉터리/엔트리 캡)에 걸려 전체를 탐색하지 못한 경우에만 존재 */
  readonly walkCapped?: true;
}

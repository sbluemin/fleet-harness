export interface FolderEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly kind: "dir" | "file";
  /** 파일 크기(바이트). stat 실패 시 생략 — 정렬은 생략 항목을 이름순 꼬리로 보낸다. */
  readonly sizeBytes?: number;
  /** 수정 시각(epoch ms). stat 실패 시 생략. */
  readonly mtimeMs?: number;
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
  /** 디스크상 전체 크기(바이트) — truncated여도 전체 크기를 담는다. */
  readonly sizeBytes?: number;
  /** 파일 mtime (epoch ms) — 같은 stat에서 채운다. */
  readonly mtimeMs: number;
  /** maxLines로 잘라 읽은 경우, 잘라내기 전 불러온 본문의 줄 수. */
  readonly lineCount?: number;
}

export interface Utf16Span {
  /** JavaScript 문자열 기준 UTF-16 code-unit 오프셋. */
  readonly start: number;
  /** Half-open 끝 오프셋. */
  readonly end: number;
}

export interface FileSearchPreview {
  /** 1부터 시작하는 파일 줄 번호. */
  readonly lineNumber: number;
  readonly text: string;
  /** preview.text 기준 UTF-16 half-open 범위. */
  readonly ranges: readonly Utf16Span[];
}

export interface FileSearchItem {
  readonly relativePath: string;
  readonly kind: "file" | "dir";
  readonly source?: "path" | "content";
  readonly score?: number;
  /** relativePath 기준 UTF-16 half-open 범위. */
  readonly pathRanges?: readonly Utf16Span[];
  readonly preview?: FileSearchPreview;
}

export interface FileSearchResult {
  readonly files: readonly FileSearchItem[];
  /** complete=true일 때만 limit로 자르기 전의 정확한 전체 매치 수다. */
  readonly totalMatches: number;
  /** false면 top-K를 먼저 반환했으며 totalMatches는 현재까지 확인한 수다. */
  readonly complete?: boolean;
  readonly elapsedMs?: number;
  readonly engine?: "ripgrep" | "walker";
  readonly degraded?: "walker";
  /** 탐색 상한(디렉터리/엔트리 캡)에 걸려 전체를 탐색하지 못한 경우에만 존재 */
  readonly walkCapped?: true;
  /** ignore 규칙 때문에 검색하지 않은 경로가 있을 수 있으면 true. */
  readonly ignoredSkipped: boolean;
}

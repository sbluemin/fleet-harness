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
  /** VCS 날것을 뺀 디렉터리 엔트리 수(상한으로 생략된 항목 포함). */
  readonly totalEntries?: number;
  /** 이 수준에서 목록에서 제외된 VCS 날것 이름(.git 등) — 클라이언트가 명명된 muted 행으로 표시한다. */
  readonly hiddenVcsInternals?: readonly string[];
}

export const FILE_READ_BYTE_CAP = 1024 * 1024;

export interface FileReadWindow {
  readonly mode: "head" | "tail" | "range";
  readonly startByte: number;
  /** 읽은 바이트 구간의 끝(미포함). */
  readonly endByte: number;
}

export interface FileReadRequest {
  readonly mode: "head" | "tail" | "range";
  readonly offset?: number;
}

export interface FileDiskStatus {
  readonly relativePath: string;
  readonly state: "present" | "deleted" | "unavailable";
  readonly mtimeMs?: number;
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
  readonly window?: FileReadWindow;
  /** 현재 존재를 보장하지 않는, Codex로 이주한 옛 사본의 역사 좌표. */
  readonly migratedWikiEntryId?: string;
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
  readonly exact?: boolean;
  readonly location?: { readonly line?: number; readonly column?: number; readonly anchor?: string };
}

export interface FileSearchResult {
  readonly files: readonly FileSearchItem[];
  /** complete=true일 때 검색 범위 안에서 limit로 자르기 전의 정확한 매치 수다. */
  readonly totalMatches: number;
  /** 상한이나 접근 오류로 검색 범위를 끝까지 확인하지 못하면 false다. ignore 제외는 별도 안내한다. */
  readonly complete?: boolean;
  readonly elapsedMs?: number;
  readonly engine?: "ripgrep" | "walker";
  readonly degraded?: "walker";
  /** 파일시스템 오류로 건너뛴 경로 수 — 호스트 경로는 노출하지 않는다. */
  readonly skippedPaths?: number;
  /** 결과가 limit에서 잘렸을 때만 존재 — complete=false의 원인이 접근 오류뿐인지 구분한다. */
  readonly truncated?: true;
  /** 탐색 상한(디렉터리/엔트리 캡)에 걸려 전체를 탐색하지 못한 경우에만 존재 */
  readonly walkCapped?: true;
  /** ignore 규칙 때문에 검색하지 않은 경로가 있을 수 있으면 true. */
  readonly ignoredSkipped: boolean;
}

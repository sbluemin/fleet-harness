/**
 * 목표 shared/ 폴더의 읽기 전용 보기 — 지휘관·구성원이 함께 쓰는 증거 디렉터리를 사람이 라이브러리 탭에서 본다.
 * 호스트(목록·파일 경로)와 클라이언트(공유 폴더 섹션)가 같은 모양을 쓴다. 쓰기 경로는 없다.
 */

/** image: PNG·JPEG·WebP·GIF 머리 판정, text: 엄격한 UTF-8·NUL 없음·textBytes 이하, file: 그 외(내려받기만). */
export type SharedFolderKind = "image" | "text" | "file";

export interface SharedFolderEntry {
  /** shared/ 기준 상대 경로, 구분자는 "/". */
  readonly path: string;
  readonly bytes: number;
  /** 마지막 수정 시각(ms). 목록은 이 값의 내림차순이다. */
  readonly modifiedAt: number;
  readonly kind: SharedFolderKind;
}

export interface SharedFolderList {
  readonly entries: readonly SharedFolderEntry[];
  /** 개수·깊이 한도에 걸려 일부를 뺐으면 true. */
  readonly truncated: boolean;
}

export const SHARED_FOLDER_LIMITS = { entries: 500, depth: 8, textBytes: 1024 * 1024 } as const;

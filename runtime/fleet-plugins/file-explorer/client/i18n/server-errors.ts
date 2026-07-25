import type { Translate } from "@fleet-console/sdk/i18n";

import type { FileExplorerMessageKey } from "./messages.js";

const SERVER_ERROR_KEYS = {
  "Method not allowed": "fileExplorer.error.methodNotAllowed",
  unauthorized: "fileExplorer.error.unauthorized",
  invalid_request: "fileExplorer.error.invalidRequest",
  invalid_path: "fileExplorer.error.invalidPath",
  theater_not_found: "fileExplorer.error.theaterNotFound",
  forbidden: "fileExplorer.error.forbidden",
  not_found: "fileExplorer.error.notFound",
  path_outside_theater: "fileExplorer.error.pathOutsideTheater",
  not_a_file: "fileExplorer.error.notAFile",
  mime_not_allowed: "fileExplorer.error.mimeNotAllowed",
  size_exceeded: "fileExplorer.error.sizeExceeded",
  search_failed: "fileExplorer.error.searchFailed",
  list_failed: "fileExplorer.error.listFailed",
  read_failed: "fileExplorer.error.readFailed",
  no_theater: "fileExplorer.error.noTheater",
  "Unable to load file": "fileExplorer.status.unableToLoadFile",
  "Unable to load folder": "fileExplorer.error.unableToLoadFolder",
} as const satisfies Record<string, FileExplorerMessageKey>;

/** 서버/클라이언트 오류 코드를 카탈로그 문구로 변환한다. 미등록 값은 그대로 반환한다. */
export function translateServerError(raw: string, t: Translate<FileExplorerMessageKey>): string {
  const key = SERVER_ERROR_KEYS[raw as keyof typeof SERVER_ERROR_KEYS];
  return key === undefined ? raw : t(key);
}

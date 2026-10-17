import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import type { FileDiskStatus, FileReadRequest, FileReadResult } from "../server/types.js";
import { knownMtime, knownSize, noteEntryMtime, noteEntryStats } from "./entry-stats.js";
import { getT, translateServerError } from "./i18n/index.js";
import { makeFilesClient } from "./files-client.js";
import { beginDocumentLoad, getFileExplorerSnapshot, isCurrentDocumentLoad, markDocStale, setDocViewState } from "./view-store.js";
import { cacheBustedImageSrc } from "./viewer/image.js";
import { parentDirOf } from "./viewer/stale.js";

/**
 * 문서 하나를 읽어 스토어에 앉힌다.
 *
 * 컴포넌트 밖에 두는 이유는 부르는 자리가 둘이기 때문이다 — 본문은 활성 문서가 바뀔 때,
 * 캡션의 "다시 읽기"는 낡음 표식을 눌렀을 때. 둘을 잇겠다고 콜백을 모듈에 걸어 두면 캡션이
 * 본문의 렌더에 묶여, 계약이 갈라 둔 두 층이 다시 붙는다.
 */

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export function nameOfPath(relativePath: string): string {
  return relativePath.split("/").filter(Boolean).at(-1) ?? relativePath;
}

export async function refreshDocumentDiskStatus(theaterId: string, paths: readonly string[], signal?: AbortSignal): Promise<void> {
  if (paths.length === 0) return;
  const before = getFileExplorerSnapshot(theaterId).docStates;
  const response = await fetch("/plugins/file-explorer/files/disk-status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId, paths }), ...(signal ? { signal } : {}) });
  if (!response.ok || signal?.aborted) return;
  const result = await response.json() as { statuses: FileDiskStatus[] };
  if (signal?.aborted) return;
  for (const status of result.statuses) {
    const previous = before.get(status.relativePath);
    const current = getFileExplorerSnapshot(theaterId).docStates.get(status.relativePath);
    if ((previous?.kind !== "code" && previous?.kind !== "image") || (current?.kind !== "code" && current?.kind !== "image") || previous.mtimeMs !== current.mtimeMs) continue;
    if (status.state === "deleted") markDocStale(theaterId, status.relativePath, true, "deleted");
    else if (status.state === "present" && current.mtimeMs !== undefined) markDocStale(theaterId, status.relativePath, current.mtimeMs !== status.mtimeMs);
  }
}

export async function refreshLegacyWikiMetadata(theaterId: string, relativePath: string, signal?: AbortSignal): Promise<void> {
  const before = getFileExplorerSnapshot(theaterId).docStates.get(relativePath);
  if (before?.kind !== "code" || !relativePath.startsWith(".fleet/knowledge/wiki/")) return;
  const response = await fetch("/plugins/file-explorer/files/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId, relativePath, maxLines: 1 }), ...(signal ? { signal } : {}) });
  if (!response.ok || signal?.aborted) return;
  const result = await response.json() as FileReadResult;
  const current = getFileExplorerSnapshot(theaterId).docStates.get(relativePath);
  if (signal?.aborted || current !== before) return;
  // 본문을 덮지 않고 이주 표식만 갱신한다. 동시에 바뀐 본문은 디스크 배너가 따로 알린다.
  setDocViewState(theaterId, relativePath, { ...current, migratedWikiEntryId: result.migratedWikiEntryId });
}

export interface LoadDocumentOptions {
  /** 캐시가 이미 그려져 있어 로딩 화면 없이 배경에서 재검증하는가. */
  readonly silent: boolean;
  readonly language?: ConsoleLocale;
  readonly signal?: AbortSignal;
  readonly window?: FileReadRequest;
}

export async function loadDocument(
  theaterId: string | null,
  relativePath: string,
  { silent, language, signal, window: requestedWindow }: LoadDocumentOptions,
): Promise<void> {
  if (!theaterId) return;
  const t = getT(language);
  const name = nameOfPath(relativePath);
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  const request = beginDocumentLoad(theaterId, relativePath);
  const current = () => !signal?.aborted && isCurrentDocumentLoad(theaterId, relativePath, request);
  const snapshot = getFileExplorerSnapshot(theaterId);
  const cached = snapshot.docStates.get(relativePath);
  const hasLineTarget = snapshot.revealTarget?.relativePath === relativePath && snapshot.revealTarget.lineNumber !== undefined;
  const readWindow: FileReadRequest = requestedWindow ?? (hasLineTarget ? { mode: "head" } : cached?.kind === "code" && cached.window
    ? { mode: cached.window.mode, ...(cached.window.mode === "range" ? { offset: cached.window.startByte } : {}) }
    : { mode: !hasLineTarget && [".log", ".out", ".err"].includes(ext) ? "tail" : "head" });

  if (IMAGE_EXTS.has(ext)) {
    // 부모 폴더를 한 번도 나열한 적이 없으면(검색·세션 복원으로 연 경우) 기준 mtime이 없다.
    // 그 상태로 두면 첫 목록이 "이미 바뀐 뒤"의 값일 수 있어 그 변경을 영영 놓친다 — 지금 확보한다.
    if (knownMtime(theaterId, relativePath) === undefined) {
      try {
        const listing = await makeFilesClient(theaterId).listFolder(parentDirOf(relativePath));
        noteEntryStats(theaterId, listing.entries);
      } catch { /* 목록 실패는 표식 없이 여는 것으로 감수한다 — 다음 목록에서 회복된다 */ }
      if (!current()) return;
    }
    const mtimeMs = knownMtime(theaterId, relativePath);
    const sizeBytes = knownSize(theaterId, relativePath);
    const src = cacheBustedImageSrc(
      `/plugins/file-explorer/files/image?theaterId=${encodeURIComponent(theaterId)}&path=${encodeURIComponent(relativePath)}`,
      mtimeMs,
    );
    setDocViewState(theaterId, relativePath, { kind: "image", relativePath, name, src, mtimeMs, sizeBytes, stale: false });
    return;
  }

  if (!silent) setDocViewState(theaterId, relativePath, { kind: "loading" });
  try {
    // files/read는 422(binary_file)를 error 바디로 반환하므로 raw fetch로 직접 처리한다.
    const res = await fetch("/plugins/file-explorer/files/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId, relativePath, window: readWindow }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const payload = await res.json() as { error?: string };
      throw new Error(payload.error ?? "read_failed");
    }
    const result = await res.json() as FileReadResult;
    if (!current()) return;
    if (result.binary) {
      setDocViewState(theaterId, relativePath, { kind: "binary", name });
      return;
    }
    noteEntryMtime(theaterId, relativePath, result.mtimeMs);
    setDocViewState(theaterId, relativePath, {
      kind: "code",
      relativePath: result.relativePath,
      content: result.content,
      lang: result.lang,
      truncated: result.truncated,
      window: result.window,
      migratedWikiEntryId: result.migratedWikiEntryId,
      sizeBytes: result.sizeBytes,
      mtimeMs: result.mtimeMs,
      stale: false,
    });
  } catch (e: unknown) {
    // 페인이 헐리거나 Theater가 바뀌어 중단된 요청은 실패가 아니다 — 화면에 에러를 남기면
    // 다음에 열 때까지 그 자리가 고장난 것으로 보인다.
    if (!current()) return;
    const raw = e instanceof Error ? e.message : "Unable to load file";
    if (raw === "binary_file") {
      setDocViewState(theaterId, relativePath, { kind: "binary", name });
    } else {
      setDocViewState(theaterId, relativePath, { kind: "error", message: translateServerError(raw, t) });
    }
  }
}

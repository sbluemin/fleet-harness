// Theater registration and forgetting.

import {
  addTheater,
  fetchGroups,
  fetchOperations,
  fetchTheaters,
  forgetTheater,
  issueTheaterFolderGrant,
  type DeferredDeletionReceipt,
} from "./api.js";
import { isTriageActive, resetTriageTheater, visitTriageTheater } from "./canvas/triage-store.js";
import {
  beginAddTheater,
  completeAddTheater,
  failAddTheater,
  getState,
  hydrateGroups,
  hydrateOperations,
  hydrateTheaters,
  removeTheater,
} from "./store.js";
import type { OperationNode } from "./types.js";
import type { OperationLaunchKind } from "@fleet-console/sdk/operations";

// ─── register and forget ───────────────────────────────────────────────────────

// Theater 등록의 단일 경로: 폴더 grant 발급 → host POST → 서버 순서로 재수화.
// Operations 사이드바와 모바일 Theater 페이지가 공유한다.
export async function registerTheaterFromPath(path: string): Promise<void> {
  beginAddTheater();
  try {
    const folderGrantId = await issueTheaterFolderGrant(path);
    const result = await addTheater(folderGrantId);
    completeAddTheater(result);
    // 서버 register()는 기존 order를 보존하므로, 이미 수동 정렬된 Theater를 재-오픈하면
    // completeAddTheater의 낙관적 prepend가 저장된 위치와 어긋난다(Codex P2). 서버 순서로 재수화해
    // "열어도 위치 고정" 계약을 지킨다. hydrate는 방금 활성화한 result.id 선택을 유지한다.
    void fetchTheaters(null).then(hydrateTheaters).catch(() => {});
  } catch (error) {
    failAddTheater(error instanceof Error ? error.message : String(error));
  }
}

// Theater 잊기의 단일 경로: host DELETE → 로컬 Theater/triage 정리 → 소속 컬렉션 재수화.
// Operations 사이드바와 팔레트 명령이 공유하며, receipt는 App의 8초 undo 큐로 전달한다.
export async function forgetTheaterCompletely(
  theaterId: string,
): Promise<DeferredDeletionReceipt | null> {
  try {
    const response = await forgetTheater(theaterId);
    resetTriageTheater(theaterId);
    removeTheater(theaterId);
    // 활성 Theater를 잊으면 removeTheater가 폴백 Theater를 즉시 선택한다 — 선별 중이면
    // loadForTheater가 폴백의 저장 focus layer/Formation을 복원하기 전에 방문 정리를 적용한다.
    if (isTriageActive()) {
      const fallbackTheaterId = getState().activeTheaterId;
      if (fallbackTheaterId !== null) visitTriageTheater(fallbackTheaterId);
    }
    // 재수화 실패는 삼킨다 — 서버 forget이 이미 성공했으므로 receipt(undo 경로)는 보존해야 한다.
    await Promise.all([
      fetchOperations(null).then(hydrateOperations),
      fetchGroups(null).then(hydrateGroups),
    ]).catch(() => {});
    return response.deletion;
  } catch (error) {
    failAddTheater(error instanceof Error ? error.message : String(error));
    return null;
  }
}

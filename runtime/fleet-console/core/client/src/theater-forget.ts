import {
  fetchGroups,
  fetchOperations,
  forgetTheater,
  type DeferredDeletionReceipt,
} from "./api.js";
import { resetTriageTheater } from "./canvas/triage-store.js";
import {
  failAddTheater,
  hydrateGroups,
  hydrateOperations,
  removeTheater,
} from "./store.js";

// Theater 잊기의 단일 경로: host DELETE → 로컬 Theater/triage 정리 → 소속 컬렉션 재수화.
// Operations 사이드바와 팔레트 명령이 공유하며, receipt는 App의 8초 undo 큐로 전달한다.
export async function forgetTheaterCompletely(
  theaterId: string,
): Promise<DeferredDeletionReceipt | null> {
  try {
    const response = await forgetTheater(theaterId);
    resetTriageTheater(theaterId);
    removeTheater(theaterId);
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

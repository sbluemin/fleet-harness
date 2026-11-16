// Objective lifecycle actions issued from chrome: archive a card, or focus a resumed one.

import { ApiError, archiveObjective } from "../../../../features/execution/client/objective-records.js";
import { type ObjectiveArchiveReceipt } from "../../../../features/objectives/shared/records/archive.js";
import type { ClientFeatureDescriptor } from "../../../../features/workspace/shared/feature-surfaces.js";
import type { ObjectiveRecord } from "./types.js";
import { fetchObjectiveRecords } from "./api.js";
import { getState, hydrateObjectiveRecords, setActiveObjective } from "./store.js";

// ─── archive ───────────────────────────────────────────────────────────────────

export type ArchiveOutcome =
  | { readonly ok: true; readonly receipt: ObjectiveArchiveReceipt }
  | { readonly ok: false; readonly error: string };

// 같은 Objective을 두 입구가 동시에 보관하려 할 때(두 번 누름, 캡션과 ⌘K) 요청을 하나로 모은다.
const archivingObjectiveIds = new Set<string>();

/** 보관 요청이 날아가는 중인가 — 그 사이 도착한 늦은 동작(예: 재개 뒤의 포커스)이 사라질 패널을 다시 세우지 않게 한다. */
export function isArchivingObjective(objectiveId: string): boolean {
  return archivingObjectiveIds.has(objectiveId);
}

// 사람이 Objective을 치우는 단일 경로: Core 보관 → 화면 정리 → 재수화.
// 캔버스 캡션·사이드바 칩·우클릭 메뉴·트리아지·모바일·플러그인 본문의 onClose와 ⌘K가 이 함수를 공유한다.
// plugin.closeObjective은 부르지 않는다 — 그 훅은 세션과 첨부를 지우는 파괴적 정리였고, 보관의 실행 종료는
// 서버가 비파괴로 맡는다. 보관은 하위 Objective까지 함께 치우므로 receipt의 objectiveIds가 토스트의 개수다.
// 이미 진행 중인 같은 요청은 null을 돌려준다(호출자는 아무것도 하지 않는다).
export async function archiveObjectiveFromUi(objectiveId: string): Promise<ArchiveOutcome | null> {
  if (archivingObjectiveIds.has(objectiveId)) return null;
  archivingObjectiveIds.add(objectiveId);
  let outcome: ArchiveOutcome;
  try {
    outcome = { ok: true, receipt: await archiveObjective(objectiveId) };
  } catch (error) {
    outcome = { ok: false, error: error instanceof ApiError ? error.message : "archive_failed" };
  } finally {
    archivingObjectiveIds.delete(objectiveId);
  }
  if (getState().activeObjectiveId !== null && outcome.ok && outcome.receipt.objectiveIds.includes(getState().activeObjectiveId!)) setActiveObjective(null);
  await fetchObjectiveRecords(null).then(hydrateObjectiveRecords).catch(() => {});
  return outcome;
}

// ─── resume ────────────────────────────────────────────────────────────────────



// Objective lifecycle actions issued from chrome: archive a card, or resume a dormant
// one in place.

import { ApiError, archiveObjective } from "../../../../features/execution/client/objective-records.js";
import { readObjectiveLaunch, wasObjectiveBornDormant } from "../../../../features/objectives/shared/records/types.js";
import { type ObjectiveArchiveReceipt } from "../../../../features/objectives/shared/records/archive.js";
import type { ClientFeatureDescriptor } from "../../../../features/workspace/shared/feature-surfaces.js";
import type { ObjectiveRecord } from "./types.js";
import { fetchObjectiveRecords } from "./api.js";
import { resolveObjectiveActivity } from "../../../../features/execution/client/objective-activity.js";
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

// Objective 재개의 단일 경로: plugin resume 훅 → 미제공 시 호출 표면의 focus 폴백.
// 팔레트 resume 명령과 Objective을 여는 경로가 이 함수를 공유한다.
// plugin 실패는 자체 알림이 담당하므로 focus 폴백을 실행하지 않는다.
//
// 권위 스냅샷이 아직 도착하지 않은 구간(hydration "pending")에서는 아무것도 하지 않는다. 그 구간의
// 종료 표시는 보수적 폭백이지 관측된 사실이 아니므로, 그 위에서 재개를 시작하면 사용자는 자기가
// 무엇을 눌렀는지 모른 채 세션을 되살리게 된다. 축이 자리잡으면 같은 클릭이 정상 동작한다.
export function resumeObjectiveInPlace(
  objectiveId: string,
  objectiveRecords: readonly ObjectiveRecord[],
  plugins: readonly ClientFeatureDescriptor[],
  focusFallback: (objectiveId: string) => void,
): void {
  if (getState().objectiveRecordRuntimeHydration === "pending") return;
  const objectiveRecord = objectiveRecords.find((candidate) => candidate.id === objectiveId);
  if (objectiveRecord?.chatMode === true) { focusFallback(objectiveId); return; }
  const plugin = objectiveRecord ? plugins.find((candidate) => candidate.id === "terminal") : undefined;
  if (plugin?.resumeObjective) {
    void Promise.resolve(plugin.resumeObjective(objectiveId))
      .then(() => fetchObjectiveRecords(null).then(hydrateObjectiveRecords))
      .catch(() => { /* 실패 알림은 plugin이 emit */ });
  } else {
    focusFallback(objectiveId);
  }
}

// Objective을 여는 제스처는 그 자체로 "이 Objective을 다시 쓰겠다"는 뜻이다.
// 연 Objective이 휴면이면 Resume를 한 번 더 누르게 하지 않고 여는 동작이 재개까지 데려간다.
// 다만 휴면으로 태어나 첫 턴 전인 지휘관은 구상·시작 전까지 열기만으로 깨우지 않는다.
// 프레임의 명시적인 Resume는 resumeObjectiveInPlace를 직접 사용하므로 그대로 동작한다.
// 재개 훅이 없는 plugin에서는 아무 일도 하지 않는다: 여는 동작이 이미 패널을 그 자리에 세웠으므로
// resumeObjectiveInPlace의 focus 폭백은 여기서 할 일이 없다.
export function resumeDormantOnOpen(
  objectiveId: string,
  objectiveRecords: readonly ObjectiveRecord[],
  plugins: readonly ClientFeatureDescriptor[],
): void {
  const objectiveRecord = objectiveRecords.find((candidate) => candidate.id === objectiveId);
  if (!objectiveRecord) return;
  if (wasObjectiveBornDormant(objectiveRecord) && !readObjectiveLaunch(objectiveRecord).started) return;
  if (resolveObjectiveActivity(objectiveRecord, getState().objectiveRecordRuntime) !== "ended") return;
  resumeObjectiveInPlace(objectiveId, objectiveRecords, plugins, () => {});
}

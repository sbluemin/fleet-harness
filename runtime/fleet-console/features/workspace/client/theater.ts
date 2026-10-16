// Theater registration and forgetting.

import {
  addTheater,
  createGroup,
  fetchGroups,
  fetchOperations,
  fetchTheaters,
  forgetTheater,
  issueTheaterFolderGrant,
  patchTheaterAlias,
  type DeferredDeletionReceipt,
} from "../../../core/client/src/integration/api.js";
import {
  beginAddTheater,
  completeAddTheater,
  failAddTheater,
  getState,
  hydrateGroups,
  hydrateOperations,
  hydrateTheaters,
  removeTheater,
} from "../../../core/client/src/integration/store.js";
import type { OperationNode } from "../../../core/client/src/integration/types.js";
import { describeTheaterRegistrationError } from "../../../core/client/src/integration/failure-notices.js";
import { getT } from "../../../core/client/src/i18n/index.js";
import { getGlobalSettingsStoreState } from "../../settings/client/global-settings-store.js";
import { resolveConsoleLanguage } from "../../updates/client/whatsnew-i18n.js";
import type { OperationLaunchKind } from "@fleet-console/sdk/operations";

// ─── register and forget ───────────────────────────────────────────────────────

// Theater 등록의 단일 경로: 폴더 grant 발급 → host POST → 서버 순서로 재수화.
// Operations 사이드바·새 세션 화면·모바일 Theater 페이지가 공유한다. 등록한 Theater 의 id 를 돌려준다(실패면 null —
// 사유는 failAddTheater 가 이미 사이드바에 실었다).
export async function registerTheaterFromPath(path: string): Promise<string | null> {
  beginAddTheater();
  try {
    const folderGrantId = await issueTheaterFolderGrant(path);
    const result = await addTheater(folderGrantId, true);
    completeAddTheater(result);
    // 서버 register()는 기존 order를 보존하므로, 이미 수동 정렬된 Theater를 재-오픈하면
    // completeAddTheater의 낙관적 prepend가 저장된 위치와 어긋난다(Codex P2). 서버 순서로 재수화해
    // "열어도 위치 고정" 계약을 지킨다. hydrate는 방금 활성화한 result.id 선택을 유지한다.
    void fetchTheaters(null).then(hydrateTheaters).catch(() => {});
    return result.id;
  } catch (error) {
    const t = getT(resolveConsoleLanguage(getGlobalSettingsStoreState().state?.language ?? "auto"));
    failAddTheater(describeTheaterRegistrationError(error, t));
    return null;
  }
}

// Theater 잊기의 단일 경로: host DELETE → 로컬 Theater 정리 → 소속 컬렉션 재수화.
// Operations 사이드바와 팔레트 명령이 공유하며, receipt는 App의 8초 undo 큐로 전달한다.
export async function forgetTheaterCompletely(
  theaterId: string,
): Promise<DeferredDeletionReceipt | null> {
  try {
    const response = await forgetTheater(theaterId);
    dropForgottenTheater(theaterId);
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

// 이 창의 목록에서 잊힌 Theater를 뺀다. 누른 창과 SSE로 소식을 들은 다른 창이 같은 정리를 거치며,
// 서버 응답보다 사건이 먼저 와도 두 번째 호출은 아무것도 하지 않는다.
function dropForgottenTheater(theaterId: string): void {
  if (!getState().theaters.some((theater) => theater.id === theaterId)) return;
  removeTheater(theaterId);
}

// ─── alias and groups ──────────────────────────────────────────────────────────

/** 별칭 길이 상한 — 서버 검증과 같은 코드포인트 수다(UTF-16 단위인 maxLength 로는 이모지 별칭이 절반에서 막힌다). */
export const THEATER_ALIAS_MAX_CODEPOINTS = 40;
export function clampTheaterAlias(value: string): string {
  const points = [...value];
  return points.length > THEATER_ALIAS_MAX_CODEPOINTS ? points.slice(0, THEATER_ALIAS_MAX_CODEPOINTS).join("") : value;
}

// 폰 Theater 동작 시트의 별칭·새 그룹. 데스크톱 사이드바는 다시 시도 띠를 가진 자기 mutation 경로를 쓰고, 폰은 시트가 실패를 받는다.
// 요청이 성공한 뒤의 재수화 실패는 삼킨다 — 시트가 다시 저장하게 두면 그룹이 두 번 만들어진다. 서버 사건도 곧 다시 맞춘다.
export async function saveTheaterAlias(theaterId: string, alias: string | null): Promise<void> {
  await patchTheaterAlias(theaterId, alias);
  await fetchTheaters(null).then(hydrateTheaters).catch(() => {});
}

export async function createTheaterGroup(theaterId: string, name: string): Promise<void> {
  await createGroup({ theaterId, name, color: "blue" });
  await fetchGroups(null).then(hydrateGroups).catch(() => {});
}

// ─── lifecycle from other windows ──────────────────────────────────────────────

let theaterResyncGeneration = 0;

// 다른 창·API·Console Use가 Theater를 등록·잊기·되돌리면 서버가 theaterId만 방송한다. 잊기는 목록에서
// 곧바로 빼고, 나머지는 서버 목록으로 다시 맞춘다. 사건이 잇따르면 마지막 조회만 반영해 늦게 온 옛
// 응답이 새 상태를 덮지 않게 한다.
export function applyTheaterLifecycle(event: "registered" | "forgotten" | "restored" | "updated", theaterId: string): void {
  if (event === "forgotten") dropForgottenTheater(theaterId);
  const generation = ++theaterResyncGeneration;
  void Promise.all([fetchTheaters(null), fetchOperations(null), fetchGroups(null)])
    .then(([theaters, operations, groups]) => {
      if (generation !== theaterResyncGeneration) return;
      hydrateTheaters(theaters);
      hydrateOperations(operations);
      hydrateGroups(groups);
    })
    .catch(() => {});
}

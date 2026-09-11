/**
 * 팔레트의 「최근」 두 축.
 *
 * - 최근 실행한 명령: 브라우저별 localStorage(사이드바 폭 저장과 같은 범위). 명령 홈의 첫 구역이
 *   이 목록이라, 빈 첫 실행에서는 구역 자체가 서지 않는다.
 * - 최근 포커스한 Operation: 세션 메모리. 검색 결과의 활성 Theater 묶음 안 정렬만 바꾸므로
 *   영속할 이유가 없고, 영속하면 옛 순서가 새 세션의 첫 화면을 결정해 버린다.
 */

const RECENT_COMMANDS_KEY = "fleet.palette.recentCommands";
export const RECENT_COMMANDS_LIMIT = 5;

let recentOperationIds: readonly string[] = [];

export function noteOperationFocused(operationId: string): void {
  recentOperationIds = [operationId, ...recentOperationIds.filter((id) => id !== operationId)].slice(0, 32);
}

/** 최근 포커스 순위. 모르는 Operation은 -1이라 정렬에서 뒤로 간다. */
export function recentOperationRank(operationId: string): number {
  const index = recentOperationIds.indexOf(operationId);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function readRecentCommandIds(storage: Pick<Storage, "getItem"> | null = safeStorage()): readonly string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(RECENT_COMMANDS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, RECENT_COMMANDS_LIMIT) : [];
  } catch {
    return [];
  }
}

export function noteCommandRun(commandId: string, storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()): void {
  if (!storage) return;
  const next = [commandId, ...readRecentCommandIds(storage).filter((id) => id !== commandId)].slice(0, RECENT_COMMANDS_LIMIT);
  try {
    storage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next));
  } catch {
    // 저장 불가(사생활 모드 등)는 조용히 넘긴다 — 최근 구역이 비는 것뿐이다.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

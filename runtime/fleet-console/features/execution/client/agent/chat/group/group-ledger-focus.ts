import { React } from "@fleet-console/sdk/plugin/browser";

/**
 * 그룹 대화에서 지금 「원장만 보는 중」인 참여자 — 루트 Operation 별 보기 상태다.
 *
 * 가운데 대화 칸과 오른쪽 「구성원」 탭이 같은 값을 읽고 쓴다(구성원 탭의 「원장 보기」, 위임 줄의 「원장 보기」,
 * 대화 칸의 「대화로 돌아가기」). 두 표면은 서로 다른 트리에 서므로 값은 이 모듈이 쥔다. 실행 기능과 코어는 한
 * 번들이라 모듈 상태 하나로 충분하다. 영속하지 않는다 — 다시 열면 대화부터 보인다. 연결이나 세션과는 무관한 보기 상태다.
 */
const focusByRoot = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

export function setGroupLedgerFocus(rootOperationId: string, operationId: string | null): void {
  if (operationId === null) focusByRoot.delete(rootOperationId);
  else focusByRoot.set(rootOperationId, operationId);
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 원장만 보고 있는 참여자의 Operation id. 대화 전체를 보고 있으면 null. */
export function useGroupLedgerFocus(rootOperationId: string | null): string | null {
  React.useSyncExternalStore(subscribe, () => version);
  return rootOperationId ? focusByRoot.get(rootOperationId) ?? null : null;
}

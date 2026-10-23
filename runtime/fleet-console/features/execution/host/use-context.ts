import type { ObjectiveRecord } from "../../objectives/shared/records/types.js";

/**
 * 사용 컨텍스트 — Fleet Browser·Console Use·Computer Use 가 「누구의 것인가」를 정하는 실행 도메인의 규칙.
 *
 * 자식 세션(부모 레코드 안의 `sessions`)은 Objective 이 아니다. 자기 SDK 세션만 따로 가질 뿐, 브라우저 탭·
 * 허용·기기·화면공유는 부모(루트)의 것을 함께 쓴다. 그래서 세 도구는 호출한 세션을 둘로 나눠 본다:
 * - `contextId` — 상태와 허용의 주인(루트). 탭·허용 카드·기기 소유·사용 표식이 이 키에 선다.
 * - `participantId` — 실제로 호출한 세션. 턴 종료·중단은 이 참가자의 진행 중 호출만 끊는다.
 * 자식이 없는 일반 Objective 은 두 값이 같아 예전 경로와 똑같다.
 *
 * 계보는 실행 도메인의 사실(부모·자식 레코드)이고 목표(objectives) 판정이 아니다. 세 기능은 이 모듈을 import 하지
 * 않고, 부트스트랩이 같은 객체를 각자의 포트로 넘긴다.
 */
export interface UseContextResolution {
  readonly contextId: string;
  readonly participantId: string;
  /** 자식 세션이 있는 묶음(루트 또는 그 자식)인가. Computer Use 소유자 라벨 정규화는 이때만 한다. */
  readonly shared: boolean;
}

export interface UseContextDeps {
  /** 자식 세션까지 푸는 조회(`objectiveRecords.get`). */
  readonly get: (id: string) => ObjectiveRecord | null;
  /**
   * 그 세션의 턴이 열려 있는가. 출처는 Console 제어의 관측(`observe(id).activity`)이다 — PTY(OSC·hook)와 Chat(SDK)
   * 두 어댑터가 같은 활동 축에 쓰고, 축마다 권위가 하나라 두 표면을 같은 뜻으로 읽는 유일한 자리다.
   */
  readonly turnOpen: (objectiveId: string) => boolean;
}

export interface UseContext {
  resolve(objectiveId: string): UseContextResolution | null;
  /** 이 컨텍스트의 참가자 — 루트와 그 자식 세션. */
  participants(contextId: string): readonly string[];
  /**
   * 「이번 작업만」 허가를 걷을 때인가 — 판정 지점은 여기 하나다. 지금 정책은 「그룹의 열린 턴이 모두 끝날 때까지」:
   * 방금 턴을 닫은 참가자(`settling`)를 빼고 열린 턴이 하나도 없으면 참이다. 사람의 결정에 따라 「지휘관(루트) 턴까지」로
   * 바꾸려면 이 함수만 `settling === contextId` 로 바꾸면 된다.
   */
  turnGrantEnds(contextId: string, settling: string): boolean;
}

export function createUseContext(deps: UseContextDeps): UseContext {
  /**
   * 한 번 본 자식 → 루트. 자식 세션을 지우면 기록은 곧바로 사라지지만 그 세션의 정리(턴 종료·토큰 반납)는 비동기로 뒤따른다.
   * 그때 계보를 잃으면 참가자가 루트의 묶음에서 빠지지 못해 기기·사용 표식이 남는다 — 루트가 살아 있는 동안은 기억한 계보로 푼다.
   */
  const lineage = new Map<string, string>();
  const resolve = (objectiveId: string): UseContextResolution | null => {
    if (!objectiveId) return null;
    const node = deps.get(objectiveId);
    if (!node) {
      const parent = lineage.get(objectiveId);
      if (parent && deps.get(parent)) return { contextId: parent, participantId: objectiveId, shared: true };
      lineage.delete(objectiveId);
      return null;
    }
    if (node.parentObjectiveId) {
      // 손자는 만들 수 없다(objective-records-domain createChild) — 한 단계면 루트다.
      if (!deps.get(node.parentObjectiveId)) return null;
      lineage.set(node.id, node.parentObjectiveId);
      return { contextId: node.parentObjectiveId, participantId: node.id, shared: true };
    }
    return { contextId: node.id, participantId: node.id, shared: (node.sessions?.length ?? 0) > 0 };
  };
  const participants = (contextId: string): readonly string[] => {
    const root = deps.get(contextId);
    if (!root || root.parentObjectiveId) return [];
    return [root.id, ...(root.sessions ?? []).map((child) => child.id)];
  };
  return {
    resolve,
    participants,
    turnGrantEnds(contextId, settling) {
      return !participants(contextId).some((id) => id !== settling && deps.turnOpen(id));
    },
  };
}

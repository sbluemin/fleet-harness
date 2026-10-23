import { useCallback, useSyncExternalStore } from "react";

import type { MongleActivity } from "../../workspace/shared/avatars.js";
import type { OperationRuntimeState } from "../shared/client-contract.js";

import { getState as getConsoleState, subscribe as subscribeConsole } from "../../../core/client/src/integration/store.js";
import { getSessionStep, subscribeSessionStep } from "./agent/store.js";
import type { SessionStep } from "./agent/types.js";

/**
 * Operation 이 작업 중일 때 지금 하는 일 — 몽글 아바타가 손·소품·큰 동작으로 연기하는 값이다. 사이드바·대화 머리·패널이 같은
 * 값을 읽는다. 원천은 둘이다: 공개 활동축(구성원 활동을 끌어올린 값)의 남은 작업(background)과, Chat 세션 스냅샷이 싣는
 * 지금 하는 일의 계열(`SessionInfo.step`). 터미널 세션은 계열을 싣지 않으므로 기본 리듬(null)이다.
 *
 * 플러그인 계약 `OperationRuntimeState` 는 넓히지 않는다 — 계열은 실행 기능의 세션 상점에만 산다.
 */
export function operationMongleActivity(runtime: OperationRuntimeState | undefined, step: SessionStep | undefined): MongleActivity | null {
  if (!runtime || runtime.lifecycle !== "live") return null;
  if (runtime.activity === "background") return "background";
  if (runtime.activity !== "running") return null;
  return step ?? null;
}

/**
 * 값 하나만 구독한다 — 스냅샷이 문자열이라 값이 그대로면 React 가 렌더를 건너뛴다. 계열은 그 Operation 의 것만 구독하므로
 * 다른 Operation 의 계열이 바뀌어도 이 아바타는 깨어나지 않는다.
 */
export function useOperationMongleActivity(operationId: string | null | undefined): MongleActivity | null {
  const subscribe = useCallback((listener: () => void) => {
    const offConsole = subscribeConsole(listener);
    const offStep = operationId ? subscribeSessionStep(operationId, listener) : () => {};
    return () => {
      offConsole();
      offStep();
    };
  }, [operationId]);
  return useSyncExternalStore(
    subscribe,
    () => (operationId ? operationMongleActivity(getConsoleState().operationRuntime[operationId], getSessionStep(operationId)) : null),
    () => null,
  );
}

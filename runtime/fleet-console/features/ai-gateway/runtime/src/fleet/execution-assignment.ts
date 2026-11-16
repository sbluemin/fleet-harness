import type { ExecutionModelFailure, ExecutionModelRequest, ExecutionModelResolution } from "./execution-routing.js";

/**
 * execution-assignment — 위임 실행 하나의 배정을 한 번만 계산해 그 실행 수명 동안 고정한다.
 *
 * 요청마다 다시 판정하면 서브에이전트의 두 번째 요청(도구 결과 뒤)이나 재시도에서 다른 모델이
 * 나온다. 배정은 실행의 성질이지 요청의 성질이 아니므로, 첫 요청에서 정하고 그 실행 id로
 * 다시 묻는 모든 요청에 같은 답을 준다.
 *
 * 실패는 캐시하지 않는다. `task_started`가 늦게 도착해 첫 요청이 실패한 경우, 다음 요청은
 * 다시 기다려 성공할 수 있다. 용량을 넘으면 살아 있는 배정을 밀어내는 대신 새 요청을 명시
 * 오류로 거절한다 — 조용한 재배정은 이 캐시가 막으려는 바로 그 사고다.
 */

export interface ExecutionAssignmentCacheOptions {
  readonly resolve: (
    request: ExecutionModelRequest,
  ) => Promise<ExecutionModelResolution | ExecutionModelFailure> | ExecutionModelResolution | ExecutionModelFailure;
  /** 살아 있는 배정의 상한. 넘으면 새 실행은 명시 오류로 거절된다. */
  readonly maxAssignments?: number;
}

export interface ExecutionAssignmentCache {
  assign(request: ExecutionModelRequest): Promise<ExecutionModelResolution | ExecutionModelFailure>;
  /** SDK 세션이 접힐 때 그 세션의 배정과 진행 중 표식을 걷는다. */
  releaseSession(sessionId: string): void;
  readonly size: number;
}

const DEFAULT_MAX_ASSIGNMENTS = 4096;
const CAPACITY_MESSAGE = "Fleet has too many live delegated assignments, so this run was not assigned a model.";
const FAILURE_MESSAGE = "Fleet could not assign a model to this delegated run.";

function keyOf(sessionId: string, agentId: string): string {
  return `${sessionId}\u0000${agentId}`;
}

export function createExecutionAssignmentCache(options: ExecutionAssignmentCacheOptions): ExecutionAssignmentCache {
  const maxAssignments = options.maxAssignments ?? DEFAULT_MAX_ASSIGNMENTS;
  /** 성공한 배정만 담는다. 실패는 다음 요청이 다시 시도한다. */
  const assignments = new Map<string, ExecutionModelResolution>();
  /** 같은 실행의 동시 첫 요청이 판정을 두 번 하지 않게 한다. */
  const flights = new Map<string, Promise<ExecutionModelResolution | ExecutionModelFailure>>();
  /** 이 세션이 아직 살아 있는가. 진행 중 판정이 끝난 뒤 늦게 캐시를 채우지 않게 한다. */
  const liveSessions = new Set<string>();

  return {
    assign(request) {
      const lookupKey = keyOf(request.sessionId, request.agentId);
      const cached = assignments.get(lookupKey);
      if (cached !== undefined) return Promise.resolve(cached);
      const flying = flights.get(lookupKey);
      if (flying !== undefined) return flying;
      if (assignments.size >= maxAssignments) return Promise.resolve({ error: CAPACITY_MESSAGE });
      liveSessions.add(request.sessionId);
      const flight = (async (): Promise<ExecutionModelResolution | ExecutionModelFailure> => {
        try {
          const result = await options.resolve(request);
          if (!("error" in result) && liveSessions.has(request.sessionId)) assignments.set(lookupKey, result);
          return result;
        } catch {
          return { error: FAILURE_MESSAGE };
        } finally {
          flights.delete(lookupKey);
        }
      })();
      flights.set(lookupKey, flight);
      return flight;
    },
    releaseSession(sessionId) {
      liveSessions.delete(sessionId);
      const prefix = `${sessionId}\u0000`;
      for (const lookupKey of [...assignments.keys()]) {
        if (lookupKey.startsWith(prefix)) assignments.delete(lookupKey);
      }
      for (const lookupKey of [...flights.keys()]) {
        if (lookupKey.startsWith(prefix)) flights.delete(lookupKey);
      }
    },
    get size() {
      return assignments.size;
    },
  };
}

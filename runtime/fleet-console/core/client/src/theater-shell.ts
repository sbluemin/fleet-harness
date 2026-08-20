import type { OperationLaunchKind } from "@fleet-console/sdk/operations";

import type { OperationNode } from "./types.js";

const SHELL_OPERATION_TYPE = "shell";

export type TheaterShellLaunchDecision =
  | { readonly action: "create" }
  | { readonly action: "reuse"; readonly operationId: string }
  | { readonly action: "busy" };

export function isTheaterShellLaunch(kind: Pick<OperationLaunchKind, "type">): boolean {
  return kind.type === SHELL_OPERATION_TYPE;
}

/** 목록이 비어 있는 부트 구간을 "Shell 없음"으로 읽으면 복원분 옆에 하나를 더 만든다. */
export function theaterShellDecisionRequiresHydration(
  kind: Pick<OperationLaunchKind, "type">,
  operationsHydrated: boolean,
): boolean {
  return isTheaterShellLaunch(kind) && !operationsHydrated;
}

/** Theater 안의 기존 Shell Operation. 없으면 null. 활성 패널이 Shell이면 그것을, 아니면 가장 최근 것을 고른다. */
export function findTheaterShellId(
  operations: readonly OperationNode[],
  theaterId: string,
  options: {
    readonly pluginId: string;
    readonly activeOperationId?: string | null;
  },
): string | null {
  const shells = operations.filter((operation) => (
    operation.theaterId === theaterId
    && operation.type === SHELL_OPERATION_TYPE
    && operation.pluginId === options.pluginId
  ));
  if (shells.length === 0) return null;
  const activeId = options.activeOperationId;
  if (activeId !== undefined && activeId !== null && shells.some((operation) => operation.id === activeId)) {
    return activeId;
  }
  return shells.reduce((best, candidate) => preferLaterShell(best, candidate)).id;
}

/**
 * Shell 실행 요청을 생성 / 기존 패널 재사용 / 생성 중 무시로 가른다.
 * 에이전트 등 다른 종류는 항상 생성이다.
 */
export function resolveTheaterShellLaunch(
  operations: readonly OperationNode[],
  theaterId: string,
  pluginId: string,
  kind: Pick<OperationLaunchKind, "type">,
  options: {
    readonly activeOperationId?: string | null;
    readonly inflightTheaterIds?: ReadonlySet<string>;
  } = {},
): TheaterShellLaunchDecision {
  if (!isTheaterShellLaunch(kind)) return { action: "create" };
  const existingId = findTheaterShellId(operations, theaterId, {
    pluginId,
    activeOperationId: options.activeOperationId,
  });
  if (existingId) return { action: "reuse", operationId: existingId };
  if (options.inflightTheaterIds?.has(theaterId)) return { action: "busy" };
  return { action: "create" };
}

function preferLaterShell(left: OperationNode, right: OperationNode): OperationNode {
  if (right.ts.updatedAt !== left.ts.updatedAt) return right.ts.updatedAt > left.ts.updatedAt ? right : left;
  if (right.ts.createdAt !== left.ts.createdAt) return right.ts.createdAt > left.ts.createdAt ? right : left;
  return right.id > left.id ? right : left;
}

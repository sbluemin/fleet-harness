import type { OperationCluster, OperationClusterMember, OperationClusterProgress, OperationClusterSource } from "@fleet-console/sdk/plugin";

import { latestRecord, stepReady, type TodoItem } from "../server/types.js";
import { openTodoSurface, operationSummaries, readAllTheaters, revealItem, subscribeTodo } from "./todo-state.js";

/**
 * 할 일 → 호스트 묶음 서술자.
 *
 * 조율자 슬롯이 뿌리, 담당 슬롯이 있는 단계가 구성원이다. 완료된 할 일도 묶음으로 남는다 — 연결됐던 Operation 은
 * 계속 특수하다(슬롯은 `done.released` 에 보관돼 있다). 풀리는 때는 항목 삭제나 연결 해제뿐이다.
 * 호스트가 useSyncExternalStore 로 읽으므로, 내용이 같으면 같은 배열을 돌려준다.
 */

interface Slotted { readonly coordinator: string | null; readonly steps: ReadonlyMap<string, string> }

function slotsOf(item: TodoItem): Slotted {
  const steps = new Map<string, string>();
  let coordinator = item.slot?.operationId ?? null;
  for (const step of item.steps) if (step.slot) steps.set(step.id, step.slot.operationId);
  if (item.done) {
    for (const released of item.done.released) {
      if (released.stepId) { if (!steps.has(released.stepId)) steps.set(released.stepId, released.slot.operationId); }
      else if (!coordinator) coordinator = released.slot.operationId;
    }
  }
  return { coordinator, steps };
}

function progressOf(item: TodoItem, stepId: string, operationId: string, activity: Map<string, string>): OperationClusterProgress {
  const step = item.steps.find((candidate) => candidate.id === stepId)!;
  if (step.done) return "done";
  if (!stepReady(item, step)) return "blocked";
  const current = activity.get(operationId);
  if (current === "awaiting") return "awaiting";
  if (current === "running" || current === "background") return "running";
  return "open";
}

/** 아직 Operation 이 없는 단계의 자리표시 id — 띠의 사각 하나가 된다. 호스트는 pending 을 보고 행·패널을 세우지 않는다. */
const placeholderId = (stepId: string) => `step:${stepId}`;

export function clustersOf(items: readonly TodoItem[], activity: Map<string, string>): OperationCluster[] {
  const out: OperationCluster[] = [];
  for (const item of items) {
    const { coordinator, steps } = slotsOf(item);
    // 셰프 Operation 이 살아 있으면 묶음이 선다 — 단계 Operation 이 하나도 없어도, 단계가 하나뿐이어도 띠는 같은 모양이다.
    if (!coordinator || !activity.has(coordinator)) continue;
    const byStep = new Map(item.steps.map((step, index) => [step.id, index + 1]));
    const idOf = (stepId: string): string => {
      const operationId = steps.get(stepId);
      return operationId && operationId !== coordinator && activity.has(operationId) ? operationId : placeholderId(stepId);
    };
    const members: OperationClusterMember[] = item.steps.map((step) => {
      const id = idOf(step.id);
      const pending = id === placeholderId(step.id);
      return {
        operationId: id,
        ...(pending ? { pending: true } : {}),
        label: `${byStep.get(step.id)}. ${step.text}`,
        after: step.after.map(idOf),
        progress: pending ? (step.done ? "done" : stepReady(item, step) ? "open" : "blocked") : progressOf(item, step.id, id, activity),
        // 캡션 피커의 한 줄 — 가장 최근 기록의 결론.
        ...((latest) => (latest ? { result: latest.lines[0] ?? "" } : {}))(latestRecord(step)),
      };
    });
    const open = (operationId?: string) => {
      const stepId = operationId
        ? operationId.startsWith("step:") ? operationId.slice(5) : [...steps.entries()].find(([, id]) => id === operationId)?.[0]
        : undefined;
      revealItem(stepId ? { itemId: item.id, stepId } : { itemId: item.id });
      openTodoSurface();
    };
    out.push({ id: item.id, theaterId: item.theaterId, title: item.title, root: coordinator, members, open });
  }
  return out;
}

const signature = (clusters: readonly OperationCluster[]) => JSON.stringify(clusters.map((cluster) => [cluster.id, cluster.root, cluster.title, cluster.members.map((member) => [member.operationId, member.pending ?? false, member.label, member.after, member.progress, member.result ?? ""])]));

let cached: readonly OperationCluster[] = [];
let cachedSignature = "";

export const todoClusterSource: OperationClusterSource = {
  subscribe: subscribeTodo,
  get: () => {
    const activity = new Map(operationSummaries().map((summary) => [summary.id, summary.activity]));
    const next = clustersOf(readAllTheaters().flatMap((state) => state.items), activity);
    const nextSignature = signature(next);
    if (nextSignature === cachedSignature) return cached;
    cached = next;
    cachedSignature = nextSignature;
    return cached;
  },
};

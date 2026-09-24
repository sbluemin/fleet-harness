import type { OperationCluster, OperationClusterMember, OperationClusterProgress, OperationClusterSource } from "@fleet-console/sdk/plugin";

import { latestRecord, stepReady, type ObjectiveItem } from "../server/types.js";
import { openObjectiveSurface, operationSummaries, readAllTheaters, revealItem, subscribeObjective } from "./objectives-state.js";

/**
 * 목표 → 호스트 묶음 서술자.
 *
 * 목표의 지휘관 Operation 이 뿌리, 담당 Operation 이 있는 단계가 구성원이다. 모든 에이전트 Operation 이 목표이므로
 * 임무가 하나라도 있는 목표만 묶음이 된다 — 임무 없는 Operation 은 사이드바에서 여느 Operation 그대로다.
 * 완료된 목표도 묶음으로 남는다(담당 연결은 완료로 풀리지 않는다).
 * 호스트가 useSyncExternalStore 로 읽으므로, 내용이 같으면 같은 배열을 돌려준다.
 */

function progressOf(item: ObjectiveItem, stepId: string, operationId: string, activity: Map<string, string>): OperationClusterProgress {
  const step = item.steps.find((candidate) => candidate.id === stepId)!;
  if (step.done) return "done";
  if (!stepReady(item.steps, step)) return "blocked";
  const current = activity.get(operationId);
  if (current === "awaiting") return "awaiting";
  if (current === "running" || current === "background") return "running";
  return "open";
}

/** 아직 Operation 이 없는 단계의 자리표시 id — 띠의 사각 하나가 된다. 호스트는 pending 을 보고 행·패널을 세우지 않는다. */
const placeholderId = (stepId: string) => `step:${stepId}`;

export function clustersOf(items: readonly ObjectiveItem[], activity: Map<string, string>): OperationCluster[] {
  const out: OperationCluster[] = [];
  for (const item of items) {
    const coordinator = item.id;
    const steps = new Map(item.steps.flatMap((step) => (step.operationId ? [[step.id, step.operationId] as const] : [])));
    // 임무가 있는 목표의 지휘관 Operation 이 살아 있으면 묶음이 선다 — 담당이 하나도 없어도 띠는 같은 모양이다.
    if (item.steps.length === 0 || !activity.has(coordinator)) continue;
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
        progress: pending ? (step.done ? "done" : stepReady(item.steps, step) ? "open" : "blocked") : progressOf(item, step.id, id, activity),
        // 캡션 피커의 한 줄 — 가장 최근 기록의 결론.
        ...((latest) => (latest ? { result: latest.lines[0] ?? "" } : {}))(latestRecord(step)),
      };
    });
    const open = (operationId?: string) => {
      const stepId = operationId
        ? operationId.startsWith("step:") ? operationId.slice(5) : [...steps.entries()].find(([, id]) => id === operationId)?.[0]
        : undefined;
      revealItem(stepId ? { itemId: item.id, stepId } : { itemId: item.id });
      openObjectiveSurface();
    };
    out.push({ id: item.id, theaterId: item.theaterId, title: item.title, root: coordinator, members, open });
  }
  return out;
}

const signature = (clusters: readonly OperationCluster[]) => JSON.stringify(clusters.map((cluster) => [cluster.id, cluster.root, cluster.title, cluster.members.map((member) => [member.operationId, member.pending ?? false, member.label, member.after, member.progress, member.result ?? ""])]));

let cached: readonly OperationCluster[] = [];
let cachedSignature = "";

export const objectivesClusterSource: OperationClusterSource = {
  subscribe: subscribeObjective,
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

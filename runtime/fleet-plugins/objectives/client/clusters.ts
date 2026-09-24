import type { OperationCluster, OperationClusterMember, OperationClusterProgress, OperationClusterSource } from "@fleet-console/sdk/plugin";

import { latestRecord, stepReady, type ObjectiveItem } from "../server/types.js";
import { openObjectiveSurface, operationSummaries, readAllTheaters, revealItem, subscribeObjective } from "./objectives-state.js";

/**
 * 목표 → 호스트 묶음 서술자.
 *
 * 목표의 지휘관 Operation 이 뿌리, 구성원 Operation 이 묶음의 구성원이다 — 호스트는 구성원 목록에 든 Operation 을 지휘관
 * 아래로 접는다. 띠는 여전히 임무 단위로 그린다: 구성원 Operation 은 자기 **대표 임무**(아직 끝나지 않은 첫 임무, 모두 끝났으면
 * 마지막 임무) 칸에 한 번만 서고, 같은 구성원의 나머지 임무와 지휘관 직접 임무는 자리표시 칸이다(호스트는 Operation id 로
 * 색인하므로 같은 id 를 두 번 내지 않는다). 임무를 맡지 않은 구성원도 역할 이름 칸으로 서서 따로 떠돌지 않는다.
 * 임무도 떠 있는 구성원도 없는 Operation 은 사이드바에서 여느 Operation 그대로다. 완료된 목표도 묶음으로 남는다.
 * 호스트가 useSyncExternalStore 로 읽으므로, 내용이 같으면 같은 배열을 돌려준다.
 */

function progressOf(item: ObjectiveItem, stepId: string, operationId: string, activity: Map<string, string>): OperationClusterProgress {
  const step = item.steps.find((candidate) => candidate.id === stepId)!;
  if (step.done) return "done";
  if (!stepReady(item.steps, step)) return "blocked";
  return liveProgress(operationId, activity);
}
const liveProgress = (operationId: string, activity: Map<string, string>): OperationClusterProgress => {
  const current = activity.get(operationId);
  if (current === "awaiting") return "awaiting";
  if (current === "running" || current === "background") return "running";
  return "open";
};

/** 아직 Operation 이 없는(또는 대표가 아닌) 임무의 자리표시 id — 띠의 사각 하나가 된다. 호스트는 pending 을 보고 행·패널을 세우지 않는다. */
const placeholderId = (stepId: string) => `step:${stepId}`;

export function clustersOf(items: readonly ObjectiveItem[], activity: Map<string, string>): OperationCluster[] {
  const out: OperationCluster[] = [];
  for (const item of items) {
    const coordinator = item.id;
    const live = (operationId: string | null | undefined): string | null => (operationId && operationId !== coordinator && activity.has(operationId) ? operationId : null);
    const liveMembers = item.members.flatMap((member) => { const operationId = live(member.operationId); return operationId ? [{ member, operationId }] : []; });
    // 임무나 떠 있는 구성원이 있는 목표의 지휘관 Operation 이 살아 있으면 묶음이 선다.
    if ((item.steps.length === 0 && liveMembers.length === 0) || !activity.has(coordinator)) continue;
    // 구성원 Operation → 대표 임무. 끝나지 않은 첫 임무가 이기고, 모두 끝났으면 마지막 임무.
    const representative = new Map<string, string>();
    for (const step of item.steps) {
      const operationId = live(step.operationId);
      if (!operationId) continue;
      const current = representative.get(operationId);
      const currentDone = current ? item.steps.find((candidate) => candidate.id === current)!.done : true;
      if (!current || currentDone) representative.set(operationId, step.id);
    }
    const byStep = new Map(item.steps.map((step, index) => [step.id, index + 1]));
    const idOf = (stepId: string): string => {
      const operationId = live(item.steps.find((step) => step.id === stepId)?.operationId);
      return operationId && representative.get(operationId) === stepId ? operationId : placeholderId(stepId);
    };
    const roleOf = (operationId: string) => liveMembers.find((entry) => entry.operationId === operationId)?.member.role;
    const members: OperationClusterMember[] = item.steps.map((step) => {
      const id = idOf(step.id);
      const pending = id === placeholderId(step.id);
      const name = pending ? undefined : roleOf(id);
      return {
        operationId: id,
        ...(pending ? { pending: true } : {}),
        // 노드 줄에는 구성원 이름으로 선다 — 「N 노드」가 아니라 「조사」.
        ...(name ? { name } : {}),
        label: `${byStep.get(step.id)}. ${step.text}`,
        after: step.after.map(idOf),
        progress: pending ? (step.done ? "done" : stepReady(item.steps, step) ? "open" : "blocked") : progressOf(item, step.id, id, activity),
        // 캡션 피커의 한 줄 — 가장 최근 기록의 결론.
        ...((latest) => (latest ? { result: latest.lines[0] ?? "" } : {}))(latestRecord(step)),
      };
    });
    // 임무를 맡지 않은 구성원 — 역할 이름 칸으로 묶음에 든다.
    for (const { member, operationId } of liveMembers) {
      if (representative.has(operationId)) continue;
      members.push({ operationId, label: member.role, name: member.role, after: [], progress: liveProgress(operationId, activity) });
    }
    const open = (operationId?: string) => {
      const stepId = operationId
        ? operationId.startsWith("step:") ? operationId.slice(5) : representative.get(operationId)
        : undefined;
      revealItem(stepId ? { itemId: item.id, stepId } : { itemId: item.id });
      openObjectiveSurface();
    };
    out.push({ id: item.id, theaterId: item.theaterId, title: item.title, root: coordinator, members, open });
  }
  return out;
}

const signature = (clusters: readonly OperationCluster[]) => JSON.stringify(clusters.map((cluster) => [cluster.id, cluster.root, cluster.title, cluster.members.map((member) => [member.operationId, member.pending ?? false, member.name ?? "", member.label, member.after, member.progress, member.result ?? ""])]));

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

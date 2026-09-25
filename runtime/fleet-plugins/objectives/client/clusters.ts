import type { OperationCluster, OperationClusterMember, OperationClusterProgress, OperationClusterSource } from "@fleet-console/sdk/plugin";

import { latestRecord, missionReady, type Objective } from "../server/types.js";
import { openObjectiveSurface, operationSummaries, readAllTheaters, revealObjective, subscribeObjective } from "./objectives-state.js";

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

function progressOf(objective: Objective, missionId: string, operationId: string, activity: Map<string, string>): OperationClusterProgress {
  const mission = objective.missions.find((candidate) => candidate.id === missionId)!;
  if (mission.done) return "done";
  if (!missionReady(objective.missions, mission)) return "blocked";
  return liveProgress(operationId, activity);
}
const liveProgress = (operationId: string, activity: Map<string, string>): OperationClusterProgress => {
  const current = activity.get(operationId);
  if (current === "awaiting") return "awaiting";
  if (current === "running" || current === "background") return "running";
  return "open";
};

/**
 * 구성원의 정체성 톤 — 명단 순번으로 여덟 톤을 돌려 쓴다. 목표 표면의 구성원 표식(objectives.css `is-tone-N`)과 같은 순서라,
 * 지휘관 캡션의 「› 이름」이 목표 화면의 그 구성원과 같은 색으로 선다.
 */
const MEMBER_TONE_KEYS = ["teal", "amber", "plum", "moss", "cerulean", "rose", "indigo", "crimson"] as const;
const memberToneOf = (objective: Objective, memberId: string): string => MEMBER_TONE_KEYS[Math.max(0, objective.members.findIndex((member) => member.id === memberId)) % MEMBER_TONE_KEYS.length]!;

/** 아직 Operation 이 없는(또는 대표가 아닌) 임무의 자리표시 id — 띠의 사각 하나가 된다. 호스트는 pending 을 보고 행·패널을 세우지 않는다. */
const placeholderId = (missionId: string) => `mission:${missionId}`;

export function clustersOf(objectives: readonly Objective[], activity: Map<string, string>): OperationCluster[] {
  const out: OperationCluster[] = [];
  for (const objective of objectives) {
    const commander = objective.id;
    const live = (operationId: string | null | undefined): string | null => (operationId && operationId !== commander && activity.has(operationId) ? operationId : null);
    const liveMembers = objective.members.flatMap((member) => { const operationId = live(member.operationId); return operationId ? [{ member, operationId }] : []; });
    // 임무나 떠 있는 구성원이 있는 목표의 지휘관 Operation 이 살아 있으면 묶음이 선다.
    if ((objective.missions.length === 0 && liveMembers.length === 0) || !activity.has(commander)) continue;
    // 구성원 Operation → 대표 임무. 끝나지 않은 첫 임무가 이기고, 모두 끝났으면 마지막 임무.
    const representative = new Map<string, string>();
    for (const mission of objective.missions) {
      const operationId = live(mission.operationId);
      if (!operationId) continue;
      const current = representative.get(operationId);
      const currentDone = current ? objective.missions.find((candidate) => candidate.id === current)!.done : true;
      if (!current || currentDone) representative.set(operationId, mission.id);
    }
    const byMission = new Map(objective.missions.map((mission, index) => [mission.id, index + 1]));
    const idOf = (missionId: string): string => {
      const operationId = live(objective.missions.find((mission) => mission.id === missionId)?.operationId);
      return operationId && representative.get(operationId) === missionId ? operationId : placeholderId(missionId);
    };
    const memberOf = (operationId: string) => liveMembers.find((entry) => entry.operationId === operationId)?.member;
    const members: OperationClusterMember[] = objective.missions.map((mission) => {
      const id = idOf(mission.id);
      const pending = id === placeholderId(mission.id);
      const member = pending ? undefined : memberOf(id);
      const memberIndex = member ? objective.members.findIndex((candidate) => candidate.id === member.id) : -1;
      const name = member?.role;
      return {
        operationId: id,
        ...(pending ? { pending: true } : {}),
        // 노드 줄에는 구성원 이름으로 선다 — 「N 노드」가 아니라 「조사」.
        ...(name ? { name } : {}),
        ...(member ? { tone: memberToneOf(objective, member.id) } : {}),
        ...(memberIndex >= 0 ? { order: memberIndex } : {}),
        label: `${byMission.get(mission.id)}. ${mission.text}`,
        after: mission.prerequisites.map(idOf),
        progress: pending ? (mission.done ? "done" : missionReady(objective.missions, mission) ? "open" : "blocked") : progressOf(objective, mission.id, id, activity),
        ...(!pending ? { awaitingInput: activity.get(id) === "awaiting" } : {}),
        // 캡션 피커의 한 줄 — 가장 최근 기록의 결론.
        ...((latest) => (latest ? { result: latest.lines[0] ?? "" } : {}))(latestRecord(mission)),
      };
    });
    // 임무를 맡지 않은 구성원 — 역할 이름 칸으로 묶음에 든다.
    for (const { member, operationId } of liveMembers) {
      if (representative.has(operationId)) continue;
      const memberIndex = objective.members.findIndex((candidate) => candidate.id === member.id);
      members.push({
        operationId,
        label: member.role,
        name: member.role,
        tone: memberToneOf(objective, member.id),
        ...(memberIndex >= 0 ? { order: memberIndex } : {}),
        after: [],
        progress: liveProgress(operationId, activity),
        awaitingInput: activity.get(operationId) === "awaiting",
      });
    }
    const open = (operationId?: string) => {
      const missionId = operationId
        ? operationId.startsWith("mission:") ? operationId.slice("mission:".length) : representative.get(operationId)
        : undefined;
      revealObjective(missionId ? { objectiveId: objective.id, missionId } : { objectiveId: objective.id });
      openObjectiveSurface();
    };
    out.push({ id: objective.id, theaterId: objective.theaterId, title: objective.title, root: commander, members, open });
  }
  return out;
}

const signature = (clusters: readonly OperationCluster[]) => JSON.stringify(clusters.map((cluster) => [cluster.id, cluster.root, cluster.title, cluster.members.map((member) => [member.operationId, member.pending ?? false, member.name ?? "", member.tone ?? "", member.order ?? -1, member.label, member.after, member.progress, member.awaitingInput ?? null, member.result ?? ""])]));

let cached: readonly OperationCluster[] = [];
let cachedSignature = "";

export const objectivesClusterSource: OperationClusterSource = {
  subscribe: subscribeObjective,
  get: () => {
    const activity = new Map(operationSummaries().map((summary) => [summary.id, summary.activity]));
    const next = clustersOf(readAllTheaters().flatMap((state) => state.objectives), activity);
    const nextSignature = signature(next);
    if (nextSignature === cachedSignature) return cached;
    cached = next;
    cachedSignature = nextSignature;
    return cached;
  },
};

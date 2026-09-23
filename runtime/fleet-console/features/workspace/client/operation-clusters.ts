import { useMemo, useSyncExternalStore } from "react";

import type { OperationCluster, OperationClusterMember, OperationClusterProgress } from "@fleet-console/sdk/plugin";

import { usePluginRegistry } from "../../../core/client/src/integration/plugin-registry.js";

/**
 * 묶음 — 플러그인이 선언한 실행 구조를 네 모드가 같은 셈법으로 읽는 자리.
 *
 * 단계 Operation 은 어느 모드에서도 패널로 서지 않는다 — 지휘관 하나가 묶음을 대표하고, 지휘관 패널이 본문 교체로 단계를 보인다.
 * 여기서 계산하는 것은 순서·깊이·행뿐이다. 색과 모션은 각 표면의 CSS 가, 진실은 플러그인이 진다.
 */

export interface ClusterLaidMember {
  readonly member: OperationClusterMember;
  readonly depth: number;
  /** 같은 깊이 안의 행 번호(0부터). */
  readonly row: number;
  /** 뿌리를 뺀 위상 순서(깊이 → 선언 순). */
  readonly order: number;
}

/** Operation 이 선 구성원만의 배치 — 숨김·본문 교체·노드 줄이 읽는다. 자리표시(pending) 단계는 열도 행도 차지하지 않는다. */
export interface ClusterFormation {
  readonly members: readonly ClusterLaidMember[];
  readonly byOperationId: ReadonlyMap<string, ClusterLaidMember>;
  /** 깊이 열 수(뿌리 제외). */
  readonly columns: number;
  /** 가장 많은 병렬 구성원 수. */
  readonly rows: number;
}

export interface ClusterLayout {
  readonly cluster: OperationCluster;
  /** 모든 구성원(자리표시 포함) — 띠가 그리는 구조. */
  readonly members: readonly ClusterLaidMember[];
  readonly byOperationId: ReadonlyMap<string, ClusterLaidMember>;
  /** 깊이 열 수(뿌리 제외). */
  readonly columns: number;
  /** 가장 많은 병렬 구성원 수. */
  readonly rows: number;
  readonly formation: ClusterFormation;
}

const PROGRESS_URGENCY: Record<OperationClusterProgress, number> = { awaiting: 0, running: 1, open: 2, blocked: 3, done: 4 };

/**
 * 깊이·행·순서를 매긴다. `counts` 가 거짓인 구성원(자리표시)은 선행 경로를 이어 주기만 하고 자기 깊이를 더하지 않으며,
 * 결과 목록에도 들지 않는다 — 그래서 지휘관이 직접 하는 단계 사이에 위임 단계가 하나 있어도 깊이는 한 칸이다.
 */
function laidOut(cluster: OperationCluster, counts: (member: OperationClusterMember) => boolean): ClusterFormation {
  const byId = new Map(cluster.members.map((member) => [member.operationId, member]));
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const member = byId.get(id);
    const value = member && member.after.length
      ? Math.max(0, ...member.after.filter((parent) => byId.has(parent)).map((parent) => depthOf(parent, seen) + (counts(byId.get(parent)!) ? 1 : 0)))
      : 0;
    depth.set(id, value);
    return value;
  };
  for (const member of cluster.members) depthOf(member.operationId, new Set());
  const ordered = cluster.members
    .map((member, index) => ({ member, index, depth: depth.get(member.operationId) ?? 0 }))
    .filter((entry) => counts(entry.member))
    .sort((a, b) => a.depth - b.depth || a.index - b.index);
  const rowCounter = new Map<number, number>();
  const members: ClusterLaidMember[] = ordered.map((entry, order) => {
    const row = rowCounter.get(entry.depth) ?? 0;
    rowCounter.set(entry.depth, row + 1);
    return { member: entry.member, depth: entry.depth, row, order };
  });
  return {
    members,
    byOperationId: new Map(members.map((laid) => [laid.member.operationId, laid])),
    columns: members.length ? Math.max(...members.map((laid) => laid.depth)) + 1 : 0,
    rows: Math.max(1, ...[...rowCounter.values()]),
  };
}

export function layoutCluster(cluster: OperationCluster): ClusterLayout {
  const all = laidOut(cluster, () => true);
  const formation = cluster.members.some((member) => member.pending) ? laidOut(cluster, (member) => !member.pending) : all;
  return { cluster, ...all, formation };
}

/** 묶음 안에서 가장 급한 진행 — 상태 축에서 묶음 전체가 서는 칸을 정한다. */
export function mostUrgentProgress(cluster: OperationCluster): OperationClusterProgress | null {
  let best: OperationClusterProgress | null = null;
  for (const member of cluster.members) if (best === null || PROGRESS_URGENCY[member.progress] < PROGRESS_URGENCY[best]) best = member.progress;
  return best;
}

export interface ClusterIndex {
  readonly clusters: readonly OperationCluster[];
  readonly layouts: ReadonlyMap<string, ClusterLayout>;
  /** operationId → 그 Operation 이 뿌리인 묶음. */
  readonly rootOf: ReadonlyMap<string, ClusterLayout>;
  /** operationId → 그 Operation 이 구성원인 묶음과 자리. */
  readonly memberOf: ReadonlyMap<string, { readonly layout: ClusterLayout; readonly laid: ClusterLaidMember }>;
}

const EMPTY_INDEX: ClusterIndex = { clusters: [], layouts: new Map(), rootOf: new Map(), memberOf: new Map() };

export function indexClusters(clusters: readonly OperationCluster[]): ClusterIndex {
  if (clusters.length === 0) return EMPTY_INDEX;
  const layouts = new Map<string, ClusterLayout>();
  const rootOf = new Map<string, ClusterLayout>();
  const memberOf = new Map<string, { layout: ClusterLayout; laid: ClusterLaidMember }>();
  for (const cluster of clusters) {
    const layout = layoutCluster(cluster);
    layouts.set(cluster.id, layout);
    // 한 Operation 은 한 묶음에만 선다 — 먼저 선언된 묶음이 이긴다.
    if (!rootOf.has(cluster.root) && !memberOf.has(cluster.root)) rootOf.set(cluster.root, layout);
    // 구성원 색인은 Operation 이 선 단계 기준 — 자리표시는 색인에도 없고, 깊이도 Operation 이 선 선행만 센다.
    for (const laid of layout.formation.members) if (!memberOf.has(laid.member.operationId) && !rootOf.has(laid.member.operationId)) memberOf.set(laid.member.operationId, { layout, laid });
  }
  return { clusters, layouts, rootOf, memberOf };
}

export function useOperationClusters(): readonly OperationCluster[] {
  const { operationClusters } = usePluginRegistry();
  return useSyncExternalStore(operationClusters.subscribe, operationClusters.get, operationClusters.get);
}

export function useClusterIndex(): ClusterIndex {
  const clusters = useOperationClusters();
  return useMemo(() => indexClusters(clusters), [clusters]);
}

// ── 구성원 숨김 ────────────────────────────────────────────────────────────────────────────────────
/**
 * 화면에서 접히는 구성원 — 모든 모드에서 전부. 단계 Operation 은 뒤에서 돌고 패널을 세우지 않으며(본문은 풀에 대기),
 * 지휘관 패널이 노드 줄·진척도 목록의 본문 교체로 그들을 보여 준다.
 */
export function hiddenClusterMembers(index: ClusterIndex): ReadonlySet<string> {
  return new Set(index.memberOf.keys());
}

// ── 본문 선택 ──────────────────────────────────────────────────────────────────────────────────────
// 지휘관 패널이 어느 Operation 의 본문(PTY·채팅뷰)을 보이는가. 세션은 그대로고 마운트만 이 프레임의 슬롯으로 옮겨 온다.
// 세션 안에서만 산다 — 새로 열면 지휘관 자신으로 돌아온다.
let bodySelection: Readonly<Record<string, string>> = {};
const bodyListeners = new Set<() => void>();
export function selectClusterBody(rootId: string, operationId: string | null): void {
  const next = { ...bodySelection };
  if (!operationId || operationId === rootId) delete next[rootId]; else next[rootId] = operationId;
  bodySelection = next;
  for (const listener of bodyListeners) listener();
}
const subscribeBody = (listener: () => void) => { bodyListeners.add(listener); return () => { bodyListeners.delete(listener); }; };
const readBody = () => bodySelection;
export function useClusterBodySelection(): Readonly<Record<string, string>> {
  return useSyncExternalStore(subscribeBody, readBody, readBody);
}

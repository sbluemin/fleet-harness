import { useMemo, useSyncExternalStore } from "react";

import type { OperationCluster, OperationClusterMember, OperationClusterProgress, OperationRuntimeState } from "@fleet-console/sdk/plugin";

import { usePluginRegistry } from "../../../core/client/src/integration/plugin-registry.js";

/**
 * 묶음 — 플러그인이 선언한 실행 구조를 네 모드가 같은 셈법으로 읽는 자리.
 *
 * 깊이(가장 긴 선행 경로)가 곧 사이드바의 들여쓰기이자 Cruise·Tactical 의 열이고, 같은 깊이의 구성원이 행(병렬)이다.
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

export interface ClusterLayout {
  readonly cluster: OperationCluster;
  readonly members: readonly ClusterLaidMember[];
  readonly byOperationId: ReadonlyMap<string, ClusterLaidMember>;
  /** 깊이 열 수(뿌리 제외). */
  readonly columns: number;
  /** 가장 많은 병렬 구성원 수 = 대형의 행 수. */
  readonly rows: number;
}

const PROGRESS_URGENCY: Record<OperationClusterProgress, number> = { awaiting: 0, running: 1, open: 2, blocked: 3, done: 4 };

export function layoutCluster(cluster: OperationCluster): ClusterLayout {
  const byId = new Map(cluster.members.map((member) => [member.operationId, member]));
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const member = byId.get(id);
    const value = member && member.after.length
      ? Math.max(0, ...member.after.filter((parent) => byId.has(parent)).map((parent) => depthOf(parent, seen) + 1))
      : 0;
    depth.set(id, value);
    return value;
  };
  for (const member of cluster.members) depthOf(member.operationId, new Set());
  const ordered = cluster.members
    .map((member, index) => ({ member, index, depth: depth.get(member.operationId) ?? 0 }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index);
  const rowCounter = new Map<number, number>();
  const members: ClusterLaidMember[] = ordered.map((entry, order) => {
    const row = rowCounter.get(entry.depth) ?? 0;
    rowCounter.set(entry.depth, row + 1);
    return { member: entry.member, depth: entry.depth, row, order };
  });
  return {
    cluster,
    members,
    byOperationId: new Map(members.map((laid) => [laid.member.operationId, laid])),
    columns: members.length ? Math.max(...members.map((laid) => laid.depth)) + 1 : 0,
    rows: Math.max(1, ...[...rowCounter.values()]),
  };
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
    for (const laid of layout.members) if (!memberOf.has(laid.member.operationId) && !rootOf.has(laid.member.operationId)) memberOf.set(laid.member.operationId, { layout, laid });
  }
  return { clusters, layouts, rootOf, memberOf };
}

// 접힘은 시각 상태다 — 세션 안에서만 산다. 묶음은 기본이 접힘이라 뿌리 행과 띠만 보이고, 사람이 편 것만 기억한다.
export interface ClusterFold { readonly expanded: readonly string[] }
export const isClusterCollapsed = (fold: ClusterFold, clusterId: string): boolean => !fold.expanded.includes(clusterId);
let clusterFold: ClusterFold = { expanded: [] };
const collapseListeners = new Set<() => void>();
export function toggleClusterCollapsed(clusterId: string): void {
  clusterFold = { expanded: clusterFold.expanded.includes(clusterId) ? clusterFold.expanded.filter((id) => id !== clusterId) : [...clusterFold.expanded, clusterId] };
  for (const listener of collapseListeners) listener();
}
const subscribeCollapse = (listener: () => void) => { collapseListeners.add(listener); return () => { collapseListeners.delete(listener); }; };
const readFold = () => clusterFold;
export function useClusterFold(): ClusterFold {
  return useSyncExternalStore(subscribeCollapse, readFold, readFold);
}

export function useOperationClusters(): readonly OperationCluster[] {
  const { operationClusters } = usePluginRegistry();
  return useSyncExternalStore(operationClusters.subscribe, operationClusters.get, operationClusters.get);
}

export function useClusterIndex(theaterId?: string | null): ClusterIndex {
  const clusters = useOperationClusters();
  return useMemo(() => indexClusters(theaterId === undefined ? clusters : clusters.filter((cluster) => cluster.theaterId === theaterId)), [clusters, theaterId]);
}

/**
 * 뿌리 뒤에 구성원을 위상 순으로 끼운 순서. 뿌리가 목록에 없으면 구성원은 제자리(평범한 행)에 남고,
 * 목록에 없는 구성원은 건너뛴다 — 다른 Theater 의 Operation 이나 닫힌 Operation 이 그렇다.
 */
export function nestClusterMembers<T>(items: readonly T[], idOf: (item: T) => string, index: ClusterIndex): readonly T[] {
  if (index.clusters.length === 0) return items;
  const byId = new Map(items.map((item) => [idOf(item), item]));
  const nested = new Set<string>();
  for (const item of items) {
    const layout = index.rootOf.get(idOf(item));
    if (!layout) continue;
    for (const laid of layout.members) if (byId.has(laid.member.operationId)) nested.add(laid.member.operationId);
  }
  if (nested.size === 0) return items;
  const out: T[] = [];
  for (const item of items) {
    const id = idOf(item);
    if (nested.has(id)) continue;
    out.push(item);
    const layout = index.rootOf.get(id);
    if (!layout) continue;
    for (const laid of layout.members) { const member = byId.get(laid.member.operationId); if (member) out.push(member); }
  }
  return out;
}

// ── 조율자의 파생 상태 ─────────────────────────────────────────────────────────────────────────────
// 묶음은 화면에서 조율자 하나로 대표된다. 그래서 조율자의 표시 활동은 자기 것이 아니라 묶음에서 가장 급한 것이다 —
// 단계 하나가 사람의 결정을 기다리면 조율자가 「결정 대기」로 서고 War Room 무대에도 조율자가 오른다.
// 사이드바의 단계 행만 각자의 활동을 그대로 보인다.
const ACTIVITY_URGENCY: Record<string, number> = { awaiting: 0, running: 1, background: 2, idle: 3 };

export function clusterRuntimeOverlay(runtime: Readonly<Record<string, OperationRuntimeState>>, index: ClusterIndex): Readonly<Record<string, OperationRuntimeState>> {
  if (index.rootOf.size === 0) return runtime;
  let next: Record<string, OperationRuntimeState> | null = null;
  for (const layout of index.rootOf.values()) {
    const rootId = layout.cluster.root;
    const candidates = [rootId, ...layout.members.map((laid) => laid.member.operationId)]
      .map((id) => runtime[id])
      .filter((state): state is Extract<OperationRuntimeState, { lifecycle: "live" }> => !!state && state.lifecycle === "live");
    if (candidates.length === 0) continue;
    const best = candidates.reduce((top, state) => ((ACTIVITY_URGENCY[state.activity] ?? 9) < (ACTIVITY_URGENCY[top.activity] ?? 9) ? state : top));
    const current = runtime[rootId];
    if (current && current.lifecycle === "live" && current.activity === best.activity) continue;
    if (!current || current.lifecycle !== "live") continue; // 조율자가 휴면이면 그대로 — 살아 있지 않은 것을 살아 있다고 말하지 않는다.
    next ??= { ...runtime };
    next[rootId] = { ...current, activity: best.activity };
  }
  return next ?? runtime;
}

export function useClusterRuntime(runtime: Readonly<Record<string, OperationRuntimeState>>, index: ClusterIndex): Readonly<Record<string, OperationRuntimeState>> {
  return useMemo(() => clusterRuntimeOverlay(runtime, index), [runtime, index]);
}

// ── 구성원 숨김 ────────────────────────────────────────────────────────────────────────────────────
/**
 * 화면에서 접히는 구성원 — Tactical·War Room 에서는 모두, Cruise 에서는 뿌리가 스냅 칸에 붙어 있을 때.
 * 숨은 구성원은 패널을 세우지 않고(본문은 풀에 대기), 조율자 패널이 본문 교체로 그들을 보여 준다.
 */
export function hiddenClusterMembers(index: ClusterIndex, view: { readonly formation: boolean; readonly triage: boolean; readonly snapHeld: (rootId: string) => boolean }): ReadonlySet<string> {
  const hidden = new Set<string>();
  if (index.memberOf.size === 0) return hidden;
  for (const layout of index.rootOf.values()) {
    if (!(view.formation || view.triage || view.snapHeld(layout.cluster.root))) continue;
    for (const laid of layout.members) hidden.add(laid.member.operationId);
  }
  return hidden;
}

// ── 본문 선택 ──────────────────────────────────────────────────────────────────────────────────────
// 조율자 패널이 어느 Operation 의 본문(PTY·채팅뷰)을 보이는가. 세션은 그대로고 마운트만 이 프레임의 슬롯으로 옮겨 온다.
// 세션 안에서만 산다 — 새로 열면 조율자 자신으로 돌아온다.
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

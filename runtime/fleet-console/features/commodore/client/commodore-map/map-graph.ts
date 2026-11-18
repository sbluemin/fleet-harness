import type { IdentityTone } from "../../../workspace/shared/identity-tones.js";
import { MEMORY_BRANCHES, type MemoryBranch, type MemoryEntry } from "../../shared/contracts/memory.js";
import { MEMORY_STALE_MS } from "../../shared/contracts/memory-stale.js";
import type { CommodoreState } from "../../shared/contracts/types.js";

/**
 * 지도 그래프 모델 — 순수 TS. `commodore/state` 한 건과 `commodore/memory` 목록을
 * 노드·연결로 펼친다. 렌더러(three.js·Canvas 2D·궤도)가 함께 읽는 계약이다.
 *
 * 보드 결정 반영:
 * - 499e8035: 정보는 최근 12개만 점, 나머지는 `intel-overflow` 1개(`+N`).
 * - d9c36b41: 정보↔기억을 잇지 않는다. 정보는 출처에만, 기억은 links·같은 목표로만.
 */

export type MapBranchKey = "description" | "intel" | MemoryBranch;

/** 갈래 칩·물리 구역이 함께 쓰는 순서 — 설명·정보·기억 4갈래. */
export const MAP_BRANCH_ORDER: readonly MapBranchKey[] = ["description", "intel", ...MEMORY_BRANCHES];

/** 결정 499e8035 — 점으로 그리는 최근 정보 수. */
export const RECENT_INTEL_LIMIT = 12;
/** 상태 신호 — 이 안에 갱신됐으면 `fresh`. */
export const MAP_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

export type MapNodeKind =
  | "core"
  | "description"
  | "intel-hub"
  | "intel"
  | "intel-overflow"
  | "source"
  | "branch"
  | "topic"
  | "memory"
  | "objective";

export type MapEdgeKind = "tree" | "link" | "objective" | "source";

export interface MapNode {
  readonly id: string;
  readonly kind: MapNodeKind;
  /** 갈래 칩이 가리는 단위. 핵만 null(항상 보임). */
  readonly branch: MapBranchKey | null;
  /** 짧은 표기 — 검색·DOM 이름표가 읽는다. 정보는 본문 앞부분. */
  readonly label: string;
  /** 검색 본문(제목·설명·topic). 핵 등은 빈 문자열. */
  readonly text: string;
  /** 최근 7일 갱신 — 렌더러가 발광으로만 알린다(신호 토큰 aurora는 팔레트 몫). */
  readonly fresh: boolean;
  /** 30일 미검증 — `MEMORY_STALE_MS` 재사용, 기억에만 선다. */
  readonly stale: boolean;
  /** 기억 항목의 ref (`memory`). */
  readonly ref?: string;
  /** 정보 항목의 id·시각 (`intel`). */
  readonly intelId?: string;
  readonly at?: number;
  /** 출처 id (`source`). `person`은 사람이 넣은 묶음. */
  readonly sourceId?: string;
  /** 주제 이름 (`topic`). */
  readonly topic?: string;
  /** 같은 목표를 가리킨 기억이 2개 이상일 때만 서는 목표 노드의 id (`objective`). */
  readonly objectiveId?: string;
  /** 묶음에 든 정보 id 전체 — 오래된 순 (`intel-overflow`, 상세 패널이 읽는다). */
  readonly overflowIds?: readonly string[];
  /** 핵의 정체성 톤 — 입력 그대로 둔다. 핵에만 선다. */
  readonly tone?: IdentityTone | null;
}

export interface MapEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: MapEdgeKind;
}

export interface MapGraph {
  readonly nodes: readonly MapNode[];
  readonly edges: readonly MapEdge[];
  readonly byId: ReadonlyMap<string, MapNode>;
  /** 이웃 찾기(호버·검색 확장) — 렌더러·DOM 층이 함께 읽는다. */
  readonly adjacent: ReadonlyMap<string, readonly string[]>;
  /** 갈래별 노드 수(칩 표시용, 핵 제외). */
  readonly branchCounts: Readonly<Record<MapBranchKey, number>>;
  readonly intelTotal: number;
  readonly intelShown: number;
}

export interface MapGraphInput {
  readonly state: CommodoreState;
  readonly memories: readonly MemoryEntry[];
  /** 핵 색(아바타 책). null이면 기본 — 모델은 색값을 모른다(팔레트 몫). */
  readonly tone: IdentityTone | null;
  /** 상태 신호 기준 시각. 기본 `Date.now()`. */
  readonly now?: number;
  /** 명시 링크 연결을 뺀다 — 링크 칩 끄기용. 렌더러 계약을 바꾸지 않고 화면에서 가린다. 기본 true. */
  readonly links?: boolean;
  /**
   * 화면 언어로 읽히는 표시 이름 — 캔버스에 갈래 키(`person` 등)가 보이지 않게
   * 렌더러는 `label`을 그대로 그린다. 없으면 영어 키 그대로 둔다.
   */
  readonly labels?: MapDisplayLabels;
}

/** 표시 이름 해석기 — 화면 i18n이 건넨다. */
export interface MapDisplayLabels {
  readonly description: string;
  readonly intelHub: string;
  readonly branch: (branch: MemoryBranch) => string;
  /** 사람 묶음 출처 노드 — 기본 키 그대로 두지 않는다. */
  readonly personSource: string;
  /** 출처 노드 겉이름 — aria·화면·캔버스·상세가 같은 말을 쓴다. */
  readonly source: (label: string) => string;
}

const PERSON_SOURCE = "person";

function excerpt(text: string, limit = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * 상세 패널이 고른 id를 노드로 푼다. 그래프에 점이 없는 대상도 상세는 낸다 —
 * 묶음(`+N`)에 든 오래된 정보, 기억 하나만 가리킨 목표. 그 밖의 모르는 id는 null.
 */
export function resolveMapDetailNode(
  graph: MapGraph,
  id: string,
  state: CommodoreState,
  memories: readonly MemoryEntry[],
  now = Date.now(),
): MapNode | null {
  const node = graph.byId.get(id);
  if (node) return node;
  if (id.startsWith("intel:")) {
    const item = state.intel.find((candidate) => `intel:${candidate.id}` === id);
    if (!item) return null;
    return {
      id, kind: "intel", branch: "intel",
      label: excerpt(item.text), text: item.text,
      fresh: now - item.at <= MAP_RECENT_MS, stale: false,
      intelId: item.id, at: item.at,
    };
  }
  if (id.startsWith("obj:")) {
    const objectiveId = id.slice("obj:".length);
    const entry = memories.find((candidate) => candidate.sources.some((source) => source.objectiveId === objectiveId));
    const source = entry?.sources.find((candidate) => candidate.objectiveId === objectiveId);
    if (!entry || !source) return null;
    return {
      id, kind: "objective", branch: entry.branch,
      label: source.title, text: "", fresh: false, stale: false, objectiveId,
    };
  }
  return null;
}

export function buildMapGraph(input: MapGraphInput): MapGraph {
  const now = input.now ?? Date.now();
  const { state } = input;
  const labels: MapDisplayLabels = input.labels ?? {
    description: "description",
    intelHub: "intel",
    branch: (branch) => branch,
    personSource: "person",
    source: (label) => label,
  };
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const seen = new Set<string>();
  const link = (from: string, to: string, kind: MapEdgeKind) => {
    const key = `${from} ${to} ${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind });
  };

  const alias = state.alias?.trim() || "";
  nodes.push({
    id: "core", kind: "core", branch: null,
    label: alias || "commodore", text: state.description.text,
    fresh: false, stale: false, tone: input.tone ?? null,
  });

  // 설명 가지 — rev 증가가 핵 주위 성장 표시의 원천이라 updatedAt 신호를 둔다.
  nodes.push({
    id: "desc", kind: "description", branch: "description",
    label: labels.description, text: state.description.text,
    fresh: now - state.description.updatedAt <= MAP_RECENT_MS, stale: false,
  });
  link("core", "desc", "tree");

  // 정보 가지 — 결정 499e8035: 최근 12개만 점, 나머지는 묶음 1개.
  nodes.push({ id: "intel", kind: "intel-hub", branch: "intel", label: labels.intelHub, text: "", fresh: false, stale: false });
  link("core", "intel", "tree");
  const byAt = [...state.intel].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
  const shown = byAt.slice(0, RECENT_INTEL_LIMIT);
  const rest = byAt.slice(RECENT_INTEL_LIMIT);
  for (const item of shown) {
    const id = `intel:${item.id}`;
    nodes.push({
      id, kind: "intel", branch: "intel",
      label: excerpt(item.text), text: item.text,
      fresh: now - item.at <= MAP_RECENT_MS, stale: false,
      intelId: item.id, at: item.at,
    });
    link("intel", id, "tree");
  }
  if (rest.length > 0) {
    nodes.push({
      id: "intel-overflow", kind: "intel-overflow", branch: "intel",
      label: `+${rest.length}`, text: "",
      fresh: false, stale: false,
      overflowIds: rest.map((item) => item.id),
    });
    link("intel", "intel-overflow", "tree");
  }

  // 출처 — 결정 d9c36b41: 정보는 출처 노드에만 잇는다. 사람 묶음·없는 id도 노드는 세운다.
  const sourceIds = new Set<string>(state.sources.map((source) => source.id));
  for (const item of state.intel) sourceIds.add(item.source);
  const sourceLabel = new Map(state.sources.map((source) => [source.id, source.label] as const));
  for (const sourceId of [...sourceIds].sort()) {
    const id = `src:${sourceId}`;
    const bare = sourceId === PERSON_SOURCE ? labels.personSource : (sourceLabel.get(sourceId) ?? sourceId);
    nodes.push({
      id, kind: "source", branch: "intel",
      label: labels.source(bare),
      text: "", fresh: false, stale: false, sourceId,
    });
    link("intel", id, "tree");
  }
  for (const item of shown) link(`intel:${item.id}`, `src:${item.source}`, "source");

  // 기억 4갈래 — 허브 → 주제 → 항목. 결정 d9c36b41: 기억끼리는 links·같은 목표로만.
  for (const branch of MEMORY_BRANCHES) {
    nodes.push({ id: `mem:${branch}`, kind: "branch", branch, label: labels.branch(branch), text: "", fresh: false, stale: false });
    link("core", `mem:${branch}`, "tree");
  }
  const topics = new Map<string, { branch: MemoryBranch; topic: string }>();
  for (const entry of input.memories) {
    const key = `${entry.branch} ${entry.topic}`;
    if (!topics.has(key)) topics.set(key, { branch: entry.branch, topic: entry.topic });
  }
  for (const { branch, topic } of [...topics.values()].sort((a, b) => a.branch.localeCompare(b.branch) || a.topic.localeCompare(b.topic))) {
    const id = `topic:${branch}:${topic}`;
    nodes.push({ id, kind: "topic", branch, label: topic, text: topic, fresh: false, stale: false, topic });
    link(`mem:${branch}`, id, "tree");
  }
  const refIds = new Set(input.memories.map((entry) => entry.ref));
  const withLinks = input.links ?? true;
  for (const entry of input.memories) {
    const id = `mem:${entry.ref}`;
    nodes.push({
      id, kind: "memory", branch: entry.branch,
      label: entry.title, text: `${entry.title}\n${entry.topic}\n${entry.description}`,
      fresh: now - entry.updated <= MAP_RECENT_MS,
      stale: now - entry.verified > MEMORY_STALE_MS,
      ref: entry.ref, topic: entry.topic,
    });
    link(`topic:${entry.branch}:${entry.topic}`, id, "tree");
    if (withLinks) {
      for (const target of entry.links) {
        if (refIds.has(target)) {
          const a = `mem:${entry.ref}`;
          const b = `mem:${target}`;
          link(a < b ? a : b, a < b ? b : a, "link");
        }
      }
    }
  }

  // 같은 목표 — 2개 이상이 같은 objectiveId를 가리킬 때만 목표 노드를 세워 잇는다.
  const byObjective = new Map<string, MemoryEntry[]>();
  for (const entry of input.memories) {
    for (const source of entry.sources) {
      const list = byObjective.get(source.objectiveId) ?? [];
      list.push(entry);
      byObjective.set(source.objectiveId, list);
    }
  }
  for (const [objectiveId, entries] of [...byObjective].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const unique = [...new Map(entries.map((entry) => [entry.ref, entry])).values()];
    if (unique.length < 2) continue;
    const id = `obj:${objectiveId}`;
    const branch = unique[0]!.branch;
    nodes.push({
      id, kind: "objective", branch,
      label: unique[0]!.sources.find((source) => source.objectiveId === objectiveId)?.title ?? objectiveId,
      text: "", fresh: false, stale: false, objectiveId,
    });
    for (const entry of unique.sort((a, b) => (a.ref < b.ref ? -1 : 1))) link(id, `mem:${entry.ref}`, "objective");
  }

  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const adjacent = new Map<string, string[]>();
  for (const node of nodes) adjacent.set(node.id, []);
  for (const edge of edges) {
    adjacent.get(edge.from)?.push(edge.to);
    adjacent.get(edge.to)?.push(edge.from);
  }
  const frozenAdjacent = new Map<string, readonly string[]>([...adjacent].map(([id, list]) => [id, Object.freeze([...new Set(list)].sort())] as const));
  const branchCounts = { description: 0, intel: 0, person: 0, theater: 0, lessons: 0, crew: 0 } as Record<MapBranchKey, number>;
  for (const node of nodes) {
    if (node.branch !== null) branchCounts[node.branch] += 1;
  }
  return {
    nodes: Object.freeze(nodes), edges: Object.freeze(edges), byId,
    adjacent: frozenAdjacent, branchCounts: Object.freeze(branchCounts),
    intelTotal: state.intel.length, intelShown: shown.length,
  };
}

/** 검색 — 제목·설명·topic을 대소문자 없이 찾는다. 빈 질의는 null(제한 없음). */
export function matchMapQuery(graph: MapGraph, query: string): ReadonlySet<string> | null {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return null;
  const hits = new Set<string>();
  for (const node of graph.nodes) {
    if (`${node.label}\n${node.text}`.toLocaleLowerCase().includes(needle)) hits.add(node.id);
  }
  return hits;
}

/** 호버 이웃 — 직접 연결된 노드 전부. */
export function mapNeighbors(graph: MapGraph, id: string): ReadonlySet<string> {
  return new Set(graph.adjacent.get(id) ?? []);
}

/** 종류 단추 — 갈래 여섯, 같은 목표 노드, 명시 링크. */
export type MapChipKey = MapBranchKey | "objective" | "link";

/**
 * 보이는 노드 — 종류 단추는 '고르기'다. 아무것도 고르지 않으면 전부 서고, 고르면 고른 종류(와 핵, 그 점까지
 * 이어지는 허브·주제)만 선다. 목표는 그 목표 노드와 이어진 기억, 명시 링크는 링크 양 끝 기억을 세운다.
 * 검색 중이면 그 안에서 맞은 점과 그 이웃만 선다. 핵은 항상 선다.
 */
export function visibleMapIds(
  graph: MapGraph,
  picks: ReadonlySet<MapChipKey>,
  hits: ReadonlySet<string> | null,
): ReadonlySet<string> {
  let picked: Set<string> | null = null;
  if (picks.size > 0) {
    picked = new Set<string>();
    for (const node of graph.nodes) {
      if (node.branch === null) picked.add(node.id);
      else if (node.kind === "objective" ? picks.has("objective") : picks.has(node.branch)) picked.add(node.id);
    }
    for (const edge of graph.edges) {
      if ((edge.kind === "objective" && picks.has("objective")) || (edge.kind === "link" && picks.has("link"))) {
        picked.add(edge.from);
        picked.add(edge.to);
      }
    }
    // 고른 점이 핵에서 떨어져 떠 있지 않게 나무 위쪽(허브·주제)을 함께 세운다.
    const parent = new Map<string, string>();
    for (const edge of graph.edges) if (edge.kind === "tree") parent.set(edge.to, edge.from);
    for (const id of [...picked]) {
      let up = parent.get(id);
      while (up !== undefined && !picked.has(up)) {
        picked.add(up);
        up = parent.get(up);
      }
    }
  }
  const visible = new Set<string>();
  for (const node of graph.nodes) {
    if (picked !== null && !picked.has(node.id)) continue;
    if (hits !== null && node.branch !== null && !hits.has(node.id)) {
      const near = graph.adjacent.get(node.id) ?? [];
      if (!near.some((other) => hits.has(other))) continue;
    }
    visible.add(node.id);
  }
  return visible;
}

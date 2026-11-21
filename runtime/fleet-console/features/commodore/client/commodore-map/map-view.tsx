import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Translate } from "@fleet-console/i18n";
import { PlusGlyph } from "@fleet-console/ui/react";

import { useAvatarToneOf } from "../../../workspace/client/avatar-accent.js";
import { commodoreAvatarKey } from "../../../workspace/shared/avatars.js";
import { useGlobalSettingsStore, getGlobalSettingsStoreState } from "../../../settings/client/global-settings-store.js";
import type { CommodoreState } from "../../shared/contracts/types.js";
import type { MemoryBranch } from "../../shared/contracts/memory.js";
import { loadCommodoreMemory, useCommodoreMemory } from "../commodore-state.js";
import { MEMORY_BRANCH_LABEL } from "../commodore-memory.js";
import type { CommodoreMessageKey } from "../i18n/index.js";
import {
  buildMapGraph,
  resolveMapDetailNode,
  matchMapQuery,
  visibleMapIds,
  type MapBranchKey,
  type MapChipKey,
  type MapNode,
} from "./map-graph.js";
import { MapPanel, mapDisplayLabels, type MapPanelEditors, type MapPanelFacts } from "./map-panel.js";
import { setCommodoreMapSelection, useCommodoreMapSelection } from "../commodore-map-mode.js";
import { layoutMapGraph } from "./map-layout.js";
import {
  chooseMapRendererKind,
  detectMapRendererEnv,
  mountMapRenderer,
  type MapRenderer,
  type MapRendererKind,
} from "./map-renderers.js";
import { readMapPalette } from "./map-palette.js";
import "./map-view.css";

type T = Translate<CommodoreMessageKey>;

/** OS 감속 모션 — onboarding의 같은 훅과 한 벌이다(기능이 달라 사본을 둔다). */
function useOsReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function nodeAria(t: T, node: MapNode, branchName: (branch: MemoryBranch) => string, intelTotal: number): string {
  switch (node.kind) {
    case "core": return t("commodore.map.node.core", { name: node.label });
    case "description": return t("commodore.map.node.description");
    case "intel-hub": return t("commodore.map.node.intelHub");
    case "intel": return t("commodore.map.node.intel", { title: node.label });
    case "intel-overflow": return t("commodore.map.allIntelCount", { n: intelTotal });
    case "source": return node.label;
    case "branch": return t("commodore.map.node.branch", { branch: node.branch ? branchName(node.branch as MemoryBranch) : node.label });
    case "topic": return t("commodore.map.node.topic", { topic: node.topic ?? node.label });
    case "memory": return t("commodore.map.node.memory", { title: node.label });
    case "objective": return t("commodore.map.node.objective", { title: node.label });
  }
}

/** 돋보기 — 지도 안 검색의 자리표이자 휴대폰 폭에서 입력을 펴는 단추. */
function SearchGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </svg>
  );
}

/** 맞춤 보기 — 네 모서리 틀 안의 점: 지도 전체를 틀에 맞춘다. */
function FitGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 무대 위에 겹친 조작 층 — 여기서 난 클릭은 지도 고르기로 넘기지 않는다. */
const STAGE_OVERLAY = ".commodore-map-node, .commodore-map-top, .commodore-map-legend, .commodore-map-notice, .commodore-map-stage-panel";
/** 이 거리(px) 이상 움직인 포인터는 회전·이동 끌기라 release 클릭에서 선택을 바꾸지 않는다. */
const STAGE_DRAG_THRESHOLD_PX = 4;

function isHubKind(kind: MapNode["kind"]): boolean {
  return kind === "core" || kind === "description" || kind === "intel-hub" || kind === "intel-overflow" || kind === "branch" || kind === "source";
}

function branchChipLabel(t: T, branch: MapBranchKey): string {
  if (branch === "description") return t("commodore.description.label");
  if (branch === "intel") return t("commodore.intel.label");
  return t(MEMORY_BRANCH_LABEL[branch]);
}

/**
 * 사령관 지도 화면 — 대화 영역 전체를 차지한다. 그리기·고르기·화면 좌표는
 * MapRenderer 계약에만 기대고, 종류는 환경(모바일·동작 줄이기·WebGL2)으로 고른다.
 * 렌더러 로드·mount 실패는 안내를 둔다. 닫히면 dispose로 반납한다.
 */
export function CommodoreMapScreen({ t, commodoreId, state, facts, onExit, onNodeActivate, onQuickEdit, showPanel, floatingPanel, editors, onPanelClear, failureLine }: {
  readonly t: T;
  readonly commodoreId: string;
  readonly state: CommodoreState;
  readonly facts: MapPanelFacts;
  readonly onExit: () => void;
  /** 점을 골랐을 때 상세를 보여 줄 수 있도록 호출한다. */
  readonly onNodeActivate?: () => void;
  /** 빈 상태 안내의 「+ 설명 추가 / + 정보 추가」에서 한 번에 편집까지 연다. */
  readonly onQuickEdit?: (target: "desc" | "intel") => void;
  /** 모바일처럼 레일이 없으면 상세 패널을 무대 아래에 둔다. 기본은 두지 않는다. */
  readonly showPanel?: boolean;
  /** 데스크톱 대화 화면 — 상세·편집 패널을 무대 우측 안쪽에 접기 가능한 글래스 시트로 띄운다. */
  readonly floatingPanel?: boolean;
  /** 데스크톱 부유 인스펙터에 넘기는 설명·정보 편집기. */
  readonly editors?: (pickedIntelId: string | null) => MapPanelEditors;
  /** 패널 선택·닫기 시 상위 오류 줄을 비운다. */
  readonly onPanelClear?: () => void;
  /** 편집 오류 줄. */
  readonly failureLine?: ReactNode;
}) {
  const memory = useCommodoreMemory(commodoreId);
  const toneOf = useAvatarToneOf();
  const coreTone = toneOf(commodoreAvatarKey(commodoreId));
  const settings = useGlobalSettingsStore();
  const osReduced = useOsReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const floatingPanelRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<MapRenderer | null>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const tagRefs = useRef(new Map<string, HTMLDivElement>());
  const rovingRef = useRef<string | null>(null);
  const hoverRafRef = useRef(0);
  const dragRef = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  // 종류 단추는 고르기다 — 비어 있으면 전부, 고르면 고른 종류만 선다.
  const [picks, setPicks] = useState<ReadonlySet<MapChipKey>>(() => new Set());
  const [query, setQuery] = useState("");
  // 휴대폰 폭에서는 돋보기만 두고 누르면 입력을 편다(질의가 있으면 늘 펴 둔다).
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  useEffect(() => { setInspectorOpen(true); }, [commodoreId]);
  // 선택은 사령관별 저장소와 동기화한다.
  const selectedId = useCommodoreMapSelection(commodoreId);
  const setSelectedId = useCallback((next: string | null) => {
    onPanelClear?.();
    setCommodoreMapSelection(commodoreId, next);
  }, [commodoreId, onPanelClear]);
  const selectNode = useCallback((next: string | null) => {
    onPanelClear?.();
    setCommodoreMapSelection(commodoreId, next);
    if (next !== null) {
      if (floatingPanel) setInspectorOpen(true);
      onNodeActivate?.();
    }
  }, [commodoreId, floatingPanel, onNodeActivate, onPanelClear]);
  const triggerQuickEdit = useCallback((target: "desc" | "intel") => {
    onPanelClear?.();
    if (floatingPanel) setInspectorOpen(true);
    if (onQuickEdit) onQuickEdit(target);
    else selectNode(target);
  }, [floatingPanel, onPanelClear, onQuickEdit, selectNode]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  // (a) D4 DOM 라벨 층은 WebGL일 때만 — 궤도는 캔버스에 직접 그린다.
  const [rendererKind, setRendererKind] = useState<MapRendererKind | null>(null);
  const [paletteTick, setPaletteTick] = useState(0);
  const [isMobile, setIsMobile] = useState(
    () => typeof document !== "undefined" && document.documentElement.dataset.viewMode === "mobile",
  );
  const trackRaf = useRef(0);
  const trackTail = useRef(0);
  const reduced = osReduced || getGlobalSettingsStoreState().state?.reduceMotion === true || settings.state?.reduceMotion === true;
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  const branchName = useCallback((branch: MemoryBranch): string => t(MEMORY_BRANCH_LABEL[branch]), [t]);
  const labels = useMemo(() => mapDisplayLabels(t, branchName), [t, branchName]);
  // 배치는 링크까지 든 전체 그래프로 한 번만 잡는다 — 종류를 골라 링크가 빠져도 점이 튀어 옮겨 가지 않는다.
  const fullGraph = useMemo(
    () => buildMapGraph({ state, memories: memory.entries, tone: coreTone, labels }),
    [state, memory.entries, coreTone, labels],
  );
  const showLinks = picks.size === 0 || picks.has("link");
  const graph = useMemo(
    () => (showLinks ? fullGraph : buildMapGraph({ state, memories: memory.entries, tone: coreTone, labels, links: false })),
    [showLinks, fullGraph, state, memory.entries, coreTone, labels],
  );
  const layout = useMemo(() => layoutMapGraph(fullGraph), [fullGraph]);
  const model = useMemo(() => ({ graph, layout }), [graph, layout]);
  const hits = useMemo(() => matchMapQuery(graph, query), [graph, query]);
  const visible = useMemo(() => visibleMapIds(graph, picks, hits), [graph, picks, hits]);
  const palette = useMemo(
    () => readMapPalette(typeof document === "undefined" ? null : document.documentElement, coreTone),
    [paletteTick, coreTone],
  );
  // 칩 숫자는 노드 수가 아니라 기억·정보 개수다. 목표·링크는 그래프 개수.
  const chipCounts = useMemo(() => {
    const counts: Record<MapBranchKey, number> = { description: 0, intel: 0, person: 0, theater: 0, lessons: 0, crew: 0 };
    counts.description = state.description.text === "" ? 0 : 1;
    counts.intel = state.intel.length;
    for (const entry of memory.entries) counts[entry.branch] += 1;
    return counts;
  }, [state.description.text, state.intel.length, memory.entries]);
  const objectiveCount = useMemo(() => graph.nodes.filter((node) => node.kind === "objective").length, [graph]);
  const linkCount = useMemo(() => fullGraph.edges.filter((edge) => edge.kind === "link").length, [fullGraph]);
  const isEmpty = state.description.text === "" && graph.intelTotal === 0 && memory.entries.length === 0;
  // 고른 정보 항목을 지웠으면 요약으로 튕기지 않고 정보 허브에 머문다.
  const missingPickedIntel = selectedId !== null
    && selectedId.startsWith("intel:")
    && !state.intel.some((item) => `intel:${item.id}` === selectedId);
  useEffect(() => {
    if (missingPickedIntel) setCommodoreMapSelection(commodoreId, "intel");
  }, [missingPickedIntel, commodoreId]);
  const effectiveSelectedId = missingPickedIntel ? "intel" : selectedId;
  const selectedNode = effectiveSelectedId ? resolveMapDetailNode(graph, effectiveSelectedId, state, memory.entries) : null;
  const selected: { readonly node: MapNode } | null = selectedNode ? { node: selectedNode } : null;
  const pickedIntelId = selectedNode?.kind === "intel" ? (selectedNode.intelId ?? null) : null;
  const floatingVisible = floatingPanel === true && inspectorOpen;
  // 오래된 정보(+N 묶음 안)를 고르면 캔버스에서는 `+N` 묶음 점을 강조한다.
  const canvasSelectionId = useMemo((): string | null => {
    if (selectedId === null) return null;
    if (graph.byId.has(selectedId)) return selectedId;
    if (selectedId.startsWith("intel:") && graph.byId.has("intel-overflow")) return "intel-overflow";
    return selectedId;
  }, [selectedId, graph]);
  // 캔버스 초점 — 호버 우선, 없으면 선택. 가려진 점은 초점으로 삼지 않는다.
  const activeFocusId = useMemo((): string | null => {
    if (hoveredId !== null && visible.has(hoveredId)) return hoveredId;
    if (canvasSelectionId !== null && visible.has(canvasSelectionId)) return canvasSelectionId;
    return null;
  }, [hoveredId, canvasSelectionId, visible]);
  const focusSet = useMemo((): ReadonlySet<string> | null => {
    if (activeFocusId === null) return null;
    const set = new Set<string>([activeFocusId]);
    for (const neighbor of graph.adjacent.get(activeFocusId) ?? []) set.add(neighbor);
    return set;
  }, [activeFocusId, graph]);
  // D6 — 노드 층의 Tab 정지점은 하나로, 방향키로 옮겨 다닌다.
  const orderedIds = useMemo(() => [...visible], [visible]);
  const [roving, setRoving] = useState<string | null>(null);
  const rovingId = roving !== null && visible.has(roving)
    ? roving
    : (selectedId !== null && visible.has(selectedId) ? selectedId : (orderedIds[0] ?? null));
  rovingRef.current = rovingId;
  // 7 — 검색 일치 잎 라벨(상한 60, 겹치면 컬링).
  const hitLabelIds = useMemo((): readonly string[] => {
    if (!hits) return [];
    const out: string[] = [];
    for (const id of orderedIds) {
      if (out.length >= 60) break;
      if (!hits.has(id)) continue;
      const kind = graph.byId.get(id)?.kind;
      if (kind === "memory" || kind === "intel") out.push(id);
    }
    return out;
  }, [hits, orderedIds, graph]);
  const hitLabelSet = useMemo(() => new Set(hitLabelIds), [hitLabelIds]);
  // 호버·선택 점은 잎이어도 이름표를 띄운다. 이웃은 뼈대(허브·주제·출처·묶음)를 우선 띄우고,
  // 잎끼리 직접 연결된 경우에만 잎 이웃 이름표를 함께 띄워 허브 선택 시 잎 라벨 난립을 막는다.
  const focusLabelSet = useMemo((): ReadonlySet<string> => {
    if (!focusSet || activeFocusId === null) return new Set();
    const out = new Set<string>();
    if (visible.has(activeFocusId)) out.add(activeFocusId);
    const activeKind = graph.byId.get(activeFocusId)?.kind;
    const activeIsLeaf = activeKind === "memory" || activeKind === "intel" || activeKind === "objective";
    let extra = 0;
    for (const id of focusSet) {
      if (id === activeFocusId || !visible.has(id)) continue;
      const kind = graph.byId.get(id)?.kind;
      if (!kind) continue;
      const isLeaf = kind === "memory" || kind === "intel" || kind === "objective";
      if (isLeaf && !activeIsLeaf) continue;
      if (extra >= 16) break;
      out.add(id);
      extra += 1;
    }
    return out;
  }, [focusSet, activeFocusId, visible, graph]);

  const modelRef = useRef(model);
  modelRef.current = model;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const canvasSelectionRef = useRef(canvasSelectionId);
  canvasSelectionRef.current = canvasSelectionId;
  const activeFocusRef = useRef(activeFocusId);
  activeFocusRef.current = activeFocusId;
  const focusSetRef = useRef(focusSet);
  focusSetRef.current = focusSet;
  const hitLabelsRef = useRef<readonly string[]>([]);
  hitLabelsRef.current = hitLabelIds;
  const focusLabelSetRef = useRef<ReadonlySet<string>>(focusLabelSet);
  focusLabelSetRef.current = focusLabelSet;
  const paletteRef = useRef(palette);
  paletteRef.current = palette;

  // D4 — 핵·허브 라벨은 항상, 호버·선택 점은 최우선, 이웃·주제·검색 일치는 겹치지 않을 때만 DOM 층에 띄운다.
  // 렌더러를 고치지 않고 project 좌표를 읽으므로 끌기·확대 때 따라 움직인다.
  const syncPositions = useCallback((): void => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    try {
      const spots = new Map<string, { x: number; y: number }>();
      const hubSpots: { id: string; x: number; y: number }[] = [];
      for (const [id, element] of buttonRefs.current) {
        if (!visibleRef.current.has(id)) {
          element.style.display = "none";
          continue;
        }
        element.style.display = "";
        const point = renderer.project(id);
        if (!point || !point.visible) {
          element.style.visibility = "hidden";
          element.tabIndex = -1;
          element.setAttribute("aria-hidden", "true");
        } else {
          element.style.visibility = "";
          element.tabIndex = id === rovingRef.current ? 0 : -1;
          element.removeAttribute("aria-hidden");
          element.style.transform = `translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px) translate(-50%, -50%)`;
          spots.set(id, point);
          const kind = modelRef.current.graph.byId.get(id)?.kind;
          if (kind && isHubKind(kind)) hubSpots.push({ id, x: point.x, y: point.y });
        }
      }
      const focusIdNow = activeFocusRef.current;
      const focusNow = focusSetRef.current;
      const stageW = containerRef.current?.clientWidth ?? 0;
      const shown: { x0: number; y0: number; x1: number; y1: number }[] = [];
      const placed = new Set<string>();
      const rectOf = (x: number, y: number, w: number): { x0: number; y0: number; x1: number; y1: number } => ({ x0: x, y0: y - 10, x1: x + w, y1: y + 10 });
      const near = (rect: { x0: number; y0: number; x1: number; y1: number }): boolean => shown.some((spot) => rect.x0 < spot.x1 && spot.x0 < rect.x1 && rect.y0 < spot.y1 && spot.y0 < rect.y1);
      // 점 무리에 묻힌 이름표는 읽히지 않으니 세우지 않는다.
      const crowded = (id: string, x: number, y: number): boolean => {
        for (const [other, spot] of spots) {
          if (other === id) continue;
          if (Math.hypot(spot.x - x, spot.y - y) < 30) return true;
        }
        return false;
      };
      const hitsHub = (id: string, rect: { x0: number; y0: number; x1: number; y1: number }, pad = 14): boolean =>
        hubSpots.some((spot) => spot.id !== id && spot.x > rect.x0 - pad && spot.x < rect.x1 + pad && spot.y > rect.y0 - pad && spot.y < rect.y1 + pad);
      const place = (id: string, node: MapNode, lift: number, always: boolean, allowCrowded = false): void => {
        if (placed.has(id)) return;
        const element = tagRefs.current.get(id);
        const point = spots.get(id);
        if (!element || !point) return;
        const w = Math.min(220, node.label.length * 7.5 + 10);
        const maxX = Math.max(4, stageW - w - 4);
        let x = Math.max(4, Math.min(point.x + lift, maxX));
        let y = point.y;
        let rect = rectOf(x, y, w);
        // 출처 이름표는 바로 오른쪽의 허브(설명 등)나 줄기를 덮기 쉬우므로, 닿으면 구슬 위쪽 빈 자리에 얹는다.
        if (node.kind === "source" && hitsHub(id, rect, 32)) {
          const aboveX = Math.max(4, Math.min(point.x - w / 2, maxX));
          const aboveY = point.y - 22;
          const aboveRect = rectOf(aboveX, aboveY, w);
          if (aboveY >= 20 && !hitsHub(id, aboveRect, 18)) {
            x = aboveX;
            y = aboveY;
            rect = aboveRect;
          } else {
            const leftX = point.x - lift - w;
            if (leftX >= 4) {
              const leftRect = rectOf(leftX, y, w);
              if (!hitsHub(id, leftRect, 18)) {
                x = leftX;
                rect = leftRect;
              }
            }
          }
        }
        if (!always && (near(rect) || (!allowCrowded && crowded(id, x, y)))) {
          element.style.display = "none";
          return;
        }
        element.style.display = "";
        element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(0, -50%)`;
        if (focusNow !== null && !focusNow.has(id)) element.dataset.dim = "true";
        else delete element.dataset.dim;
        if (id === focusIdNow) element.dataset.focus = "true";
        else delete element.dataset.focus;
        shown.push(rect);
        placed.add(id);
      };
      for (const [id, element] of tagRefs.current) {
        if (!spots.has(id)) element.style.display = "none";
      }
      // 1) 지금 가리키거나 고른 점의 이름표를 가장 먼저 세운다(가려지지 않음).
      if (focusIdNow !== null && visibleRef.current.has(focusIdNow)) {
        const focusNode = modelRef.current.graph.byId.get(focusIdNow);
        if (focusNode) place(focusIdNow, focusNode, focusNode.kind === "core" ? 22 : isHubKind(focusNode.kind) ? 18 : 14, true, true);
      }
      // 2) 핵·갈래 허브 이름표.
      for (const id of visibleRef.current) {
        const node = modelRef.current.graph.byId.get(id);
        if (!node || !isHubKind(node.kind)) continue;
        place(id, node, node.kind === "core" ? 20 : 16, true);
      }
      // 3) 초점 점과 직접 연결된 이웃(목표·기억·주제·정보) 이름표 — 겹치지 않을 때만.
      for (const id of focusLabelSetRef.current) {
        if (placed.has(id) || !visibleRef.current.has(id)) continue;
        const node = modelRef.current.graph.byId.get(id);
        if (!node) continue;
        place(id, node, 12, false, true);
      }
      // 4) 주제·검색 일치 이름표.
      for (const id of visibleRef.current) {
        if (placed.has(id)) continue;
        const node = modelRef.current.graph.byId.get(id);
        if (!node) continue;
        if (node.kind !== "topic" && !hitLabelsRef.current.includes(id)) continue;
        place(id, node, 12, false);
      }
    } catch {
      /* project 실패는 그 프레임을 건너뛴다 */
    }
  }, []);

  const stopTracking = useCallback((): void => {
    cancelAnimationFrame(trackRaf.current);
    trackRaf.current = 0;
    window.clearTimeout(trackTail.current);
  }, []);

  const trackMotion = useCallback((tailMs: number): void => {
    stopTracking();
    const tick = (): void => {
      syncPositions();
      trackRaf.current = requestAnimationFrame(tick);
    };
    trackRaf.current = requestAnimationFrame(tick);
    if (tailMs < Infinity) trackTail.current = window.setTimeout(stopTracking, tailMs);
  }, [stopTracking, syncPositions]);

  // 테마·보기 방식 전환 — 토큰을 다시 읽어 렌더러에 갈아끼우고, 모바일 전환 시 렌더러를 바꾼다.
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setPaletteTick((tick) => tick + 1);
      setIsMobile(root.dataset.viewMode === "mobile");
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-mobile-scheme", "data-view-mode"] });
    return () => observer.disconnect();
  }, []);

  // (b) setFitInsets는 마운트·크기·부유 인스펙터 열림/닫힘 변경 때 갱신한다.
  // 데스크톱 부유 인스펙터가 열려 있으면 패널 폭(+우측 12px·숨구멍 24px)만큼 오른쪽 여백을 비워
  // 그래프와 맞춤 보기(Fit)가 인스펙터 아래로 가려지지 않게 한다.
  const applyInsets = useCallback((): void => {
    const topH = topRef.current?.offsetHeight ?? 52;
    const panelW = floatingVisible ? (floatingPanelRef.current?.offsetWidth ?? 316) : 0;
    rendererRef.current?.setFitInsets?.({
      top: topH + 20,
      right: panelW > 0 ? panelW + 36 : 24,
      bottom: 56,
      left: 24,
    });
  }, [floatingVisible]);
  const applyInsetsRef = useRef(applyInsets);
  applyInsetsRef.current = applyInsets;

  // 생성·반납 — 비어 있어도 핵심·갈래 허브 뼈대는 그려 설명·정보를 바로 눌러 편집할 수 있게 한다.
  // 보기 변화 알림(onViewChange)이 오면 DOM 층을 다시 읽는다. 첫 그림·맞춤 트윈이
  // 비동기라 마운트 직후에는 짧게 따라가며 동기화한다(수정 4 D1).
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host || !memory.loaded || memory.failed) return;
    let cancelled = false;
    let owned: MapRenderer | null = null;
    let offView: (() => void) | null = null;
    const want = chooseMapRendererKind(detectMapRendererEnv());
    setLoadError(null);
    const mountedModel = modelRef.current;
    const mountedPalette = paletteRef.current;
    mountMapRenderer(want, host, mountedModel, mountedPalette)
      .then(({ renderer, kind }) => {
        if (cancelled) {
          try { renderer.dispose(); } catch { /* 버려진 마운트는 조용히 걷는다 */ }
          return;
        }
        owned = renderer;
        rendererRef.current = renderer;
        setRendererKind(kind);
        // 청크를 받는 동안 기억이 도착하거나 테마가 바뀌면 갱신 효과는 렌더러 없이 지나갔다 — 최신 모델로 맞춘다.
        if (modelRef.current !== mountedModel || paletteRef.current !== mountedPalette) {
          renderer.update(modelRef.current, paletteRef.current);
        }
        renderer.setReducedMotion?.(reducedRef.current);
        renderer.setFilter(visibleRef.current);
        renderer.setSelection(canvasSelectionRef.current);
        applyInsetsRef.current();
        renderer.fit();
        offView = renderer.onViewChange?.(() => syncPositions()) ?? null;
        syncPositions();
        trackMotion(1200);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "failed");
      });
    return () => {
      cancelled = true;
      stopTracking();
      cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = 0;
      offView?.();
      setRendererKind(null);
      const ownedNow = owned ?? rendererRef.current;
      rendererRef.current = null;
      owned = null;
      try { ownedNow?.dispose(); } catch { /* 닫기 실패는 조용히 둔다 */ }
      buttonRefs.current.clear();
      tagRefs.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, retryToken, memory.loaded, memory.failed]);

  useEffect(() => {
    rendererRef.current?.setReducedMotion?.(reduced);
  }, [reduced]);

  // 모델·팔레트·필터 — 다시 mount하지 않고 갈아끼운다.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.update(model, palette);
    renderer.setFilter(visible);
    syncPositions();
    // 가려진 점에 포커스가 남았으면 정지점으로 돌려놓는다.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.classList.contains("commodore-map-node")
      && (active.style.display === "none" || active.style.visibility === "hidden")) {
      const fallback = (rovingId !== null ? buttonRefs.current.get(rovingId) : undefined)
        ?? [...buttonRefs.current.values()].find((element) => element.style.display !== "none" && element.style.visibility !== "hidden");
      fallback?.focus();
    }
  }, [model, palette, visible, rovingId, syncPositions]);

  // 호버·선택 변화로 새 이름표가 마운트되거나 흐림 상태가 바뀌면 DOM 위치를 다시 맞춘다.
  useEffect(() => {
    syncPositions();
  }, [activeFocusId, focusSet, focusLabelSet, syncPositions]);

  useEffect(() => {
    rendererRef.current?.setSelection(canvasSelectionId);
    // 패널·경로·키보드로 다른 점을 고르면 커서가 전에 머물던 호버 초점을 비워 새 선택으로 곧장 옮긴다.
    setHoveredId((prev) => (prev !== null && prev !== canvasSelectionId ? null : prev));
  }, [canvasSelectionId]);

  // 칩 필터가 지금 고른 점을 가리면 선택을 비워 보이지 않는 점 때문에 화면 전체가 흐려지지 않게 한다.
  useEffect(() => {
    if (picks.size === 0 || selectedId === null) return;
    const kept = graph.byId.has(selectedId)
      ? visible.has(selectedId)
      : selectedId.startsWith("intel:")
        ? visible.has("intel-overflow") || visible.has("intel")
        : selectedId.startsWith("obj:")
          ? picks.has("objective")
          : false;
    if (!kept) setSelectedId(null);
  }, [picks, selectedId, graph, visible, setSelectedId]);

  // Esc — 모달·메뉴·범례가 열려 있으면 건드리지 않고, 고른 점을 먼저 풀며 없으면 채팅으로 돌아간다.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (document.querySelector('[aria-modal="true"], [role="dialog"], [role="menu"], [role="listbox"]')) return;
      const openLegend = containerRef.current?.querySelector<HTMLDetailsElement>(".commodore-map-legend details[open]");
      if (openLegend) {
        event.preventDefault();
        openLegend.open = false;
        return;
      }
      event.preventDefault();
      const picked = selectedRef.current;
      if (!picked) { onExit(); return; }
      setSelectedId(null);
      // 패널이 닫히며 포커스가 사라지지 않게 고른 점(없으면 정지점)으로 돌려놓는다.
      const shown = (element: HTMLButtonElement | undefined): element is HTMLButtonElement =>
        element !== undefined && element.style.display !== "none" && element.style.visibility !== "hidden";
      const back = [buttonRefs.current.get(picked), rovingRef.current !== null ? buttonRefs.current.get(rovingRef.current) : undefined].find(shown);
      back?.focus();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onExit, setSelectedId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    applyInsets();
    syncPositions();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      applyInsets();
      syncPositions();
    });
    observer.observe(container);
    if (topRef.current) observer.observe(topRef.current);
    if (floatingPanelRef.current) observer.observe(floatingPanelRef.current);
    return () => observer.disconnect();
  }, [syncPositions, applyInsets, floatingVisible, memory.loaded, memory.failed, loadError]);

  const togglePick = (key: MapChipKey): void => {
    setPicks((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // D6 — 노드 층 방향키 이동. Enter·Space는 버튼 기본 동작(고르기) 그대로 둔다.
  const moveRoving = (key: string): void => {
    const candidates = orderedIds.filter((id) => {
      const element = buttonRefs.current.get(id);
      return element !== undefined && element.style.display !== "none" && element.style.visibility !== "hidden";
    });
    if (candidates.length === 0) return;
    const active = document.activeElement;
    const activeId = active instanceof HTMLElement
      ? ([...buttonRefs.current].find(([, element]) => element === active)?.[0] ?? null)
      : null;
    const at = activeId !== null ? candidates.indexOf(activeId) : candidates.indexOf(rovingRef.current ?? "");
    let next: number;
    if (key === "Home") next = 0;
    else if (key === "End") next = candidates.length - 1;
    else if (at < 0) next = key === "ArrowLeft" || key === "ArrowUp" ? candidates.length - 1 : 0;
    else next = (at + (key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1) + candidates.length) % candidates.length;
    const target = candidates[next];
    if (target !== undefined) buttonRefs.current.get(target)?.focus();
  };

  const handleStageKeyDown = (event: React.KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target?.classList.contains("commodore-map-node")) return;
    if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      event.stopPropagation();
      moveRoving(event.key);
    }
  };

  const pickAt = (clientX: number, clientY: number): string | null => {
    const renderer = rendererRef.current;
    const container = containerRef.current;
    if (!renderer || !container) return null;
    const rect = container.getBoundingClientRect();
    try {
      return renderer.pick(clientX - rect.left, clientY - rect.top);
    } catch {
      return null;
    }
  };

  const applyHover = useCallback((id: string | null): void => {
    rendererRef.current?.setHover(id);
    setHoveredId((current) => (current === id ? current : id));
  }, []);

  const handleMouseMove = (event: React.MouseEvent): void => {
    if ((event.target as HTMLElement | null)?.closest(STAGE_OVERLAY)) {
      if (hoveredId !== null) applyHover(null);
      return;
    }
    if (dragRef.current?.moved) return;
    if (hoverRafRef.current) return;
    const { clientX, clientY } = event;
    hoverRafRef.current = requestAnimationFrame(() => {
      hoverRafRef.current = 0;
      const renderer = rendererRef.current;
      if (!renderer) return;
      try {
        const id = pickAt(clientX, clientY);
        applyHover(id);
      } catch {
        /* hover 실패는 무시한다 */
      }
    });
  };

  const handleMouseLeave = (): void => {
    cancelAnimationFrame(hoverRafRef.current);
    hoverRafRef.current = 0;
    applyHover(null);
  };

  const searching = query.trim().length > 0;
  // 휴대폰 폭에서 접힌 검색은 돋보기만 보인다 — 그때는 돋보기가 키보드 정지점이다. 보기 방식 바뀜은 위 관찰자가 다시 그리게 한다.
  const searchCollapsed = document.documentElement.dataset.viewMode === "mobile" && !searchOpen && !searching;
  const visibleMatchCount = useMemo((): number => {
    if (!hits) return 0;
    let count = 0;
    for (const id of hits) if (visible.has(id)) count += 1;
    return count;
  }, [hits, visible]);

  return (
    <div className="commodore-map-screen" role="group" aria-label={t("commodore.map.title")}>
        <div className="commodore-map-body">
          <div
            ref={containerRef}
            className="commodore-map-stage"
            data-renderer={rendererKind ?? undefined}
            data-hover={hoveredId !== null ? "true" : undefined}
            data-panel-open={floatingVisible ? "true" : undefined}
            onClick={(event) => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              // 점·위쪽 줄(검색·칩·맞춤 보기)·범례·안내·부유 인스펙터를 누른 것은 지도 고르기가 아니다 — 그 아래 점을 고르거나 선택을 풀지 않는다.
              if ((event.target as HTMLElement).closest(STAGE_OVERLAY)) return;
              const id = pickAt(event.clientX, event.clientY);
              selectNode(id === selectedId ? null : id);
              if (id !== null) setRoving(id);
            }}
            onDoubleClick={(event) => {
              if ((event.target as HTMLElement).closest(STAGE_OVERLAY)) return;
              rendererRef.current?.fit();
              trackMotion(600);
            }}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onKeyDown={handleStageKeyDown}
            onPointerDown={(event) => {
              if ((event.target as HTMLElement).closest(STAGE_OVERLAY)) return;
              suppressClickRef.current = false;
              dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: event.button !== 0 };
              trackMotion(Infinity);
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag || drag.id !== event.pointerId || drag.moved) return;
              if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= STAGE_DRAG_THRESHOLD_PX) {
                drag.moved = true;
                applyHover(null);
              }
            }}
            onPointerUp={(event) => {
              const drag = dragRef.current;
              if (drag && drag.id === event.pointerId) {
                if (drag.moved) suppressClickRef.current = true;
                dragRef.current = null;
              }
              trackMotion(800);
            }}
            onPointerCancel={() => {
              dragRef.current = null;
              suppressClickRef.current = false;
              stopTracking();
            }}
          >
            <div ref={canvasHostRef} className="commodore-map-canvas-host" aria-hidden="true" />
            {!memory.loaded ? (
              <div className="commodore-map-state">{t("commodore.map.loading")}</div>
            ) : memory.failed ? (
              <div className="commodore-map-state">
                {t("commodore.memory.failed")}{" "}
                <button type="button" className="commodore-map-icon-btn" onClick={() => void loadCommodoreMemory(commodoreId)}>{t("commodore.map.retry")}</button>
              </div>
            ) : loadError ? (
              <div className="commodore-map-state">
                {t("commodore.map.failed", { code: loadError })}{" "}
                <button type="button" className="commodore-map-icon-btn" onClick={() => setRetryToken((token) => token + 1)}>{t("commodore.map.retry")}</button>
              </div>
            ) : (
              <>
              <div className="commodore-map-nodes" data-renderer={rendererKind ?? undefined}>
                {[...visible].map((id) => {
                  const node = graph.byId.get(id);
                  if (!node) return null;
                  return (
                    <button
                      key={id}
                      ref={(element) => {
                        if (element) buttonRefs.current.set(id, element);
                        else buttonRefs.current.delete(id);
                      }}
                      type="button"
                      className="commodore-map-node"
                      data-kind={node.kind}
                      data-branch={node.branch ?? ""}
                      data-fresh={node.fresh}
                      data-stale={node.stale}
                      data-selected={canvasSelectionId === id}
                      aria-label={nodeAria(t, node, branchName, graph.intelTotal)}
                      tabIndex={rovingId === id ? 0 : -1}
                      onClick={(event) => {
                        event.stopPropagation();
                        selectNode(selectedId === id ? null : id);
                        setRoving(id);
                      }}
                      onFocus={() => { setRoving(id); applyHover(id); }}
                      onBlur={() => applyHover(null)}
                    />
                  );
                })}
              </div>
              <div className="commodore-map-tags" aria-hidden="true">
                {rendererKind === "webgl" ? [...visible].map((id) => {
                  const node = graph.byId.get(id);
                  if (!node) return null;
                  const hub = isHubKind(node.kind);
                  if (!hub && node.kind !== "topic" && !hitLabelSet.has(id) && !focusLabelSet.has(id)) return null;
                  return (
                    <div
                      key={id}
                      ref={(element) => {
                        if (element) tagRefs.current.set(id, element);
                        else tagRefs.current.delete(id);
                      }}
                      className="commodore-map-tag"
                      data-hub={hub || undefined}
                    >
                      {node.label}
                    </div>
                  );
                }) : null}
              </div>
              <div ref={topRef} className="commodore-map-top">
              <div className="commodore-map-top-row">
              <div className="commodore-map-chips" role="group" aria-label={t("commodore.map.chips")}>
                <div className="commodore-map-search" role="search" data-open={searchOpen || searching ? "true" : undefined}>
                  <button
                    type="button"
                    tabIndex={searchCollapsed ? 0 : -1}
                    className="commodore-map-search-glyph"
                    aria-label={t("commodore.map.search")}
                    title={t("commodore.map.search")}
                    onClick={() => { setSearchOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); }}
                  ><SearchGlyph /></button>
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") return;
                      event.preventDefault();
                      event.stopPropagation();
                      if (query !== "") { setQuery(""); return; }
                      searchRef.current?.blur();
                      setSearchOpen(false);
                    }}
                    onBlur={() => { if (query.trim() === "") setSearchOpen(false); }}
                    placeholder={t("commodore.map.search")}
                    aria-label={t("commodore.map.search")}
                  />
                  {searching && visibleMatchCount > 0 ? (
                    <span className="commodore-map-search-count" aria-live="polite">{t("commodore.map.matches", { n: visibleMatchCount })}</span>
                  ) : null}
                  <button
                    type="button"
                    className="commodore-map-icon-btn commodore-map-search-clear"
                    aria-label={t("commodore.map.clearSearch")}
                    onClick={() => { setQuery(""); searchRef.current?.focus(); }}
                    style={{ visibility: searching ? "visible" : "hidden" }}
                    tabIndex={searching ? 0 : -1}
                  >✕</button>
                </div>
                {(["person", "theater", "lessons", "crew", "intel", "description"] as const).map((branch) => (
                  <button
                    key={branch}
                    type="button"
                    className="commodore-map-chip"
                    aria-pressed={picks.has(branch)}
                    onClick={() => togglePick(branch)}
                  >
                    <span
                      className={`commodore-map-sw${branch === "intel" ? " is-diamond" : ""}`}
                      style={{
                        "--c": branch === "description"
                          ? palette.core
                          : `var(--map-${branch === "intel" ? "intel" : `branch-${branch}`})`,
                      } as React.CSSProperties}
                      aria-hidden="true"
                    />
                    {branchChipLabel(t, branch)} <span className="commodore-map-n">{chipCounts[branch] ?? 0}</span>
                  </button>
                ))}
                <button
                  type="button"
                  className="commodore-map-chip"
                  aria-pressed={picks.has("objective")}
                  onClick={() => togglePick("objective")}
                >
                  <span className="commodore-map-sw is-ring" style={{ "--c": "var(--map-objective)" } as React.CSSProperties} aria-hidden="true" />
                  {t("commodore.tasks.goals")} <span className="commodore-map-n">{objectiveCount}</span>
                </button>
                <button
                  type="button"
                  className="commodore-map-chip"
                  aria-pressed={picks.has("link")}
                  onClick={() => togglePick("link")}
                >
                  <span className="commodore-map-sw is-line" style={{ "--c": "var(--map-link)" } as React.CSSProperties} aria-hidden="true" />
                  {t("commodore.map.chip.link")} <span className="commodore-map-n">{linkCount}</span>
                </button>
              </div>
              <div className="commodore-map-top-actions">
                {floatingPanel && !inspectorOpen ? (
                  <button
                    type="button"
                    className="commodore-map-panel-open"
                    onClick={() => setInspectorOpen(true)}
                  >{t("commodore.map.openPanel")}</button>
                ) : null}
                <button
                  type="button"
                  className="commodore-map-icon-btn commodore-map-fit"
                  title={t("commodore.map.fitHint")}
                  aria-label={t("commodore.map.fit")}
                  onClick={() => { rendererRef.current?.fit(); trackMotion(600); }}
                ><FitGlyph /></button>
              </div>
              </div>
              {/* 끌기·휠 조작은 WebGL만 받는다 — 휴대폰 궤도는 좁은 화면이라 시안대로 숨긴다. */}
              {rendererKind === "webgl" ? <div className="commodore-map-hint" aria-hidden="true">{t("commodore.map.hint")}</div> : null}
              </div>
              {searching && visibleMatchCount === 0 ? (
                <div className="commodore-map-notice" role="status">{t("commodore.map.noMatch")}</div>
              ) : isEmpty ? (
                <div className="commodore-map-notice" role="status">
                  <span>{t("commodore.map.empty")}</span>
                  {!showPanel ? (
                    <span className="commodore-map-notice-actions">
                      <button type="button" className="commodore-map-notice-btn" onClick={() => triggerQuickEdit("desc")}>
                        <span className="commodore-map-quick-plus" aria-hidden="true"><PlusGlyph /></span>
                        <span>{t("commodore.description.add")}</span>
                      </button>
                      <button type="button" className="commodore-map-notice-btn" onClick={() => triggerQuickEdit("intel")}>
                        <span className="commodore-map-quick-plus" aria-hidden="true"><PlusGlyph /></span>
                        <span>{t("commodore.intel.add")}</span>
                      </button>
                    </span>
                  ) : null}
                </div>
              ) : null}
              <div className="commodore-map-legend">
                <details>
                  <summary>{t("commodore.map.legend.title")}</summary>
                  <ul>
                    {[
                      { sw: "is-core", text: t("commodore.map.legend.core") },
                      { sw: "is-entry", text: t("commodore.map.legend.entry") },
                      { sw: "is-intel", text: t("commodore.map.legend.intel") },
                      { sw: "is-objective", text: t("commodore.map.legend.objective") },
                      { sw: "is-link", text: t("commodore.map.legend.link") },
                      { sw: "is-shared", text: t("commodore.map.legend.shared") },
                      { sw: "is-fresh", text: t("commodore.map.legend.fresh") },
                      { sw: "is-stale", text: t("commodore.map.legend.stale") },
                    ].map((row) => (
                      <li key={row.text}>
                        <span
                          className={`commodore-map-sw ${row.sw}`}
                          style={row.sw === "is-core" ? { "--c": palette.core } as React.CSSProperties : undefined}
                          aria-hidden="true"
                        />
                        <span>{row.text}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
              </>
            )}
            {floatingVisible ? (
              <div ref={floatingPanelRef} className="commodore-map-stage-panel" data-covers-native-view="">
                <MapPanel
                  t={t}
                  commodoreId={commodoreId}
                  node={selected?.node ?? null}
                  state={state}
                  entries={memory.entries}
                  graph={graph}
                  facts={facts}
                  branchName={branchName}
                  onSelect={(id) => { setSelectedId(id); }}
                  onClose={() => {
                    setSelectedId(null);
                    if (selectedId) buttonRefs.current.get(selectedId)?.focus();
                  }}
                  onQuickEdit={triggerQuickEdit}
                  onDismiss={() => setInspectorOpen(false)}
                  editors={editors?.(pickedIntelId)}
                />
                {failureLine}
              </div>
            ) : null}
          </div>
          {showPanel && !floatingPanel ? (
          <MapPanel
            t={t}
            commodoreId={commodoreId}
            node={selected?.node ?? null}
            state={state}
            entries={memory.entries}
            graph={graph}
            facts={facts}
            branchName={branchName}
            onSelect={setSelectedId}
            onClose={() => {
              setSelectedId(null);
              if (selectedId) buttonRefs.current.get(selectedId)?.focus();
            }}
          />
          ) : null}
        </div>
    </div>
  );
}
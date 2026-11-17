import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { Translate } from "@fleet-console/i18n";

import { useMongleLook } from "../../../workspace/client/avatar-events.js";
import { commodoreAvatarKey } from "../../../workspace/shared/avatars.js";
import { pushOverlayHistory, releaseOverlayHistory } from "../../../../core/client/src/chrome/mobile/mobile-overlay-history.js";
import { useGlobalSettingsStore, getGlobalSettingsStoreState } from "../../../settings/client/global-settings-store.js";
import type { CommodoreState } from "../../shared/contracts/types.js";
import type { MemoryBranch } from "../../shared/contracts/memory.js";
import { loadCommodoreMemory, useCommodoreMemory } from "../commodore-state.js";
import { MEMORY_BRANCH_LABEL } from "../commodore-memory.js";
import type { CommodoreMessageKey } from "../i18n/index.js";
import {
  buildMapGraph,
  matchMapQuery,
  visibleMapIds,
  type MapBranchKey,
  type MapNode,
} from "./map-graph.js";
import { MapPanel, type MapPanelFacts } from "./map-panel.js";
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

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

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

function branchChipLabel(t: T, branch: MapBranchKey): string {
  if (branch === "description") return t("commodore.description.label");
  if (branch === "intel") return t("commodore.intel.label");
  return t(MEMORY_BRANCH_LABEL[branch]);
}

/**
 * 사령관 지도 대화상자 — 정보 칸 '지도로 보기'가 연다. 그리기·고르기·화면 좌표는
 * MapRenderer 계약에만 기대고, 종류는 환경(모바일·동작 줄이기·WebGL2)으로 고른다.
 * 렌더러 로드·mount 실패는 Canvas로 넘어간다. 닫으면 dispose로 반납한다.
 */
export function CommodoreMapDialog({ t, commodoreId, state, facts, onClose }: {
  readonly t: T;
  readonly commodoreId: string;
  readonly state: CommodoreState;
  readonly facts: MapPanelFacts;
  readonly onClose: () => void;
}) {
  const memory = useCommodoreMemory(commodoreId);
  const look = useMongleLook(commodoreAvatarKey(commodoreId));
  const settings = useGlobalSettingsStore();
  const osReduced = useOsReducedMotion();
  const dialogRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<MapRenderer | null>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const tagRefs = useRef(new Map<string, HTMLDivElement>());
  const rovingRef = useRef<string | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<MapBranchKey>>(() => new Set());
  const [hideObjective, setHideObjective] = useState(false);
  const [hideLinks, setHideLinks] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  // (a) D4 DOM 라벨 층은 WebGL일 때만 — Canvas·궤도는 캔버스에 직접 그린다.
  const [rendererKind, setRendererKind] = useState<MapRendererKind | null>(null);
  const [paletteTick, setPaletteTick] = useState(0);
  const trackRaf = useRef(0);
  const trackTail = useRef(0);

  const branchName = useCallback((branch: MemoryBranch): string => t(MEMORY_BRANCH_LABEL[branch]), [t]);
  const labels = useMemo(() => ({
    description: t("commodore.description.label"),
    intelHub: t("commodore.intel.label"),
    branch: branchName,
    personSource: t("commodore.intel.fromYou"),
    source: (label: string): string => t("commodore.map.node.source", { label }),
  }), [t, branchName]);
  const graph = useMemo(
    () => buildMapGraph({ state, memories: memory.entries, tone: look.tone ?? null, labels, links: !hideLinks }),
    [state, memory.entries, look.tone, labels, hideLinks],
  );
  const layout = useMemo(() => layoutMapGraph(graph), [graph]);
  const model = useMemo(() => ({ graph, layout }), [graph, layout]);
  const hits = useMemo(() => matchMapQuery(graph, query), [graph, query]);
  const visibleBase = useMemo(() => visibleMapIds(graph, hidden, hits), [graph, hidden, hits]);
  const visible = useMemo(() => {
    if (!hideObjective) return visibleBase;
    return new Set([...visibleBase].filter((id) => graph.byId.get(id)?.kind !== "objective"));
  }, [visibleBase, hideObjective, graph]);
  const palette = useMemo(() => readMapPalette(), [paletteTick]);
  // 칩 숫자는 노드 수가 아니라 기억·정보 개수다. 목표·링크는 그래프 개수.
  const chipCounts = useMemo(() => {
    const counts: Record<MapBranchKey, number> = { description: 0, intel: 0, person: 0, theater: 0, lessons: 0, crew: 0 };
    counts.description = state.description.text === "" ? 0 : 1;
    counts.intel = state.intel.length;
    for (const entry of memory.entries) counts[entry.branch] += 1;
    return counts;
  }, [state.description.text, state.intel.length, memory.entries]);
  const objectiveCount = useMemo(() => graph.nodes.filter((node) => node.kind === "objective").length, [graph]);
  const linkCount = useMemo(() => graph.edges.filter((edge) => edge.kind === "link").length, [graph]);
  const isEmpty = state.description.text === "" && graph.intelTotal === 0 && memory.entries.length === 0;
  const selected: { readonly node: MapNode } | null = selectedId ? (graph.byId.get(selectedId) ? { node: graph.byId.get(selectedId)! } : null) : null;
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

  const modelRef = useRef(model);
  modelRef.current = model;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const hitLabelsRef = useRef<readonly string[]>([]);
  hitLabelsRef.current = hitLabelIds;
  const paletteRef = useRef(palette);
  paletteRef.current = palette;

  // D4 — 핵·허브 라벨은 항상, 주제 라벨은 겹치지 않을 때만 DOM 층에 띠운다.
  // 렌더러를 고치지 않고 project 좌표를 읽으므로 끌기·확대 때 따라 움직인다.
  const syncPositions = useCallback((): void => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    try {
      const spots = new Map<string, { x: number; y: number }>();
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
        }
      }
      // 라벨 자리 — 핵·가지 허브부터 잡고, 주제·검색 일치는 겹치지 않을 때만 선다.
      // 시안대로 점 오른쪽에 둔다.
      const shown: { x0: number; y0: number; x1: number; y1: number }[] = [];
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
      const place = (id: string, node: MapNode, lift: number, always: boolean): void => {
        const element = tagRefs.current.get(id);
        const point = spots.get(id);
        if (!element || !point) return;
        const w = Math.min(220, node.label.length * 6.5 + 8);
        const x = point.x + lift;
        const y = point.y;
        const rect = rectOf(x, y, w);
        if (!always && (near(rect) || crowded(id, x, y))) {
          element.style.display = "none";
          return;
        }
        element.style.display = "";
        element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(0, -50%)`;
        shown.push(rect);
      };
      for (const [id] of tagRefs.current) {
        if (!spots.has(id)) {
          const element = tagRefs.current.get(id);
          if (element) element.style.display = "none";
        }
      }
      for (const id of visibleRef.current) {
        const node = modelRef.current.graph.byId.get(id);
        if (!node) continue;
        if (node.kind !== "core" && node.kind !== "description" && node.kind !== "intel-hub" && node.kind !== "intel-overflow" && node.kind !== "branch" && node.kind !== "source") continue;
        place(id, node, node.kind === "core" ? 20 : 16, true);
      }
      for (const id of visibleRef.current) {
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

  // 테마 전환 — 토큰을 다시 읽어 렌더러에 갈아끼운다.
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setPaletteTick((tick) => tick + 1));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-mobile-scheme", "data-view-mode"] });
    return () => observer.disconnect();
  }, []);

  // (b) setFitInsets는 렌더러가 맞춤 보기를 다시 돌리므로 마운트·크기 변경 때만 부른다.
  // 선택·검색·테마로는 바꾸지 않는다 — 확대·회전해 둔 보기가 튀어 돌아가지 않게.
  // 칩이 무대 안에 겹치므로 위쪽 여백은 칩 줄 높이 정도만 둔다.
  const applyInsets = useCallback((): void => {
    rendererRef.current?.setFitInsets?.({
      top: 64,
      right: selectedRef.current ? 340 : 16,
      bottom: 24,
      left: 24,
    });
  }, []);

  // 생성·반납 — 실패하면 Canvas로 넘어가고, 그것마저 실패하면 안내만 둔다.
  // 보기 변화 알림(onViewChange)이 오면 DOM 층을 다시 읽는다. 첫 그림·맞춤 트윈이
  // 비동기라 마운트 직후에는 짧게 따라가며 동기화한다(수정 4 D1).
  useEffect(() => {
    const container = containerRef.current;
    if (!container || isEmpty) return;
    let cancelled = false;
    let owned: MapRenderer | null = null;
    let offView: (() => void) | null = null;
    const reduced = osReduced || getGlobalSettingsStoreState().state?.reduceMotion === true || settings.state?.reduceMotion === true;
    const want = chooseMapRendererKind(detectMapRendererEnv({ reducedMotion: reduced }));
    setLoadError(null);
    mountMapRenderer(want, container, modelRef.current, paletteRef.current)
      .then(({ renderer, kind }) => {
        if (cancelled) {
          try { renderer.dispose(); } catch { /* 버려진 마운트는 조용히 걷는다 */ }
          return;
        }
        owned = renderer;
        rendererRef.current = renderer;
        setRendererKind(kind);
        renderer.setFilter(visibleRef.current);
        renderer.setSelection(selectedRef.current);
        applyInsets();
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
  }, [osReduced, retryToken, isEmpty]);

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

  useEffect(() => {
    rendererRef.current?.setSelection(selectedId);
  }, [selectedId]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 모달 규율 — 셸을 inert로 잠그고, 포커스를 돌려놓고, Tab을 창 안에서 끝낸다.
  // 휴대폰에서는 시스템 뒤로가기도 닫기로 잇는다.
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".console-shell");
    const previous = document.body.getAttribute("data-commodore-map-open");
    document.body.setAttribute("data-commodore-map-open", "true");
    if (shell) shell.inert = true;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const mobile = typeof document !== "undefined"
      && document.documentElement.getAttribute("data-view-mode") === "mobile";
    const overlayId = mobile ? pushOverlayHistory(() => onCloseRef.current()) : null;
    return () => {
      if (overlayId !== null) releaseOverlayHistory(overlayId);
      if (previous === null) document.body.removeAttribute("data-commodore-map-open");
      else document.body.setAttribute("data-commodore-map-open", previous);
      if (shell) shell.inert = false;
      returnFocus?.focus?.();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (selectedRef.current) setSelectedId(null);
        else onClose();
      } else if (event.key === "Tab") {
        const container = dialogRef.current;
        if (!container) return;
        const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
          .filter((element) => element.tabIndex >= 0 && element.style.display !== "none" && element.style.visibility !== "hidden" && !element.hasAttribute("aria-hidden"));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      } else {
        return;
      }
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      applyInsets();
      syncPositions();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [syncPositions, applyInsets]);

  const toggleBranch = (branch: MapBranchKey): void => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(branch)) next.delete(branch);
      else next.add(branch);
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

  let hoverRaf = 0;
  const handleMouseMove = (event: React.MouseEvent): void => {
    if (hoverRaf) return;
    const { clientX, clientY } = event;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const renderer = rendererRef.current;
      if (!renderer) return;
      try {
        const id = pickAt(clientX, clientY);
        renderer.setHover(id);
        const container = containerRef.current;
        if (container) container.style.cursor = id ? "pointer" : "";
      } catch {
        /* hover 실패는 무시한다 */
      }
    });
  };

  const searching = query.trim().length > 0;
  const matchCount = hits?.size ?? 0;

  return createPortal(
    <div className="commodore-map-scrim">
      <div ref={dialogRef} className="commodore-map-dialog" role="dialog" aria-modal="true" aria-label={t("commodore.map.title")} tabIndex={-1}>
        <div className="commodore-map-head">
          <h2 className="commodore-map-title">{t("commodore.map.title")}</h2>
          <span className="commodore-map-head-spacer" />
          <button type="button" className="commodore-map-icon-btn" aria-label={t("commodore.map.close")} onClick={onClose}>✕</button>
        </div>
        <div className="commodore-map-toolbar">
          <label className="commodore-map-search">
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("commodore.map.search")}
              aria-label={t("commodore.map.search")}
            />
            <button
              type="button"
              className="commodore-map-icon-btn"
              aria-label={t("commodore.map.clearSearch")}
              onClick={() => setQuery("")}
              style={{ visibility: searching ? "visible" : "hidden" }}
              tabIndex={searching ? 0 : -1}
            >✕</button>
          </label>
          <span className="commodore-map-head-spacer" />
          <button
            type="button"
            className="commodore-map-icon-btn commodore-map-fit"
            title={t("commodore.map.fitHint")}
            aria-label={t("commodore.map.fit")}
            onClick={() => { rendererRef.current?.fit(); trackMotion(600); }}
          >{t("commodore.map.fit")}</button>
        </div>
        <div className="commodore-map-body">
          <div
            ref={containerRef}
            className="commodore-map-stage"
            onClick={(event) => {
              if ((event.target as HTMLElement).closest(".commodore-map-node")) return;
              const id = pickAt(event.clientX, event.clientY);
              setSelectedId((current) => (id === null || id === current ? null : id));
              if (id !== null) setRoving(id);
            }}
            onDoubleClick={() => { rendererRef.current?.fit(); trackMotion(600); }}
            onMouseMove={handleMouseMove}
            onKeyDown={handleStageKeyDown}
            onPointerDown={() => trackMotion(Infinity)}
            onPointerUp={() => trackMotion(800)}
            onPointerCancel={() => stopTracking()}
          >
            <div ref={nodesRef} className="commodore-map-canvas-host" aria-hidden="true" />
            {isEmpty ? (
              <div className="commodore-map-state">{t("commodore.map.empty")}</div>
            ) : !memory.loaded ? (
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
              <div className="commodore-map-nodes">
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
                      data-selected={selectedId === id}
                      aria-label={nodeAria(t, node, branchName, graph.intelTotal)}
                      tabIndex={rovingId === id ? 0 : -1}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedId((current) => (current === id ? null : id));
                        setRoving(id);
                      }}
                      onFocus={() => { setRoving(id); rendererRef.current?.setHover(id); }}
                      onBlur={() => rendererRef.current?.setHover(null)}
                    />
                  );
                })}
              </div>
              <div className="commodore-map-tags" aria-hidden="true">
                {rendererKind === "webgl" ? [...visible].map((id) => {
                  const node = graph.byId.get(id);
                  if (!node) return null;
                  const hub = node.kind === "core" || node.kind === "description" || node.kind === "intel-hub" || node.kind === "intel-overflow" || node.kind === "branch" || node.kind === "source";
                  if (!hub && node.kind !== "topic" && !hitLabelSet.has(id)) return null;
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
              <div className="commodore-map-chips" role="group" aria-label={t("commodore.map.chips")}>
                {(["person", "theater", "lessons", "crew", "intel", "description"] as const).map((branch) => (
                  <button
                    key={branch}
                    type="button"
                    className="commodore-map-chip"
                    aria-pressed={!hidden.has(branch)}
                    onClick={() => toggleBranch(branch)}
                  >
                    <span className="commodore-map-sw" style={{ "--c": `var(--map-${branch === "description" ? "description" : branch === "intel" ? "intel" : `branch-${branch}`})` } as React.CSSProperties} aria-hidden="true" />
                    {branchChipLabel(t, branch)} <span className="commodore-map-n">{chipCounts[branch] ?? 0}</span>
                  </button>
                ))}
                <button
                  type="button"
                  className="commodore-map-chip"
                  aria-pressed={!hideObjective}
                  onClick={() => setHideObjective((value) => !value)}
                >
                  <span className="commodore-map-sw is-ring" style={{ "--c": "var(--map-objective)" } as React.CSSProperties} aria-hidden="true" />
                  {t("commodore.tasks.goals")} <span className="commodore-map-n">{objectiveCount}</span>
                </button>
                <button
                  type="button"
                  className="commodore-map-chip"
                  aria-pressed={!hideLinks}
                  onClick={() => setHideLinks((value) => !value)}
                >
                  <span className="commodore-map-sw is-line" style={{ "--c": "var(--map-link)" } as React.CSSProperties} aria-hidden="true" />
                  {t("commodore.map.chip.link")} <span className="commodore-map-n">{linkCount}</span>
                </button>
              </div>
              <div className="commodore-map-hint" aria-hidden="true">{t("commodore.map.hint")}</div>
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
                        <span className={`commodore-map-sw ${row.sw}`} aria-hidden="true" />
                        <span>{row.text}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
              </>
            )}
          </div>
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
        </div>
        {searching && matchCount === 0 ? <div className="commodore-map-state">{t("commodore.map.noMatch")}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
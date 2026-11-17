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
import { MEMORY_BRANCH_LABEL, memoryDay, memoryLinks } from "../commodore-memory.js";
import { MEMORY_STALE_MS } from "../../shared/contracts/memory-stale.js";
import type { CommodoreMessageKey } from "../i18n/index.js";
import {
  buildMapGraph,
  MAP_BRANCH_ORDER,
  matchMapQuery,
  visibleMapIds,
  type MapBranchKey,
  type MapNode,
} from "./map-graph.js";
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

function nodeAria(t: T, node: MapNode, branchName: (branch: MemoryBranch) => string): string {
  switch (node.kind) {
    case "core": return t("commodore.map.node.core", { name: node.label });
    case "description": return t("commodore.map.node.description");
    case "intel-hub": return t("commodore.map.node.intelHub");
    case "intel": return t("commodore.map.node.intel", { title: node.label });
    case "intel-overflow": return t("commodore.map.node.overflow", { n: node.overflowIds?.length ?? 0 });
    case "source": return t("commodore.map.node.source", { label: node.label });
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

interface DetailTarget {
  readonly node: MapNode;
}

/**
 * 사령관 지도 대화상자 — 정보 칸 '지도로 보기'가 연다. 그리기·고르기·화면 좌표는
 * MapRenderer 계약에만 기대고, 종류는 환경(모바일·동작 줄이기·WebGL2)으로 고른다.
 * 렌더러 로드·mount 실패는 Canvas로 넘어간다. 닫으면 dispose로 반납한다.
 */
export function CommodoreMapDialog({ t, commodoreId, state, onClose }: {
  readonly t: T;
  readonly commodoreId: string;
  readonly state: CommodoreState;
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
  }), [t, branchName]);
  const graph = useMemo(
    () => buildMapGraph({ state, memories: memory.entries, tone: look.tone ?? null, labels }),
    [state, memory.entries, look.tone, labels],
  );
  const layout = useMemo(() => layoutMapGraph(graph), [graph]);
  const model = useMemo(() => ({ graph, layout }), [graph, layout]);
  const hits = useMemo(() => matchMapQuery(graph, query), [graph, query]);
  const visible = useMemo(() => visibleMapIds(graph, hidden, hits), [graph, hidden, hits]);
  const palette = useMemo(() => readMapPalette(), [paletteTick]);
  // D1 — 칩 숫자는 노드 수가 아니라 기억·정보 개수다.
  const chipCounts = useMemo(() => {
    const counts: Record<MapBranchKey, number> = { description: 0, intel: 0, person: 0, theater: 0, lessons: 0, crew: 0 };
    counts.description = state.description.text === "" ? 0 : 1;
    counts.intel = state.intel.length;
    for (const entry of memory.entries) counts[entry.branch] += 1;
    return counts;
  }, [state.description.text, state.intel.length, memory.entries]);
  const isEmpty = state.description.text === "" && graph.intelTotal === 0 && memory.entries.length === 0;
  const selected: DetailTarget | null = selectedId ? (graph.byId.get(selectedId) ? { node: graph.byId.get(selectedId)! } : null) : null;
  // D6 — 노드 층의 Tab 정지점은 하나로, 방향키로 옮겨 다닌다.
  const orderedIds = useMemo(() => [...visible], [visible]);
  const [roving, setRoving] = useState<string | null>(null);
  const rovingId = roving !== null && visible.has(roving)
    ? roving
    : (selectedId !== null && visible.has(selectedId) ? selectedId : (orderedIds[0] ?? null));
  rovingRef.current = rovingId;

  const modelRef = useRef(model);
  modelRef.current = model;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
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
      // 라벨 자리 — 핵·가지 허브부터 잡고, 주제는 44px 안에 남의 자리가 없을 때만 선다.
      const shown: { x: number; y: number }[] = [];
      const near = (x: number, y: number): boolean => shown.some((spot) => Math.abs(spot.x - x) < 44 && Math.abs(spot.y - y) < 20);
      const place = (id: string, lift: number, always: boolean): void => {
        const element = tagRefs.current.get(id);
        const point = spots.get(id);
        if (!element || !point) return;
        const x = point.x;
        const y = point.y - lift;
        if (!always && near(x, y)) {
          element.style.display = "none";
          return;
        }
        element.style.display = "";
        element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
        shown.push({ x, y });
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
        if (node.kind !== "core" && node.kind !== "description" && node.kind !== "intel-hub" && node.kind !== "branch") continue;
        place(id, node.kind === "core" ? 20 : 16, true);
      }
      for (const id of visibleRef.current) {
        const node = modelRef.current.graph.byId.get(id);
        if (!node || node.kind !== "topic") continue;
        place(id, 14, false);
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
  const applyInsets = useCallback((): void => {
    rendererRef.current?.setFitInsets?.({
      top: 96,
      right: selectedRef.current ? 316 : 16,
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
          <div className="commodore-map-chips" role="group" aria-label={t("commodore.map.title")}>
            {MAP_BRANCH_ORDER.map((branch) => {
              const pressed = !hidden.has(branch);
              return (
                <button
                  key={branch}
                  type="button"
                  className="commodore-map-chip"
                  aria-pressed={pressed}
                  onClick={() => toggleBranch(branch)}
                >
                  <span className="commodore-map-chip-dot" data-branch={branch} aria-hidden="true" />
                  {branchChipLabel(t, branch)} {chipCounts[branch] ?? 0}
                </button>
              );
            })}
          </div>
          <label className="commodore-map-search">
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("commodore.map.search")}
              aria-label={t("commodore.map.search")}
            />
            {searching ? (
              <button type="button" className="commodore-map-icon-btn" aria-label={t("commodore.map.clearSearch")} onClick={() => setQuery("")}>✕</button>
            ) : null}
          </label>
          <button
            type="button"
            className="commodore-map-icon-btn"
            title={t("commodore.map.fitHint")}
            aria-label={t("commodore.map.fit")}
            onClick={() => { rendererRef.current?.fit(); trackMotion(600); }}
          >⤢</button>
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
                      aria-label={nodeAria(t, node, branchName)}
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
                  if (node.kind !== "core" && node.kind !== "description" && node.kind !== "intel-hub" && node.kind !== "branch" && node.kind !== "topic") return null;
                  return (
                    <div
                      key={id}
                      ref={(element) => {
                        if (element) tagRefs.current.set(id, element);
                        else tagRefs.current.delete(id);
                      }}
                      className="commodore-map-tag"
                      data-kind={node.kind}
                    >
                      {node.label}
                    </div>
                  );
                }) : null}
              </div>
              </>
            )}
          </div>
          {selected ? (
            <MapDetailPanel
              t={t}
              node={selected.node}
              state={state}
              entries={memory.entries}
              branchName={branchName}
              onSelect={setSelectedId}
              onClose={() => {
                setSelectedId(null);
                if (selectedId) buttonRefs.current.get(selectedId)?.focus();
              }}
            />
          ) : null}
        </div>
        {searching && matchCount === 0 ? <div className="commodore-map-state">{t("commodore.map.noMatch")}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

function MapDetailPanel({ t, node, state, entries, branchName, onSelect, onClose }: {
  readonly t: T;
  readonly node: MapNode;
  readonly state: CommodoreState;
  readonly entries: readonly import("../../shared/contracts/memory.js").MemoryEntry[];
  readonly branchName: (branch: MemoryBranch) => string;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
}) {
  const entry = node.ref ? entries.find((candidate) => candidate.ref === node.ref) ?? null : null;
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);

  let body: React.ReactNode = null;
  if (node.kind === "memory" && entry) {
    const links = memoryLinks(entry, entries);
    const isStale = Date.now() - entry.verified > MEMORY_STALE_MS;
    const shared = entries.filter((candidate) =>
      candidate.ref !== entry.ref &&
      candidate.sources.some((source) => entry.sources.some((own) => own.objectiveId === source.objectiveId)),
    );
    body = (
      <>
        <div className="commodore-map-panel-meta">
          {branchName(entry.branch)} · {entry.topic} · {t("commodore.memory.updated", { date: memoryDay(entry.updated) })}
          {isStale ? ` · ${t("commodore.memory.stale")}` : ""}
        </div>
        {entry.description ? (<><h4>{t("commodore.memory.summary")}</h4><p>{entry.description}</p></>) : null}
        {entry.why ? (<><h4>{t("commodore.memory.why")}</h4><p>{entry.why}</p></>) : null}
        {entry.how ? (<><h4>{t("commodore.memory.how")}</h4><p>{entry.how}</p></>) : null}
        {entry.sources.length > 0 ? (
          <>
            <h4>{t("commodore.memory.sources")}</h4>
            <ul>
              {entry.sources.map((source) => (
                <li key={source.objectiveId}>
                  <button type="button" className="commodore-map-panel-link" onClick={() => onSelect(`obj:${source.objectiveId}`)}>{source.title}</button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {links.length > 0 ? (
          <>
            <h4>{t("commodore.memory.links")}</h4>
            <ul>
              {links.map((linked) => (
                <li key={linked.ref}>
                  <button type="button" className="commodore-map-panel-link" onClick={() => onSelect(`mem:${linked.ref}`)}>{linked.title}</button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {shared.length > 0 ? (
          <>
            <h4>{t("commodore.map.objectiveMemories")}</h4>
            <ul>
              {shared.map((other) => (
                <li key={other.ref}>
                  <button type="button" className="commodore-map-panel-link" onClick={() => onSelect(`mem:${other.ref}`)}>{other.title}</button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </>
    );
  } else if (node.kind === "intel" && node.intelId) {
    const item = state.intel.find((candidate) => candidate.id === node.intelId);
    body = item ? (
      <>
        <div className="commodore-map-panel-meta">
          {sourceLabelOf(t, state, item.source)} · {memoryDay(item.at)}
        </div>
        <p>{item.text}</p>
      </>
    ) : null;
  } else if (node.kind === "intel-overflow") {
    const rest = [...state.intel].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
    body = (
      <>
        <h4>{t("commodore.map.allIntelCount", { n: state.intel.length })}</h4>
        <ul>
          {rest.map((item) => (
            <li key={item.id}>
              <p>{item.text}</p>
              <div className="commodore-map-panel-meta">{sourceLabelOf(t, state, item.source)} · {memoryDay(item.at)}</div>
            </li>
          ))}
        </ul>
      </>
    );
  } else if (node.kind === "topic" && node.branch && node.topic) {
    const inTopic = entries.filter((candidate) => candidate.branch === node.branch && candidate.topic === node.topic);
    body = (
      <>
        <h4>{t("commodore.map.topicEntries")}</h4>
        <ul>
          {inTopic.map((item) => (
            <li key={item.ref}>
              <button type="button" className="commodore-map-panel-link" onClick={() => onSelect(`mem:${item.ref}`)}>{item.title}</button>
            </li>
          ))}
        </ul>
      </>
    );
  } else if (node.kind === "branch" && node.branch) {
    const topics = [...new Set(entries.filter((candidate) => candidate.branch === node.branch).map((candidate) => candidate.topic))].sort();
    body = (
      <>
        <h4>{t("commodore.map.branchTopics")}</h4>
        <ul>
          {topics.map((topic) => (
            <li key={topic}>
              <button type="button" className="commodore-map-panel-link" onClick={() => onSelect(`topic:${node.branch}:${topic}`)}>{topic}</button>
            </li>
          ))}
        </ul>
      </>
    );
  } else if (node.kind === "source" && node.sourceId) {
    const items = state.intel.filter((item) => item.source === node.sourceId).sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
    body = (
      <>
        <div className="commodore-map-panel-meta">{sourceLabelOf(t, state, node.sourceId)} · {items.length}</div>
        <h4>{t("commodore.map.sourceIntel")}</h4>
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <p>{item.text}</p>
              <div className="commodore-map-panel-meta">{memoryDay(item.at)}</div>
            </li>
          ))}
        </ul>
      </>
    );
  } else if (node.kind === "objective" && node.objectiveId) {
    const linked = entries.filter((candidate) => candidate.sources.some((source) => source.objectiveId === node.objectiveId));
    body = (
      <>
        <h4>{t("commodore.map.objectiveMemories")}</h4>
        <ul>
          {linked.map((item) => (
            <li key={item.ref}>
              <button type="button" className="commodore-map-panel-link" onClick={() => onSelect(`mem:${item.ref}`)}>{item.title}</button>
            </li>
          ))}
        </ul>
      </>
    );
  } else if (node.kind === "description") {
    body = (
      <>
        <div className="commodore-map-panel-meta">
          {t("commodore.description.rev", { rev: state.description.rev, time: memoryDay(state.description.updatedAt) })}
        </div>
        <p>{state.description.text}</p>
      </>
    );
  } else if (node.kind === "core") {
    body = (
      <>
        <div className="commodore-map-panel-meta">
          {t("commodore.map.countMemory", { n: entries.length })} · {t("commodore.map.countIntel", { n: state.intel.length })} · {t("commodore.map.countSources", { n: state.sources.length })}
        </div>
        {state.description.text ? <p>{state.description.text}</p> : null}
      </>
    );
  }

  return (
    <aside className="commodore-map-panel" aria-label={node.label}>
      <button ref={closeRef} type="button" className="commodore-map-icon-btn commodore-map-panel-close" aria-label={t("commodore.map.close")} onClick={onClose}>✕</button>
      <h3>{node.label}</h3>
      {body}
    </aside>
  );
}

function sourceLabelOf(t: T, state: CommodoreState, sourceId: string): string {
  if (sourceId === "person") return t("commodore.intel.fromYou");
  return state.sources.find((source) => source.id === sourceId)?.label ?? sourceId;
}

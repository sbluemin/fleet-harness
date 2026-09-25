import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import type { OperationClusterMember, OperationClusterProgress } from "@fleet-console/sdk/plugin";

import { useT } from "../../../core/client/src/i18n/index.js";
import type { ClusterLayout } from "./operation-clusters.js";

type RootActivity = "idle" | "running" | "awaiting" | "background" | "ended" | null;

const CoordGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true">
    <circle cx="8" cy="4" r="2" />
    <circle cx="4" cy="12" r="2" />
    <circle cx="12" cy="12" r="2" />
    <path d="M7 5.7L5 10.3M9 5.7l2 4.6" />
  </svg>
);

const TONE_ORDER: readonly string[] = ["teal", "amber", "plum", "moss", "cerulean", "rose", "indigo", "crimson"];
/** 생략한 구형 생산자만 progress를 대기 신호로 사용한다. 명시 false는 우선한다. */
const awaitingInput = (member: OperationClusterMember): boolean => member.awaitingInput ?? member.progress === "awaiting";
const chipProgress = (member: OperationClusterMember): OperationClusterProgress =>
  awaitingInput(member) ? "awaiting" : member.progress === "awaiting" ? "open" : member.progress;

/** 방향키는 포커스만 옮기고 클릭·Enter·Space만 본문을 전환하는 수동 활성화 탭 줄. */
export function ClusterNodeRail({ layout, current, rootActivity, onPick }: {
  readonly layout: ClusterLayout;
  readonly current: string;
  readonly rootActivity: RootActivity;
  readonly onPick: (operationId: string) => void;
}) {
  const t = useT();
  const railRef = useRef<HTMLDivElement | null>(null);
  const membersRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [focusedId, setFocusedId] = useState(current);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const tooltipAnchorRef = useRef<HTMLElement | null>(null);
  const [tooltipName, setTooltipName] = useState("");
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [scrollState, setScrollState] = useState({ overflow: false, left: false, right: false, awaitingLeft: 0, awaitingRight: 0 });
  const root = layout.cluster.root;
  const nodes = useMemo(() => layout.cluster.members
    .map((member, index) => ({ member, n: index + 1 }))
    .filter(({ member }) => layout.formation.byOperationId.has(member.operationId))
    .sort((a, b) => {
      if (a.member.order !== undefined && b.member.order !== undefined) return a.member.order - b.member.order;
      if (a.member.tone && b.member.tone) return TONE_ORDER.indexOf(a.member.tone) - TONE_ORDER.indexOf(b.member.tone);
      return a.n - b.n;
    }), [layout.cluster.members, layout.formation.byOperationId]);
  const nodesKey = nodes.map(({ member }) => `${member.operationId}:${member.name}:${awaitingInput(member)}`).join("|");
  const nodeName = (node: { readonly member: { readonly name?: string }; readonly n: number }) =>
    node.member.name ?? t("cluster.nodes.node", { n: node.n });

  const positionTooltip = () => {
    const tooltip = tooltipRef.current;
    const anchor = tooltipAnchorRef.current;
    if (!tooltip || !anchor?.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - tooltip.offsetWidth - 8))}px`;
    tooltip.style.top = `${rect.bottom + tooltip.offsetHeight + 6 <= window.innerHeight
      ? rect.bottom + 5 : Math.max(8, rect.top - tooltip.offsetHeight - 5)}px`;
  };
  const showName = (anchor: HTMLElement, name: string) => {
    tooltipAnchorRef.current = anchor;
    setTooltipName(name);
    setTooltipVisible(true);
    positionTooltip();
  };
  useLayoutEffect(positionTooltip, [tooltipName, tooltipVisible]);
  useEffect(() => {
    const hide = () => setTooltipVisible(false);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const stopScroll = () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    if (scrollDelayRef.current !== null) clearTimeout(scrollDelayRef.current);
    scrollFrameRef.current = null;
    scrollDelayRef.current = null;
  };

  const keepVisible = (tab: HTMLElement) => {
    const viewport = viewportRef.current;
    if (!viewport || !trackRef.current?.contains(tab)) return;
    if (tab.offsetLeft < viewport.scrollLeft) viewport.scrollLeft = tab.offsetLeft;
    else if (tab.offsetLeft + tab.offsetWidth > viewport.scrollLeft + viewport.clientWidth) {
      viewport.scrollLeft = tab.offsetLeft + tab.offsetWidth - viewport.clientWidth;
    }
  };

  const measureScroll = () => {
    const members = membersRef.current;
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!members || !viewport || !track) return;
    const end = viewport.scrollLeft + viewport.clientWidth;
    const awaiting = Array.from(track.querySelectorAll<HTMLElement>(".is-awaiting"));
    // 화살표를 제외한 전체 가용 폭과 비교해야 표시 자체가 overflow를 유지하지 않는다.
    const next = {
      overflow: track.scrollWidth > members.clientWidth + 1,
      left: viewport.scrollLeft > 1,
      right: viewport.scrollWidth - end > 1,
      awaitingLeft: awaiting.filter((tab) => tab.offsetLeft < viewport.scrollLeft - 1).length,
      awaitingRight: awaiting.filter((tab) => tab.offsetLeft + tab.offsetWidth > end + 1).length,
    };
    setScrollState((prev) => Object.keys(next).every((key) => prev[key as keyof typeof next] === next[key as keyof typeof next]) ? prev : next);
  };

  useLayoutEffect(() => {
    const track = trackRef.current;
    const members = membersRef.current;
    const viewport = viewportRef.current;
    if (!track || !members || !viewport) return;
    measureScroll();
    const observer = new ResizeObserver(measureScroll);
    observer.observe(members);
    observer.observe(viewport);
    observer.observe(track);
    return () => observer.disconnect();
  }, [nodesKey]);

  useLayoutEffect(() => {
    setFocusedId(current);
    setTooltipVisible(false);
    const tab = Array.from(trackRef.current?.querySelectorAll<HTMLElement>("[data-member-op-id]") ?? [])
      .find((candidate) => candidate.dataset.memberOpId === current);
    if (tab) keepVisible(tab);
  }, [current, nodesKey]);

  useEffect(() => {
    window.addEventListener("blur", stopScroll);
    return () => { stopScroll(); window.removeEventListener("blur", stopScroll); };
  }, []);

  const startScroll = (direction: -1 | 1) => {
    stopScroll();
    // 클릭 전에 움직이지 않게 짧게 기다린 뒤, hover 동안만 연속 이동한다.
    scrollDelayRef.current = setTimeout(() => {
      scrollDelayRef.current = null;
      let last = performance.now();
      const tick = (now: number) => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        viewport.scrollLeft += direction * Math.min(now - last, 40) * 0.18;
        last = now;
        if ((direction === -1 && viewport.scrollLeft <= 0)
          || (direction === 1 && viewport.scrollLeft >= viewport.scrollWidth - viewport.clientWidth - 1)) {
          stopScroll();
          return;
        }
        scrollFrameRef.current = requestAnimationFrame(tick);
      };
      scrollFrameRef.current = requestAnimationFrame(tick);
    }, 180);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const tabs = Array.from(railRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const index = tabs.indexOf(event.currentTarget);
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
    else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === "Home") next = tabs[0];
    else if (event.key === "End") next = tabs[tabs.length - 1];
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const id = event.currentTarget.dataset.memberOpId ?? root;
      setFocusedId(id);
      onPick(id);
      return;
    }
    if (next) {
      event.preventDefault();
      next.focus({ preventScroll: true });
      setFocusedId(next.dataset.memberOpId ?? root);
      keepVisible(next);
    }
  };

  if (nodes.length === 0) return null;
  const chefLabel = t("cluster.picker.coordinator");
  const currentNode = nodes.find(({ member }) => member.operationId === current);
  const chefTip = rootActivity ? `${chefLabel} · ${t(`cluster.picker.activity.${rootActivity}`)}` : chefLabel;
  const showingSuffix = ` · ${t("cluster.nodes.current")}`;
  const ids = [root, ...nodes.map(({ member }) => member.operationId)];
  const activeFocusId = ids.includes(focusedId) ? focusedId : ids.includes(current) ? current : root;
  const stateWord = (progress: OperationClusterProgress): string | null => {
    if (progress === "done") return t("cluster.nodes.state.done");
    if (progress === "running") return t("cluster.picker.state.running");
    if (progress === "awaiting") return t("cluster.picker.state.awaiting");
    if (progress === "open") return t("cluster.picker.state.open");
    return null;
  };
  const scrollButton = (direction: -1 | 1) => {
    const enabled = direction === -1 ? scrollState.left : scrollState.right;
    const awaiting = direction === -1 ? scrollState.awaitingLeft : scrollState.awaitingRight;
    const label = t(direction === -1 ? "cluster.nodes.scrollLeft" : "cluster.nodes.scrollRight");
    return <button
      type="button"
      hidden={!scrollState.overflow}
      className={`cluster-node-scroll${awaiting ? " has-awaiting" : ""}`}
      aria-label={awaiting ? `${label} · ${t("cluster.nodes.scrollAwaiting", { count: awaiting })}` : label}
      aria-disabled={!enabled}
      onPointerEnter={(event) => { if (enabled && event.pointerType === "mouse") startScroll(direction); }}
      onPointerLeave={stopScroll}
      onPointerDown={stopScroll}
      onPointerCancel={stopScroll}
      onClick={() => {
        stopScroll();
        const viewport = viewportRef.current;
        if (enabled && viewport) viewport.scrollBy({ left: direction * Math.max(80, viewport.clientWidth * 0.65), behavior: "instant" });
      }}
    >
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
        <path d={direction === -1 ? "M8 2 4 6l4 4" : "m4 2 4 4-4 4"} />
      </svg>
    </button>;
  };

  return (
    <div ref={railRef} className="cluster-node-rail" role="tablist"
      aria-label={t("cluster.nodes.aria", { current: currentNode ? nodeName(currentNode) : chefLabel })}
      onPointerDown={(event) => event.stopPropagation()} data-canvas-blocker>
      <button type="button" role="tab"
        className={`cluster-node-tab is-commander${current === root ? " is-current" : ""}${rootActivity === "awaiting" ? " is-awaiting" : ""}`}
        aria-selected={current === root} tabIndex={activeFocusId === root ? 0 : -1}
        aria-label={current === root ? chefTip + showingSuffix : chefTip}
        onPointerEnter={(event) => { if (event.pointerType !== "touch") showName(event.currentTarget, chefLabel); }}
        onPointerLeave={(event) => { if (!event.currentTarget.matches(":focus-visible")) setTooltipVisible(false); }}
        onFocus={(event) => showName(event.currentTarget, chefLabel)}
        onBlur={() => setTooltipVisible(false)}
        onClick={() => { setFocusedId(root); onPick(root); }} onKeyDown={onKeyDown}>
        <span className="cluster-member-glyph is-commander" aria-hidden="true"><CoordGlyph /><i className={`cluster-member-status is-${rootActivity ?? "unknown"}`} /></span>
      </button>
      <span className="cluster-node-div" aria-hidden="true" />
      <div ref={membersRef} className="cluster-node-members" onPointerLeave={stopScroll}>
        {scrollButton(-1)}
        <div ref={viewportRef} className="cluster-node-viewport" onScroll={() => {
          measureScroll();
          if (tooltipAnchorRef.current?.matches(":focus-visible")) positionTooltip();
          else setTooltipVisible(false);
        }}>
          <div ref={trackRef} className="cluster-node-track">
            {nodes.map((node) => {
              const { member } = node;
              const on = member.operationId === current;
              const name = nodeName(node);
              const word = stateWord(chipProgress(member));
              const description = name === member.label ? name : `${name} · ${member.label}`;
              const tip = word ? `${description} · ${word}` : description;
              return <button key={member.operationId} type="button" role="tab"
                className={`cluster-node-tab is-member${on ? " is-current" : ""}${awaitingInput(member) ? " is-awaiting" : ""}`}
                aria-selected={on} tabIndex={activeFocusId === member.operationId ? 0 : -1}
                aria-label={on ? tip + showingSuffix : tip} data-member-op-id={member.operationId}
                onPointerEnter={(event) => { if (event.pointerType !== "touch") showName(event.currentTarget, name); }}
                onPointerLeave={(event) => { if (!event.currentTarget.matches(":focus-visible")) setTooltipVisible(false); }}
                onFocus={(event) => { keepVisible(event.currentTarget); showName(event.currentTarget, name); }}
                onBlur={() => setTooltipVisible(false)}
                onClick={() => { setFocusedId(member.operationId); onPick(member.operationId); }} onKeyDown={onKeyDown}>
                <span className={`cluster-member-glyph is-tone-${member.tone ?? "teal"}`} aria-hidden="true">
                  {Array.from(name)[0] ?? "?"}<i className={`cluster-member-status is-${chipProgress(member)}`} />
                </span>
              </button>;
            })}
          </div>
        </div>
        {scrollButton(1)}
      </div>
      {createPortal(<div ref={tooltipRef} className={`cluster-node-tooltip${tooltipVisible ? " is-visible" : ""}`} aria-hidden="true">{tooltipName}</div>, document.body)}
    </div>
  );
}

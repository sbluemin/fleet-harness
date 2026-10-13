import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Translate } from "@fleet-console/sdk/i18n";
import { extensionOf, isLoose, missionReady, unseenRecords, wouldCycle, type Objective, type ObjectiveMission } from "../server/types.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import { graphLayout, type Point } from "./graph-layout.js";
import { GraphPopup, scrollContainer } from "./graph-popup.js";
import { ResultsGlyph } from "./results.js";
import { usePointerDrag } from "./pointer-drag.js";
import "./graph.css";

export type MissionState = "done" | "unplaced" | "ready" | "blocked" | "running" | "awaiting";
export function MissionNodeIcon({ state, number }: { state: MissionState; number: number }) {
  return <span className={`objectives-graph-shape is-${state}`} aria-hidden="true"><span className="objectives-graph-number">{number}</span></span>;
}
/** 노드·상태 셈·대기 안내가 같은 판정을 공유한다. 준비된 첫 임무만 담당의 활동을 받는다. */
export function graphMissionStates(objective: Objective, operationState: (id: string) => string): ReadonlyMap<string, MissionState> {
  const states = new Map<string, MissionState>(), activeMembers = new Set<string>();
  for (const mission of objective.missions) {
    const owner = mission.member ?? objective.id, activity = operationState(owner);
    let state: MissionState = mission.done ? "done" : isLoose(mission) ? "unplaced" : missionReady(objective.missions, mission) ? "ready" : "blocked";
    if (state === "ready" && !activeMembers.has(owner) && ["running", "awaiting"].includes(activity)) {
      state = activity === "awaiting" ? "awaiting" : "running";
      activeMembers.add(owner);
    }
    states.set(mission.id, state);
  }
  return states;
}

export interface MissionDetailActions { close: () => void; select: (id: string) => void; state: MissionState }
interface GraphProps {
  objective: Objective; t: Translate<ObjectiveMessageKey>; states: ReadonlyMap<string, MissionState>;
  onEdge: (from: string, to: string, linked: boolean) => void; canEdit: (id: string) => boolean;
  onShowing: (id: string | null) => void;
  renderDetail: (mission: ObjectiveMission, actions: MissionDetailActions) => ReactNode;
  /** 노드 오른쪽 아래의 담당 표식 — 구성원 id 면 그 구성원, null 이면 지휘관. 보드와 같은 아바타를 패널이 그려 넘긴다. 뿌리 노드도 null 로 지휘관 얼굴을 받는다. */
  ownerMark: (memberId: string | null) => ReactNode;
  reveal?: { id: string; at: number } | null; zoom?: boolean; suspended?: boolean;
  /** 확대 전용 — 세로 그래프가 읽기 좋은 확대 카드의 폭(border-box). 높이는 카드가 스크롤한다. */
  onFitWidth?: (width: number) => void;
}
/** 이 폭부터 이름 오른쪽에 담당 역할을 함께 적고 노드·글자를 한 단계 키운다(시안의 넓은 폭 680, 좁은 폭 380). */
const WIDE = 560;
/** 확대 카드의 폭 — 세로 그래프는 폭보다 높이가 자라므로 이름과 담당이 한눈에 읽히는 폭에 멈추고 높이는 카드가 스크롤한다. */
const ZOOM_WIDTH = 760;
interface Drag { from: string; x0: number; y0: number; x: number; y: number; over: string | null; moved: boolean; pointer: number }
interface Popup { id: string; pinned: boolean; closing: boolean; focus: boolean }
const nodeId = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>("[data-graph-node], [data-graph-label]")?.dataset.graphNode ?? target.closest<HTMLElement>("[data-graph-label]")?.dataset.graphLabel ?? null : null;

export function CoordinationGraph({ objective, t, states, onEdge, canEdit, renderDetail, ownerMark, onShowing, reveal, zoom = false, suspended = false, onFitWidth }: GraphProps) {
  const box = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const wide = width >= WIDE;
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const read = () => setWidth(el.clientWidth || 320);
    read(); const observer = new ResizeObserver(read); observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const onFitWidthRef = useRef(onFitWidth); onFitWidthRef.current = onFitWidth;
  useLayoutEffect(() => { if (zoom) onFitWidthRef.current?.(ZOOM_WIDTH); }, [zoom]);
  const loose = objective.missions.filter(isLoose);
  const extensionLabels = useMemo(() => new Map(objective.missions.flatMap(m => {
    const n = extensionOf(objective.extensions, m.id, "mission");
    return n === null ? [] : [[m.id, t("objectives.extend.chip", { n })] as const];
  })), [objective.missions, objective.extensions, t]);
  // 배치는 임무의 선행 모양과 폭에만 달렸다 — 이름은 레인 오른쪽 칸에서 CSS가 두 줄로 줄이므로 글자를 재지 않는다.
  const shape = useMemo(() => objective.missions.filter(m => !isLoose(m)).map(m => `${m.id}\u0001${m.prerequisites.join(",")}`).join("\u0002"), [objective.missions]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 임무는 shape로 비교한다.
  const layout = useMemo(() => graphLayout(objective.missions.filter(m => !isLoose(m)), width, wide), [shape, width, wide]);
  const [popup, setPopup] = useState<Popup | null>(null), popupRef = useRef(popup); popupRef.current = popup;
  const onShowingRef = useRef(onShowing); onShowingRef.current = onShowing;
  useEffect(() => { onShowingRef.current(popup && !popup.closing && !suspended ? popup.id : null); }, [popup?.id, popup?.closing, suspended]);
  const [drag, setDrag] = useState<Drag | null>(null), dragRef = useRef(drag); dragRef.current = drag;
  const trackDrag = usePointerDrag();
  // 노드·이름에 올리거나 초점을 두면 팝업을 기다리지 않고 선행(실선)·후행(점선)을 밝힌다. 열린 팝업이 있으면 그 임무가 앞선다.
  const [hot, setHot] = useState<string | null>(null);
  const [link, setLink] = useState<{ from: string; over: string } | null>(null);
  const popupId = useId();
  const timers = useRef<{ open?: ReturnType<typeof setTimeout>; close?: ReturnType<typeof setTimeout>; exit?: ReturnType<typeof setTimeout>; pending?: string; last?: Point }>({});
  const cancelOpen = () => { clearTimeout(timers.current.open); timers.current.pending = undefined; };
  const keep = () => { clearTimeout(timers.current.close); timers.current.close = undefined; };
  const close = (focus = false) => {
    cancelOpen(); keep(); clearTimeout(timers.current.exit);
    const old = popupRef.current;
    if (focus && old) box.current?.querySelector<HTMLElement>(`[data-graph-node="${CSS.escape(old.id)}"]`)?.focus({ preventScroll: true });
    if (!old) return;
    setPopup({ ...old, pinned: false, closing: true });
    timers.current.exit = setTimeout(() => setPopup(null), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 120);
  };
  const closeOffscreen = (container: HTMLElement) => {
    cancelOpen(); keep(); clearTimeout(timers.current.exit);
    if (document.getElementById(popupId)?.contains(document.activeElement)) {
      const tabIndex = container.getAttribute("tabindex");
      if (tabIndex === null) container.setAttribute("tabindex", "-1");
      const restore = () => { if (tabIndex === null && container.getAttribute("tabindex") === "-1") container.removeAttribute("tabindex"); };
      container.focus({ preventScroll: true });
      if (document.activeElement === container) container.addEventListener("blur", restore, { once: true }); else restore();
    }
    popupRef.current = null;
    setPopup(null);
  };
  const leave = (delay = 150) => {
    cancelOpen();
    if (popupRef.current?.pinned || popupRef.current?.closing) return;
    keep(); timers.current.close = setTimeout(() => close(), delay);
  };
  const show = (id: string, pinned = false, focus = false) => {
    cancelOpen(); keep(); clearTimeout(timers.current.exit);
    setPopup({ id, pinned, closing: false, focus });
  };
  const select = (id: string) => { box.current?.querySelector<HTMLElement>(`[data-graph-node="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" }); show(id, true, true); };
  useEffect(() => () => { clearTimeout(timers.current.open); clearTimeout(timers.current.close); clearTimeout(timers.current.exit); }, []);
  useEffect(() => { if (suspended) { cancelOpen(); keep(); setPopup(null); } }, [suspended]);
  useEffect(() => { if (reveal && !suspended && objective.missions.some(m => m.id === reveal.id)) select(reveal.id); }, [reveal, suspended]);
  useEffect(() => { if (popup && !objective.missions.some(m => m.id === popup.id)) { setPopup(null); cancelOpen(); } }, [objective.missions]);
  useEffect(() => {
    if (!popup || popup.closing) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (document.getElementById(popupId)?.contains(target)) return;
      if (box.current?.contains(target) && nodeId(target)) return;
      close();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(true); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [popup, popupId]);
  const safeTriangle = (p: Point) => {
    const pop = document.getElementById(popupId), last = timers.current.last;
    if (!pop || !last) return false;
    const b = pop.getBoundingClientRect(), side = pop.dataset.side;
    const corners: Point[] = side === "right" ? [{ x: b.left, y: b.top }, { x: b.left, y: b.bottom }] : side === "left" ? [{ x: b.right, y: b.top }, { x: b.right, y: b.bottom }] : side === "below" ? [{ x: b.left, y: b.top }, { x: b.right, y: b.top }] : [{ x: b.left, y: b.bottom }, { x: b.right, y: b.bottom }];
    const sign = (a: Point, b: Point, c: Point) => (a.x - c.x) * (b.y - c.y) - (b.x - c.x) * (a.y - c.y);
    const d = [sign(p, last, corners[0]!), sign(p, corners[0]!, corners[1]!), sign(p, corners[1]!, last)];
    return !(d.some(v => v < 0) && d.some(v => v > 0)) && Math.hypot(p.x - last.x, p.y - last.y) > .5;
  };
  const hover = (event: ReactPointerEvent) => {
    if (suspended || event.pointerType === "touch" || dragRef.current) return;
    const p = { x: event.clientX, y: event.clientY }, id = nodeId(event.target);
    if (!(event.target as Element).closest("[data-graph-popup]")) setHot(id);
    if (popupRef.current?.pinned || link) return;
    if ((event.target as Element).closest("[data-graph-popup]")) { keep(); cancelOpen(); }
    else if (id) {
      keep();
      if (popupRef.current?.id === id && !popupRef.current.closing) cancelOpen();
      else if (popupRef.current && !popupRef.current.closing && safeTriangle(p)) {
        // 팝업으로 이동할 때 지나는 노드로 바뀌지 않도록 통로를 보호한다.
        cancelOpen(); timers.current.open = setTimeout(() => show(id), 90);
      } else if (popupRef.current && !popupRef.current.closing) show(id);
      else if (timers.current.pending !== id) {
        cancelOpen(); timers.current.pending = id;
        timers.current.open = setTimeout(() => show(id), 200);
      }
    } else if (popupRef.current && !popupRef.current.closing && safeTriangle(p)) leave(320);
    else if (!timers.current.close) leave();
    timers.current.last = p;
  };
  const check = (from: string, to: string) => {
    const target = objective.missions.find(m => m.id === to);
    if (!target || from === to) return t("objectives.graph.same");
    if (target.prerequisites.includes(from)) return t("objectives.graph.existing");
    if (wouldCycle(objective.missions, from, to)) return t("objectives.graph.cycle");
    if (!canEdit(to) || (objective.missions.some(m => m.id === from && isLoose(m)) && !canEdit(from))) return t("objectives.graph.locked");
    return null;
  };
  const commitLink = (from: string, to: string) => { if (!check(from, to)) onEdge(from, to, true); };
  const start = (id: string, event: ReactPointerEvent) => {
    if (!box.current || suspended) return;
    trackDrag(event, box.current, {
      onStart: () => {
        cancelOpen(); keep();
        const next = { from: id, x0: event.clientX, y0: event.clientY, x: event.clientX, y: event.clientY, over: null, moved: false, pointer: event.pointerId };
        dragRef.current = next; setDrag(next);
      },
      onMove: (move) => {
        const old = dragRef.current; if (!old) return;
        const moved = old.moved || Math.hypot(move.clientX - old.x0, move.clientY - old.y0) > 6;
        const hit = nodeId(document.elementFromPoint(move.clientX, move.clientY));
        const next = { ...old, x: move.clientX, y: move.clientY, moved, over: hit && hit !== old.from ? hit : null };
        dragRef.current = next; setDrag(next);
      },
      onEnd: (end) => {
        const old = dragRef.current;
        dragRef.current = null; setDrag(null);
        if (!old) return;
        if (!end) { if (!popupRef.current?.pinned) close(); return; }
        if (old.moved) { const hit = nodeId(document.elementFromPoint(end.clientX, end.clientY)); if (hit) commitLink(old.from, hit); if (!popupRef.current?.pinned) close(); }
        else if (link) { commitLink(link.from, old.from); setLink(null); }
        else if (popupRef.current?.id === old.from && popupRef.current.pinned) close();
        else show(old.from, true, true);
      },
    });
  };
  useEffect(() => {
    if (!drag?.moved) return;
    let frame = 0;
    // 세로 그래프는 높이가 자라 상세(또는 확대 카드)가 스크롤한다 — 탭·칸 구조와 무관하게 실제로 스크롤하는 가장 가까운 상자를 끈다.
    const detail = box.current ? scrollContainer(box.current) : null;
    const tick = () => {
      const current = dragRef.current, el = scroll.current; if (!current || !el) return;
      const b = el.getBoundingClientRect();
      if (current.x < b.left + 28) el.scrollLeft -= 8; else if (current.x > b.right - 28) el.scrollLeft += 8;
      if (detail) { const d = detail.getBoundingClientRect(); if (current.y < d.top + 28) detail.scrollTop -= 8; else if (current.y > d.bottom - 28) detail.scrollTop += 8; }
      const hit = nodeId(document.elementFromPoint(current.x, current.y));
      if (hit !== current.over && hit !== current.from) { const next = { ...current, over: hit }; dragRef.current = next; setDrag(next); }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [drag?.moved]);
  const current = popup && !popup.closing ? objective.missions.find(m => m.id === popup.id) : null;
  const lit = current ?? (hot && !drag?.moved && !suspended ? objective.missions.find(m => m.id === hot && !isLoose(m)) ?? null : null);
  const number = (id: string) => objective.missions.findIndex(m => m.id === id) + 1;
  const resultCounts = new Map<string, number>();
  for (const result of objective.results) if (result.sourceMissionId) resultCounts.set(result.sourceMissionId, (resultCounts.get(result.sourceMissionId) ?? 0) + 1);
  const from = drag?.moved ? drag.from : link?.from, over = drag?.moved ? drag.over : link?.over;
  const reason = from && over ? check(from, over) : null;
  const targetNode = over ? box.current?.querySelector<HTMLElement>(`[data-graph-node="${CSS.escape(over)}"]`) : null;
  // 끌어 잇는 동안에만 잰다 — 렌더마다 재면 레일 폭이 바뀌는 매 커밋이 페이지 레이아웃을 강제로 한 번 더 돈다.
  const tipRect = targetNode?.getBoundingClientRect(), boxRect = targetNode ? box.current?.getBoundingClientRect() : undefined;
  const focusNode = (id: string) => {
    const n = box.current?.querySelector<HTMLElement>(`[data-graph-node="${CSS.escape(id)}"]`);
    n?.focus({ preventScroll: true }); n?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (link) setLink({ ...link, over: id });
  };
  const icon = (m: ObjectiveMission) => <><MissionNodeIcon state={states.get(m.id)!} number={number(m.id)} /><span className="objectives-graph-mark" aria-hidden="true">{ownerMark(m.member ?? null)}</span>{m.records.length ? <span className={`objectives-graph-record${unseenRecords(m) ? " is-new" : ""}`} aria-hidden="true" /> : null}{resultCounts.has(m.id) ? <span className="objectives-graph-results" aria-hidden="true"><ResultsGlyph /></span> : null}</>;
  const node = (m: ObjectiveMission, style?: CSSProperties) => {
    const active = current?.id === m.id, pre = lit?.prerequisites.includes(m.id), post = lit && m.prerequisites.includes(lit.id);
    const member = objective.members.find(member => member.id === m.member)?.role ?? t("objectives.graph.commander");
    return <button key={m.id} type="button" data-graph-node={m.id} data-mission-id={m.id} className={`objectives-graph-node is-${states.get(m.id)}${active ? popup?.pinned ? " is-pin" : " is-hov" : lit?.id === m.id ? " is-hov" : ""}${pre ? " is-pre" : ""}${post ? " is-post" : ""}${over === m.id ? reason ? " drop-no" : " drop-ok" : ""}`} style={style} aria-label={`${t("objectives.graph.nodeAria", { index: number(m.id), text: m.text })}. ${member}. ${t(`objectives.graph.state.${states.get(m.id)!}`)}. ${m.records.length ? t("objectives.records.count", { index: number(m.id), count: m.records.length }) : ""}${unseenRecords(m) ? ` · ${t("objectives.records.unseen", { count: unseenRecords(m) })}` : ""}${resultCounts.has(m.id) ? ` · ${t("objectives.graph.results", { count: resultCounts.get(m.id)! })}` : ""}`} title={resultCounts.has(m.id) ? t("objectives.graph.results", { count: resultCounts.get(m.id)! }) : undefined} aria-expanded={active} aria-controls={active ? popupId : undefined} onPointerDown={e => start(m.id, e)} onClick={e => { if (e.detail === 0) { if (link) { commitLink(link.from, m.id); setLink(null); } else if (active && popup?.pinned) close(true); else show(m.id, true, true); } }} onFocus={e => { setHot(m.id); if (e.currentTarget.matches(":focus-visible") && !popupRef.current?.pinned && !link) show(m.id); }} onBlur={e => { setHot(null); if (!document.getElementById(popupId)?.contains(e.relatedTarget as Node)) leave(); }} onKeyDown={e => {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); setLink(null); close(true); }
      else if (e.key.toLowerCase() === "l") { e.preventDefault(); close(); setLink({ from: m.id, over: m.id }); }
      else if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(e.key)) { e.preventDefault(); const index = number(m.id) - 1, next = objective.missions[index + (["ArrowDown", "ArrowRight"].includes(e.key) ? 1 : -1)]; if (next) focusNode(next.id); }
      else if (e.key === "Tab" && !e.shiftKey && active) { e.preventDefault(); show(m.id, true, true); }
    }}>{icon(m)}</button>;
  };
  const shownMission = popup ? objective.missions.find(m => m.id === popup.id) : null;
  const owner = (m: ObjectiveMission) => objective.members.find(member => member.id === m.member)?.role ?? t("objectives.graph.commander");
  const litLabel = (m: ObjectiveMission) => !!lit && (lit.id === m.id || lit.prerequisites.includes(m.id) || m.prerequisites.includes(lit.id));
  return <div ref={box} className={`objectives-branch-graph${zoom ? " is-zoom" : ""}${wide ? " is-wide" : ""}${drag?.moved ? " is-dragging" : ""}`} style={{ "--graph-r": `${layout.g.r}px`, "--graph-label-line": `${layout.g.llh}px` } as CSSProperties} onPointerMove={hover} onPointerLeave={() => { setHot(null); if (!dragRef.current) leave(); }}>
    <div ref={scroll} className="objectives-graph-scroll" onScroll={() => { if (popupRef.current && !popupRef.current.pinned) close(); }}>
      <div className={`objectives-graph-canvas${lit ? " is-dim" : ""}`} style={{ width: layout.width, height: layout.height }}>
        <svg className="objectives-graph-edges" width={layout.width} height={layout.height} aria-hidden="true">{layout.edges.map(e => <path key={`${e.from}-${e.to}`} data-from={e.from ?? undefined} data-to={e.to} className={`objectives-graph-edge${e.from ? "" : " is-root"}${lit?.id === e.to ? " is-up" : lit && lit.id === e.from ? " is-down" : ""}`} d={e.d} onClick={() => select(e.to)} />)}</svg>
        <span className="objectives-graph-root" style={{ left: layout.root.x, top: layout.root.y, "--graph-root": `${layout.g.rootR * 2}px` } as CSSProperties} aria-hidden="true">{ownerMark(null)}</span><span className="objectives-graph-label is-root" style={{ left: layout.labelX, right: layout.g.pad, top: layout.root.y }}><span className="objectives-graph-name">{t("objectives.graph.commander")}</span></span>
        {/* 이름은 모든 레인 오른쪽의 같은 칸에 제 줄의 높이로 선다 — 두 줄까지 보이고 나머지는 팝업에 있다. 넓은 폭은 오른쪽 끝에 담당 역할을 적는다. */}
        {objective.missions.filter(m => !isLoose(m)).map(m => { const p = layout.pos.get(m.id)!, extension = extensionLabels.get(m.id); return <span key={m.id}>{node(m, { left: p.x, top: p.y })}<span data-graph-label={m.id} className={`objectives-graph-label is-${states.get(m.id)}${litLabel(m) ? " is-lit" : ""}`} style={{ left: layout.labelX, right: layout.g.pad, top: p.y }} onPointerDown={e => start(m.id, e)}>{extension ? <span className="objectives-extension-chip">{extension}</span> : null}<span className="objectives-graph-name">{m.text}</span>{wide ? <span className="objectives-graph-owner">{owner(m)}</span> : null}</span></span>; })}
      </div>
    </div>
    {loose.length ? <div className="objectives-graph-tray"><span className="objectives-graph-tray-title">{t("objectives.graph.unplaced")}</span>{loose.map(m => <div className="objectives-graph-tray-item" key={m.id}>{node(m)}{extensionLabels.get(m.id) ? <span className="objectives-extension-chip">{extensionLabels.get(m.id)}</span> : null}<span className="objectives-graph-tray-label" data-graph-label={m.id} onPointerDown={e => start(m.id, e)}>{m.text}</span></div>)}</div> : null}
    {drag?.moved ? <svg className="objectives-graph-dragline" aria-hidden="true"><path className={reason ? "is-no" : undefined} d={`M${drag.x0},${drag.y0} L${drag.x},${drag.y}`} /></svg> : null}
    {from && over && tipRect && boxRect ? <div className={`objectives-graph-drop-tip${reason ? " is-no" : ""}`} role="status" style={{ left: Math.max(4, Math.min(width - 224, tipRect.left - boxRect.left)), top: tipRect.bottom - boxRect.top + 6 }}><b>{reason ?? t("objectives.graph.drop", { from: number(from), to: number(over) })}</b>{reason ? null : <span>{t("objectives.graph.direction", { from: number(from), to: number(over) })}</span>}</div> : null}
    {popup && shownMission && box.current && !suspended ? <GraphPopup id={popupId} missionId={popup.id} layout={layout} boundary={box.current} pinned={popup.pinned} closing={popup.closing} focus={popup.focus} hidden={!!drag?.moved} label={t("objectives.graph.detail", { n: number(shownMission.id) })} onKeep={keep} onMove={hover} onLeave={() => leave()} onPin={() => { if (!popup.pinned) show(popup.id, true); }} onEscape={() => close(true)} onAnchorLeave={closeOffscreen}>{renderDetail(shownMission, { close: () => close(true), select, state: states.get(shownMission.id)! })}</GraphPopup> : null}
  </div>;
}

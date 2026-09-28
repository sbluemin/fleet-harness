import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Translate } from "@fleet-console/sdk/i18n";
import { isLoose, missionReady, unseenRecords, wouldCycle, type Objective, type ObjectiveMission } from "../server/types.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import { graphLayout, type Point } from "./graph-layout.js";
import { GraphPopup } from "./graph-popup.js";
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
    if (state === "ready" && !activeMembers.has(owner) && ["running", "background", "awaiting"].includes(activity)) {
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
  reveal?: { id: string; at: number } | null; zoom?: boolean; suspended?: boolean;
}
interface Drag { from: string; x0: number; y0: number; x: number; y: number; over: string | null; moved: boolean; pointer: number }
interface Popup { id: string; pinned: boolean; closing: boolean }
const nodeId = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>("[data-graph-node], [data-graph-label]")?.dataset.graphNode ?? target.closest<HTMLElement>("[data-graph-label]")?.dataset.graphLabel ?? null : null;

export function CoordinationGraph({ objective, t, states, onEdge, canEdit, renderDetail, onShowing, reveal, zoom = false, suspended = false }: GraphProps) {
  const box = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320), [font, setFont] = useState("11px sans-serif");
  const wide = width >= 700;
  const [fontEpoch, setFontEpoch] = useState(0);
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const read = () => { setWidth(el.clientWidth || 320); const style = getComputedStyle(el); setFont(`${style.fontWeight} ${el.clientWidth >= 700 ? 12 : 11}px ${style.fontFamily}`); };
    read(); const observer = new ResizeObserver(read); observer.observe(el);
    let alive = true; void document.fonts.ready.then(() => { if (alive) { read(); setFontEpoch(1); } });
    return () => { alive = false; observer.disconnect(); };
  }, []);
  const loose = objective.missions.filter(isLoose);
  const layout = useMemo(() => {
    const context = document.createElement("canvas").getContext("2d");
    if (context) context.font = font;
    const measure = (s: string) => context?.measureText(s).width ?? [...s].length * (wide ? 12 : 11);
    return graphLayout(objective.missions.filter(m => !isLoose(m)), width, wide, measure, t("objectives.graph.commander"));
  }, [objective.missions, width, wide, font, fontEpoch, t]);
  const marks = new Map<string, string>(), used = new Set<string>();
  for (const member of objective.members) { const mark = [...member.role.replace(/\s/g, "")].find(c => !used.has(c)) ?? String(marks.size + 1); marks.set(member.id, mark); used.add(mark); }
  const [popup, setPopup] = useState<Popup | null>(null), popupRef = useRef(popup); popupRef.current = popup;
  const onShowingRef = useRef(onShowing); onShowingRef.current = onShowing;
  useEffect(() => { onShowingRef.current(popup && !popup.closing && !suspended ? popup.id : null); }, [popup?.id, popup?.closing, suspended]);
  const [drag, setDrag] = useState<Drag | null>(null), dragRef = useRef(drag); dragRef.current = drag;
  const trackDrag = usePointerDrag();
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
  const leave = (delay = 150) => {
    cancelOpen();
    if (popupRef.current?.pinned || popupRef.current?.closing) return;
    keep(); timers.current.close = setTimeout(() => close(), delay);
  };
  const show = (id: string, pinned = false, focus = false) => {
    cancelOpen(); keep(); clearTimeout(timers.current.exit);
    setPopup({ id, pinned, closing: false });
    if (focus) requestAnimationFrame(() => (document.getElementById(popupId)?.querySelector<HTMLElement>("textarea") ?? document.getElementById(popupId)?.querySelector<HTMLElement>("button:not(:disabled)"))?.focus({ preventScroll: true }));
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
    if (suspended || event.pointerType === "touch" || dragRef.current || popupRef.current?.pinned || link) return;
    const p = { x: event.clientX, y: event.clientY }, id = nodeId(event.target);
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
    const tick = () => {
      const current = dragRef.current, el = scroll.current; if (!current || !el) return;
      const b = el.getBoundingClientRect();
      if (current.x < b.left + 28) el.scrollLeft -= 8; else if (current.x > b.right - 28) el.scrollLeft += 8;
      // 두 칸의 pane은 display:contents다. 각 레이아웃에서 실제로 스크롤하는 상자를 고른다.
      const detail = box.current?.closest<HTMLElement>(".objectives-detail:not(.is-three) .objectives-detail-scroll, .objectives-detail.is-three .objectives-detail-pane, .objectives-zoom");
      if (detail) { const d = detail.getBoundingClientRect(); if (current.y < d.top + 28) detail.scrollTop -= 8; else if (current.y > d.bottom - 28) detail.scrollTop += 8; }
      const hit = nodeId(document.elementFromPoint(current.x, current.y));
      if (hit !== current.over && hit !== current.from) { const next = { ...current, over: hit }; dragRef.current = next; setDrag(next); }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [drag?.moved]);
  const current = popup && !popup.closing ? objective.missions.find(m => m.id === popup.id) : null;
  const number = (id: string) => objective.missions.findIndex(m => m.id === id) + 1;
  const from = drag?.moved ? drag.from : link?.from, over = drag?.moved ? drag.over : link?.over;
  const reason = from && over ? check(from, over) : null;
  const targetNode = over ? box.current?.querySelector<HTMLElement>(`[data-graph-node="${CSS.escape(over)}"]`) : null;
  const tipRect = targetNode?.getBoundingClientRect(), boxRect = box.current?.getBoundingClientRect();
  const focusNode = (id: string) => {
    const n = box.current?.querySelector<HTMLElement>(`[data-graph-node="${CSS.escape(id)}"]`);
    n?.focus({ preventScroll: true }); n?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (link) setLink({ ...link, over: id });
  };
  const icon = (m: ObjectiveMission) => <><MissionNodeIcon state={states.get(m.id)!} number={number(m.id)} /><span className={`objectives-member-mark objectives-graph-mark ${m.member ? `is-tone-${Math.max(0, objective.members.findIndex(member => member.id === m.member)) % 8}` : "is-commander"}`} aria-hidden="true">{m.member ? marks.get(m.member) : "★"}</span>{m.records.length ? <span className={`objectives-graph-record${unseenRecords(m) ? " is-new" : ""}`} aria-hidden="true" /> : null}</>;
  const node = (m: ObjectiveMission, style?: CSSProperties) => {
    const active = current?.id === m.id, pre = current?.prerequisites.includes(m.id), post = current && m.prerequisites.includes(current.id);
    const member = objective.members.find(member => member.id === m.member)?.role ?? t("objectives.graph.commander");
    return <button key={m.id} type="button" data-graph-node={m.id} data-mission-id={m.id} className={`objectives-graph-node is-${states.get(m.id)}${active ? popup?.pinned ? " is-pin" : " is-hov" : ""}${pre ? " is-pre" : ""}${post ? " is-post" : ""}${over === m.id ? reason ? " drop-no" : " drop-ok" : ""}`} style={style} aria-label={`${t("objectives.graph.nodeAria", { index: number(m.id), text: m.text })}. ${member}. ${t(`objectives.graph.state.${states.get(m.id)!}`)}. ${m.records.length ? t("objectives.records.count", { index: number(m.id), count: m.records.length }) : ""}${unseenRecords(m) ? ` · ${t("objectives.records.unseen", { count: unseenRecords(m) })}` : ""}`} aria-expanded={active} aria-controls={active ? popupId : undefined} onPointerDown={e => start(m.id, e)} onClick={e => { if (e.detail === 0) { if (link) { commitLink(link.from, m.id); setLink(null); } else if (active && popup?.pinned) close(true); else show(m.id, true, true); } }} onFocus={e => { if (e.currentTarget.matches(":focus-visible") && !popupRef.current?.pinned && !link) show(m.id); }} onBlur={e => { if (!document.getElementById(popupId)?.contains(e.relatedTarget as Node)) leave(); }} onKeyDown={e => {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); setLink(null); close(true); }
      else if (e.key.toLowerCase() === "l") { e.preventDefault(); close(); setLink({ from: m.id, over: m.id }); }
      else if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(e.key)) { e.preventDefault(); const index = number(m.id) - 1, next = objective.missions[index + (["ArrowDown", "ArrowRight"].includes(e.key) ? 1 : -1)]; if (next) focusNode(next.id); }
      else if (e.key === "Tab" && !e.shiftKey && active) { e.preventDefault(); show(m.id, true, true); }
    }}>{icon(m)}</button>;
  };
  const shownMission = popup ? objective.missions.find(m => m.id === popup.id) : null;
  return <div ref={box} className={`objectives-branch-graph${zoom ? " is-zoom" : ""}${wide ? " is-wide" : ""}${drag?.moved ? " is-dragging" : ""}`} style={{ "--graph-r": `${layout.g.r}px`, "--graph-label-line": `${layout.g.llh}px` } as CSSProperties} onPointerMove={hover} onPointerLeave={() => { if (!dragRef.current) leave(); }}>
    <div ref={scroll} className="objectives-graph-scroll" onScroll={() => { if (popupRef.current && !popupRef.current.pinned) close(); }}>
      <div className={`objectives-graph-canvas${current ? " is-dim" : ""}`} style={{ width: layout.width, height: layout.height }}>
        <svg className="objectives-graph-edges" width={layout.width} height={layout.height} aria-hidden="true">{layout.edges.map(e => <path key={`${e.from}-${e.to}`} data-from={e.from ?? undefined} data-to={e.to} className={`objectives-graph-edge${e.from ? "" : " is-root"}${current?.id === e.to ? " is-up" : current?.id === e.from ? " is-down" : ""}`} d={e.d} onClick={() => select(e.to)} />)}</svg>
        <span className="objectives-graph-root" style={{ left: layout.root.x, top: layout.root.y }} /><span className="objectives-graph-label is-root" style={{ left: layout.rootLabel.x, top: layout.rootLabel.y }}>{t("objectives.graph.commander")}</span>
        {objective.missions.filter(m => !isLoose(m)).map(m => { const p = layout.pos.get(m.id)!, label = layout.labels.get(m.id); return <span key={m.id}>{node(m, { left: p.x, top: p.y })}{label ? <span data-graph-label={m.id} className={`objectives-graph-label is-${states.get(m.id)}${current && (current.id === m.id || current.prerequisites.includes(m.id) || m.prerequisites.includes(current.id)) ? " is-lit" : ""}`} style={{ left: label.x, top: label.y, width: label.w }} onPointerDown={e => start(m.id, e)}>{label.lines.map((line, i) => <span key={i}>{line}</span>)}</span> : null}</span>; })}
      </div>
    </div>
    {loose.length ? <div className="objectives-graph-tray"><span className="objectives-graph-tray-title">{t("objectives.graph.unplaced")}</span>{loose.map(m => <div className="objectives-graph-tray-item" key={m.id}>{node(m)}<span className="objectives-graph-tray-label" data-graph-label={m.id} onPointerDown={e => start(m.id, e)}>{m.text}</span></div>)}</div> : null}
    {drag?.moved ? <svg className="objectives-graph-dragline" aria-hidden="true"><path className={reason ? "is-no" : undefined} d={`M${drag.x0},${drag.y0} L${drag.x},${drag.y}`} /></svg> : null}
    {from && over && tipRect && boxRect ? <div className={`objectives-graph-drop-tip${reason ? " is-no" : ""}`} role="status" style={{ left: Math.max(4, Math.min(width - 224, tipRect.left - boxRect.left)), top: tipRect.bottom - boxRect.top + 6 }}><b>{reason ?? t("objectives.graph.drop", { from: number(from), to: number(over) })}</b>{reason ? null : <span>{t("objectives.graph.direction", { from: number(from), to: number(over) })}</span>}</div> : null}
    {popup && shownMission && box.current && !suspended ? <GraphPopup id={popupId} missionId={popup.id} layout={layout} boundary={box.current} pinned={popup.pinned} closing={popup.closing} hidden={!!drag?.moved} label={t("objectives.graph.detail", { n: number(shownMission.id) })} onKeep={keep} onMove={hover} onLeave={() => leave()} onPin={() => { if (!popup.pinned) show(popup.id, true); }} onEscape={() => close(true)}>{renderDetail(shownMission, { close: () => close(true), select, state: states.get(shownMission.id)! })}</GraphPopup> : null}
  </div>;
}

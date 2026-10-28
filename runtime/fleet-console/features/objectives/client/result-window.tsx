import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { ConsoleLocale } from "@fleet-console/i18n";
import { useSelect, type SelectOption } from "@fleet-console/ui/react";
import { missionTitle, type Objective, type ObjectiveResult } from "../shared/types.js";
import type { SharedFolderEntry } from "../shared/shared-folder.js";
import { getT } from "./i18n/index.js";
import { findAnyObjective, subscribeObjectiveOrFinished } from "./objectives-state.js";
import { absolute, bytesLabel, EvidenceTextContent, PrRow, resultFileUrl, useNow } from "./result-content.js";
import { usePointerDrag } from "./pointer-drag.js";
import { LinkText } from "./link-text.js";
import { sharedFileUrl } from "./shared-folder-url.js";
import "./result-window.css";

// 레일·탭의 수명 밖에 둔다. 선택한 목표가 아니라 창을 연 목표의 현재 보드를 계속 읽는다.
// `shared` 가 있으면 증거 대신 그 목표 공유 폴더의 파일 하나를 같은 창에 읽기 전용으로 보인다.
type Selection = { readonly objectiveId: string; readonly resultId: string | null; readonly opener: HTMLElement | null; readonly shared?: SharedFolderEntry };
let selection: Selection | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => selection;
function updateSelection(next: Selection | null) { selection = next; for (const listener of listeners) listener(); }
const RECT_KEY = "fleet.objectives.result-window.rect";

export function openResultWindow(objectiveId: string, resultId: string, opener: HTMLElement | null = null): void {
  updateSelection({ objectiveId, resultId, opener });
}
export function openSharedFolderWindow(objectiveId: string, shared: SharedFolderEntry, opener: HTMLElement | null = null): void {
  updateSelection({ objectiveId, resultId: null, opener, shared });
}
export function resetResultWindow(): void { updateSelection(null); }

function visibleComposer(): HTMLTextAreaElement | undefined {
  return [...document.querySelectorAll<HTMLTextAreaElement>(".agent-chat-composer-input, .group-composer-input, .fc-composer-input")]
    .find((node) => !node.disabled && node.getClientRects().length > 0 && !node.closest("[hidden], [inert]"));
}

function closeWindow() {
  const opener = selection?.opener;
  updateSelection(null);
  if (opener?.isConnected && opener.getClientRects().length && !opener.closest("[hidden], [inert]")) {
    opener.focus({ preventScroll: true });
    return;
  }
  // 연 단추가 탭 전환으로 사라졌으면, 현재 화면의 채팅 입력으로 돌아간다. 대화 전환·초안 변경은 하지 않는다.
  visibleComposer()?.focus({ preventScroll: true });
}

type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
type Direction = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const DIRECTIONS: readonly Direction[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const GAP = 12, MIN_W = 360, MIN_H = 260;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
function fit(rect: Rect): Rect {
  const maxW = Math.max(1, window.innerWidth - GAP * 2), maxH = Math.max(1, window.innerHeight - GAP * 2);
  const w = clamp(rect.w, Math.min(MIN_W, maxW), maxW), h = clamp(rect.h, Math.min(MIN_H, maxH), maxH);
  return { x: clamp(rect.x, GAP, window.innerWidth - GAP - w), y: clamp(rect.y, GAP, window.innerHeight - GAP - h), w, h };
}
function defaultRect(): Rect {
  const railLeft = document.querySelector(".objectives-container")?.getBoundingClientRect().left ?? window.innerWidth;
  const composerTop = visibleComposer()?.getBoundingClientRect().top ?? window.innerHeight - 76;
  return fit({ x: (railLeft > MIN_W + GAP * 2 ? railLeft : window.innerWidth) - 732, y: 72, w: 720, h: Math.min(560, composerTop - 84) });
}
function initialRect(): Rect {
  try {
    const value = JSON.parse(localStorage.getItem(RECT_KEY) ?? "null") as Rect | null;
    if (value && [value.x, value.y, value.w, value.h].every((part) => typeof part === "number" && Number.isFinite(part))) return fit(value);
  } catch { /* 저장소 없이도 화면 안에서 연다. */ }
  return defaultRect();
}
function saveRect(rect: Rect) { try { localStorage.setItem(RECT_KEY, JSON.stringify(rect)); } catch { /* 선택적 편의 상태 */ } }

export function ResultWindowHost({ language = "en", mobile = false }: { readonly language?: ConsoleLocale; readonly mobile?: boolean }) {
  const opened = useSyncExternalStore(subscribe, snapshot, snapshot);
  const objective = useSyncExternalStore(subscribeObjectiveOrFinished, () => opened ? findAnyObjective(opened.objectiveId) : null, () => null);
  // 목표가 지워져도 명시적 닫기 전까지 창 틀은 남고, 오래된 증거를 다시 보여 주지는 않는다.
  return opened ? createPortal(<ResultWindow opened={opened} objective={objective} language={language} mobile={mobile} />, document.body) : null;
}

function ResultWindow({ opened, objective, language, mobile }: { readonly opened: Selection; readonly objective: Objective | null; readonly language: ConsoleLocale; readonly mobile: boolean }) {
  const t = getT(language);
  const now = useNow();
  const rootRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState(initialRect);
  const [dragging, setDragging] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const drag = usePointerDrag();
  const groups = objective ? objective.missions.map((mission, index) => ({ id: mission.id, n: index + 1, title: missionTitle(mission), record: mission.records.at(-1), results: objective.results.filter((result) => result.sourceMissionId === mission.id) })).filter((group) => group.results.length > 0) : [];
  const loose = objective?.results.filter((result) => !result.sourceMissionId || !objective.missions.some((mission) => mission.id === result.sourceMissionId)) ?? [];
  if (loose.length) groups.push({ id: "loose", n: 0, title: t("objectives.results.loose"), record: undefined, results: loose });
  const ordered = groups.flatMap((group) => group.results);
  const result = ordered.find((item) => item.id === opened.resultId) ?? ordered[0] ?? null;
  const group = groups.find((item) => item.results.some((entry) => entry.id === result?.id));
  const index = ordered.findIndex((item) => item.id === result?.id);
  const choose = (id: string) => {
    // 다음 종류에서 사라지는 이미지 화살표에 초점을 남기지 않는다. 채팅 초점은 건드리지 않는다.
    if (document.activeElement?.classList.contains("objectives-att-view-step")) rootRef.current?.focus({ preventScroll: true });
    updateSelection({ ...opened, resultId: id });
  };
  const chooseGroup = (id: string) => { const first = groups.find((item) => item.id === id)?.results[0]; if (first) choose(first.id); };
  const shared = opened.shared ?? null;
  const sharedName = shared?.path.split("/").at(-1) ?? "";
  const heading = t(shared ? "objectives.shared.title" : "objectives.results.title");
  const title = shared ? sharedName : result ? result.kind === "evidence" ? result.label ?? result.name : result.kind === "pr" ? result.label ?? result.observation.title ?? `${result.owner}/${result.repo} #${result.number}` : result.label ?? t("objectives.results.artifact.untitled") : t("objectives.results.title");
  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, [opened.opener, opened.objectiveId]);
  useEffect(() => {
    rootRef.current?.querySelector(".objectives-rw-strip [aria-current=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [opened.objectiveId, result?.id]);
  useEffect(() => {
    const resize = () => setRect((current) => fit(current));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || !root.contains(document.activeElement) || root.closest("[inert]") || event.defaultPrevented || event.isComposing) return;
      if (event.target instanceof Element && (event.target.closest(".objectives-rw-menu") || event.target.closest(".objectives-rw-switch") && (event.key !== "Escape" || event.target.closest("[aria-expanded=true]")))) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeWindow(); return; }
      if (mobile && event.key === "Tab") {
        const focusable = [...root.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], [tabindex='0']")].filter((node) => node.getClientRects().length > 0);
        const at = focusable.indexOf(document.activeElement as HTMLElement);
        if (focusable.length && (at < 0 || (event.shiftKey ? at === 0 : at === focusable.length - 1))) {
          event.preventDefault(); focusable[event.shiftKey ? focusable.length - 1 : 0]!.focus();
        }
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true], .objectives-result-markdown"))) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault(); event.stopPropagation();
        const next = ordered[index + (event.key === "ArrowLeft" ? -1 : 1)];
        if (next) choose(next.id);
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault(); event.stopPropagation();
        const next = groups[groups.findIndex((item) => item.id === group?.id) + (event.key === "ArrowUp" ? -1 : 1)];
        if (next) chooseGroup(next.id);
      }
      // 비모달 창: Tab은 브라우저의 정상 순서를 그대로 따른다.
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });
  const start = (event: ReactPointerEvent<HTMLElement>, direction?: Direction) => {
    if (mobile || event.button !== 0 || !event.isPrimary || (!direction && (event.target as Element).closest("button, select, a"))) return;
    event.preventDefault();
    rootRef.current?.focus({ preventScroll: true });
    const origin = rect, px = event.clientX, py = event.clientY;
    let latest = origin, frame = 0;
    drag(event, event.currentTarget, {
      onStart: () => setDragging(true),
      onMove: (next) => {
        const dx = next.clientX - px, dy = next.clientY - py;
        let { x, y, w, h } = origin;
        if (!direction) { x += dx; y += dy; }
        else {
          if (direction.includes("e")) w = clamp(origin.w + dx, MIN_W, window.innerWidth - GAP - origin.x);
          if (direction.includes("s")) h = clamp(origin.h + dy, MIN_H, window.innerHeight - GAP - origin.y);
          if (direction.includes("w")) { x = clamp(origin.x + dx, GAP, origin.x + origin.w - MIN_W); w = origin.x + origin.w - x; }
          if (direction.includes("n")) { y = clamp(origin.y + dy, GAP, origin.y + origin.h - MIN_H); h = origin.y + origin.h - y; }
        }
        latest = fit({ x, y, w, h });
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; setRect(latest); });
      },
      onEnd: (end) => {
        cancelAnimationFrame(frame); setDragging(false);
        setRect(end ? latest : fit(origin));
        if (end) saveRect(latest);
      },
    });
  };
  const label = (item: typeof groups[number]) => `${item.n || "—"} · ${item.title}`;
  const narrow = !mobile && (rect.w < 520 || railCollapsed);
  return <div ref={rootRef} className={`objectives-result-window${shared ? " is-shared" : ""}${mobile ? " is-mobile" : ""}${narrow ? " is-narrow" : ""}${dragging ? " is-dragging" : ""}`} role="dialog" aria-modal={mobile} aria-label={`${heading} · ${objective?.title ?? ""}`} tabIndex={-1} style={mobile ? undefined : { left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
    <header className="objectives-rw-head" onPointerDown={(event) => start(event)}>
      {!mobile && rect.w >= 520 ? <button type="button" aria-label={t("objectives.results.window.missions")} title={t("objectives.results.window.missions")} aria-pressed={!railCollapsed} onClick={() => setRailCollapsed((current) => !current)}><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M6 2.5v11" /></svg></button> : null}
      <span className="objectives-rw-heading">{heading}</span>
      <span className="objectives-rw-objective" title={objective?.title}>{objective?.title}</span>
      {narrow ? <span className="objectives-rw-grip" aria-hidden="true" title={objective?.title}>⠿</span> : null}
      {narrow && group ? <MissionSwitcher label={t("objectives.missions.title")} value={group.id} options={groups.map((item) => ({ value: item.id, label: `${label(item)} (${item.results.length})` }))} onChange={chooseGroup} /> : null}
      {!mobile ? <button type="button" className="objectives-rw-reset" aria-label={t("objectives.results.window.reset")} title={t("objectives.results.window.reset")} onClick={() => { const next = defaultRect(); setRect(next); saveRect(next); }}>↺</button> : null}
      <button type="button" className="objectives-rw-close" aria-label={t("objectives.detail.close")} title={t("objectives.detail.close")} onClick={closeWindow}><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>
    </header>
    <div className="objectives-rw-body">
      {shared ? null : <nav className="objectives-rw-missions" aria-label={t("objectives.missions.title")}>
        {groups.map((item) => <button key={item.id} type="button" aria-pressed={item.id === group?.id} title={label(item)} onClick={() => chooseGroup(item.id)}><span>{item.n || "—"}</span><span className="objectives-rw-mission-title">{item.title}</span><span>{item.results.length}</span></button>)}
      </nav>}
      <div className="objectives-rw-main">
        {group && !shared ? <div className="objectives-rw-mission-head"><b>{label(group)}</b>{group.record ? <span title={group.record.lines[0]}><LinkText text={group.record.lines[0] ?? ""} /></span> : null}</div> : null}
        <div className="objectives-rw-stage">
          {shared ? shared.kind === "image"
              ? <img className="objectives-rw-image" key={shared.path} src={sharedFileUrl(opened.objectiveId, shared.path)} alt={sharedName} draggable={false} />
              : <EvidenceTextContent key={shared.path} t={t} plain src={sharedFileUrl(opened.objectiveId, shared.path)} name={sharedName} />
            : !result || !objective ? <p className="objectives-result-textstate" role="status">{t("objectives.results.window.empty")}</p>
            : result.kind === "evidence" ? result.mediaType === "text/plain"
              ? <EvidenceTextContent key={`${result.id}:${result.evidenceId}`} t={t} src={resultFileUrl(objective.id, result)} name={result.name} />
              : <img className="objectives-rw-image" key={`${result.id}:${result.evidenceId}`} src={resultFileUrl(objective.id, result)} alt={title} draggable={false} />
            : <div className="objectives-rw-link-card">{result.kind === "pr" ? <PrRow result={result} t={t} language={language} now={now} missionTag="" /> : <div className="objectives-rw-artifact"><b>{title}</b><span>claude.ai</span>{result.note ? <p>{result.note}</p> : null}<p>{t("objectives.results.artifact.notice")}</p><a href={result.url} target="_blank" rel="noopener noreferrer">{t("objectives.results.artifact.newTab")} ↗</a></div>}</div>}
          {result?.kind === "evidence" && result.mediaType !== "text/plain" && ordered.length > 1 ? <>
            <button type="button" className="objectives-att-view-step is-prev" aria-label={t("objectives.results.window.previous")} disabled={index <= 0} onClick={() => { const previous = ordered[index - 1]; if (previous) choose(previous.id); }}>‹</button>
            <button type="button" className="objectives-att-view-step is-next" aria-label={t("objectives.results.window.next")} disabled={index >= ordered.length - 1} onClick={() => { const next = ordered[index + 1]; if (next) choose(next.id); }}>›</button>
          </> : null}
        </div>
        {shared ? <div className="objectives-rw-caption"><b>{sharedName}</b><span className="is-mono">{shared.path}</span><span>{bytesLabel(shared.bytes)} · {absolute(shared.modifiedAt, language)}</span><a className="objectives-rw-download" href={sharedFileUrl(opened.objectiveId, shared.path, true)} download>{t("objectives.shared.download")}</a></div>
        : result ? <div className="objectives-rw-caption" aria-live="polite"><b>{title}</b>{result.note && result.kind === "evidence" ? <span><LinkText text={result.note} /></span> : null}<span>{t("objectives.att.position", { n: index + 1, count: ordered.length })}{result.kind === "evidence" ? ` · ${result.name} · ${bytesLabel(result.bytes)}${result.width && result.height ? ` · ${result.width}×${result.height}` : ""} · ${absolute(result.capturedAt, language)}` : ""}</span></div> : null}
        {shared ? null : <nav className="objectives-rw-strip" aria-label={t("objectives.results.title")}>
          {groups.map((item) => <div key={item.id} className="objectives-rw-strip-group"><span className="objectives-rw-strip-n" title={label(item)}>{item.n || "—"}</span>{item.results.map((entry) => <button key={entry.id} type="button" aria-current={entry.id === result?.id} aria-label={`${label(item)} · ${resultLabel(entry, t("objectives.results.artifact.untitled"))}`} title={resultLabel(entry, t("objectives.results.artifact.untitled"))} onClick={() => choose(entry.id)}>{entry.kind === "evidence" && entry.mediaType !== "text/plain" ? <img src={resultFileUrl(opened.objectiveId, entry)} alt="" loading="lazy" draggable={false} /> : <span>{entry.kind === "evidence" ? entry.name.split(".").at(-1)?.toUpperCase().slice(0, 5) ?? "TXT" : entry.kind === "pr" ? "PR" : "↗"}</span>}</button>)}</div>)}
        </nav>}
      </div>
    </div>
    {!mobile ? DIRECTIONS.map((direction) => <span key={direction} className={`objectives-result-resize is-${direction}`} aria-hidden="true" onPointerDown={(event) => start(event, direction)} />) : null}
  </div>;
}

function MissionSwitcher({ label, value, options, onChange }: { readonly label: string; readonly value: string; readonly options: readonly SelectOption[]; readonly onChange: (id: string) => void }) {
  const select = useSelect({ value, options, onChange });
  return <div {...select.rootProps} className={`${select.rootProps.className} objectives-rw-switch`}>
    <button {...select.triggerProps} className="fc-select__trigger" aria-label={label}><span className="fc-select__value">{options.find((item) => item.value === value)?.label}</span><span className="fc-select__caret" aria-hidden="true">⌄</span></button>
    {select.isOpen ? createPortal(<ul {...select.listboxProps} className={`${select.listboxProps.className} objectives-rw-menu`} aria-label={label}>{options.map((item, index) => <li key={item.value} {...select.getOptionProps(index)} className="fc-select__option">{item.label}</li>)}</ul>, document.body) : null}
  </div>;
}

function resultLabel(result: ObjectiveResult, untitled: string): string {
  return result.label ?? (result.kind === "evidence" ? result.name : result.kind === "pr" ? `${result.owner}/${result.repo} #${result.number}` : untitled);
}

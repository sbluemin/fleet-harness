import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import {
  ApiError, previewOperationPurge, previewOperationBatch, purgeArchivedOperations, restoreArchivedOperations,
  restoreOperationCluster, undoOperationPurge, readOperationLaunch, OPERATION_PURGE_GRACE_MS,
  type OperationDescription, type OperationPendingPurge, type OperationPurgeConfirmation, type OperationPurgeResult,
} from "@fleet-console/sdk/operations/browser";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import { ArchiveGlyph } from "../../../../core/client/src/chrome/components/archive-glyph.js";
import { useConsoleLocale, useT, type CoreMessageKey } from "../../../../core/client/src/i18n/index.js";
import { closeArchiveSheet, openRestoredOperation, refreshOperationArchive, useOperationArchive } from "../../../../core/client/src/integration/operation-archive.js";
import { fetchOperations } from "../../../../core/client/src/integration/api.js";
import { getState, hydrateOperations } from "../../../../core/client/src/integration/store.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { useArchiveSections } from "./archive-entry.js";

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
const LOCALE_TAG: Readonly<Record<ConsoleLocale, string>> = { en: "en-US", ko: "ko-KR" };
interface ArchiveCluster {
  readonly rootId: string;
  readonly root: OperationDescription;
  readonly members: readonly string[];
  readonly archivedAt: number;
}
function clustersOf(entries: readonly OperationDescription[]): readonly ArchiveCluster[] {
  return entries.map((root) => ({ rootId: root.operation.id, root,
    members: (root.operation.childSessions ?? []).map((child) => readOperationLaunch(child.payload).sessionName ?? child.id.slice(0, 8)),
    archivedAt: root.archivedAt ?? 0,
  })).sort((a, b) => b.archivedAt - a.archivedAt);
}
function dayKeyOf(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
function daysOf(clusters: readonly ArchiveCluster[]) {
  const days: { key: string; at: number; clusters: ArchiveCluster[] }[] = [];
  for (const cluster of clusters) {
    const key = dayKeyOf(cluster.archivedAt);
    const last = days[days.length - 1];
    if (last?.key === key) last.clusters.push(cluster);
    else days.push({ key, at: cluster.archivedAt, clusters: [cluster] });
  }
  return days;
}
function isRecent(at: number, now: number): boolean {
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  return dayKeyOf(at) === dayKeyOf(now) || dayKeyOf(at) === dayKeyOf(yesterday.getTime());
}
function dayLabelOf(at: number, now: number, locale: ConsoleLocale, t: ReturnType<typeof useT>) {
  const date = new Date(at);
  const monthDay = new Intl.DateTimeFormat(LOCALE_TAG[locale], { month: "short", day: "numeric" }).format(date);
  const weekday = new Intl.DateTimeFormat(LOCALE_TAG[locale], { weekday: "short" }).format(date);
  const relative = isRecent(at, now) ? t(dayKeyOf(at) === dayKeyOf(now) ? "archive.day.today" : "archive.day.yesterday") : null;
  return { main: relative ?? monthDay, sub: [relative ? `${monthDay} ${weekday}` : weekday, date.getFullYear() === new Date(now).getFullYear() ? null : date.getFullYear()].filter(Boolean).join(" · ") };
}
function Highlight({ text, query }: { readonly text: string; readonly query: string }) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return <>{text}</>;
  const lower = text.toLocaleLowerCase();
  const parts = [];
  let start = 0;
  let index = lower.indexOf(needle);
  while (index >= 0) {
    parts.push(text.slice(start, index), <mark key={index}>{text.slice(index, index + needle.length)}</mark>);
    start = index + needle.length;
    index = lower.indexOf(needle, start);
  }
  parts.push(text.slice(start));
  return <>{parts}</>;
}

export function ArchiveSheet() {
  return useOperationArchive().sheetOpen ? <ArchiveSheetDialog /> : null;
}

/** 무장·고르기는 시트 전체가 공유하며, 복원·삭제 보류는 줄의 자리를 유지한다. */
function ArchiveSheetDialog() {
  const t = useT();
  const locale = useConsoleLocale();
  const state = useConsoleState();
  const archive = useOperationArchive();
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [allTheaters, setAllTheaters] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // 복원 기록은 열린 시트 수명만 가진다. 원본 위치·날짜를 보존하고 다시 열면 사라진다.
  const [restored, setRestored] = useState<readonly OperationDescription[]>([]);
  const [notice, setNotice] = useState<CoreMessageKey | null>(null);
  const [clock, setClock] = useState(Date.now());
  // 확정 응답의 영수증 — 뒤따르는 목록 새로고침이 실패해도 유예 동안 되돌리기를 보여 준다.
  // 만료는 서버 시각 대신 받은 순간부터의 유예로 잰다(기기 시계 차이로 바로 사라지지 않게).
  const [receipts, setReceipts] = useState<readonly { readonly batch: OperationPendingPurge; readonly until: number }[]>([]);
  const focusRequest = useRef<{ id: string; index: number; kind: "next" | "restore" | "undo" } | null>(null);
  const lastFocused = useRef<{ id: string; index: number } | null>(null);

  const theaterIds = state.theaters.map((theater) => theater.id);
  const scopedIds = allTheaters ? theaterIds : state.activeTheaterId ? [state.activeTheaterId] : [];
  const allSections = useArchiveSections("", theaterIds);
  const currentSections = useArchiveSections("", state.activeTheaterId ? [state.activeTheaterId] : []);
  const sections = useArchiveSections(query, scopedIds).filter((entry) => entry.count > 0);
  const otherIds = theaterIds.filter((id) => id !== state.activeTheaterId);
  const otherSections = useArchiveSections(query, otherIds);
  const currentCount = (state.activeTheaterId ? archive.totalsByTheater[state.activeTheaterId] ?? 0 : 0) + currentSections.reduce((sum, entry) => sum + entry.count, 0);
  const allCount = archive.total + allSections.reduce((sum, entry) => sum + entry.count, 0);
  const total = allTheaters ? allCount : currentCount;
  const activeLabel = state.theaters.find((theater) => theater.id === state.activeTheaterId)?.label ?? t("archive.currentTheater");
  const restoredIds = new Set(restored.map((entry) => entry.operation.id));
  const entries = [...(archive.snapshot?.entries ?? []).filter((entry) => !restoredIds.has(entry.operation.id)), ...restored];
  const allClusters = clustersOf(entries);
  const matches = (cluster: ArchiveCluster) => {
    const node = cluster.root.operation;
    const haystack = [node.title, state.theaters.find((theater) => theater.id === node.theaterId)?.label, state.groups.find((group) => group.id === node.groupId)?.name, ...cluster.members].filter(Boolean).join(" ");
    return haystack.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  };
  const clusters = allClusters.filter((cluster) => (allTheaters || cluster.root.operation.theaterId === state.activeTheaterId) && matches(cluster));
  const otherCount = allTheaters || !query.trim() ? 0 : allClusters.filter((cluster) => !restoredIds.has(cluster.rootId) && cluster.root.operation.theaterId !== state.activeTheaterId && matches(cluster)).length + otherSections.reduce((sum, entry) => sum + entry.count, 0);
  const pendingOf = (id: string) => archive.snapshot?.pendingPurges?.find((batch) => batch.operationIds.includes(id))
    ?? receipts.find((entry) => entry.until > clock && entry.batch.operationIds.includes(id))?.batch;
  const selectable = clusters.filter((cluster) => !restoredIds.has(cluster.rootId) && !pendingOf(cluster.rootId));
  const selectedIds = selectable.filter((cluster) => selected.has(cluster.rootId)).map((cluster) => cluster.rootId);
  const old = allClusters.filter((cluster) => (allTheaters || cluster.root.operation.theaterId === state.activeTheaterId) && !restoredIds.has(cluster.rootId) && !pendingOf(cluster.rootId) && cluster.archivedAt < clock - 30 * 24 * 60 * 60 * 1000);
  const showTools = allCount > 0 || restored.length > 0;

  useLayoutEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = document.querySelector<HTMLElement>(".console-shell");
    const previousInert = shell?.inert ?? false;
    if (shell) shell.inert = true;
    dialogRef.current?.focus();
    return () => { if (shell) shell.inert = previousInert; };
  }, []);
  useEffect(() => () => { if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus(); }, []);
  useEffect(() => {
    if (!archive.snapshot?.pendingPurges?.length && !receipts.length) return;
    setClock(Date.now());
    const timer = setInterval(() => {
      const now = Date.now();
      setClock(now);
      setReceipts((previous) => previous.some((entry) => entry.until <= now) ? previous.filter((entry) => entry.until > now) : previous);
    }, 1000);
    return () => clearInterval(timer);
  }, [archive.snapshot?.pendingPurges, receipts.length]);
  // 스냅숏·다른 창의 변경으로 사라진 줄의 초점도 삭제 단추로 보내지 않는다.
  useLayoutEffect(() => {
    let request = focusRequest.current;
    if (!request && document.activeElement === document.body && lastFocused.current) request = { ...lastFocused.current, kind: "next" };
    if (!request || (busy && request.kind === "next")) return;
    const rows = [...(dialogRef.current?.querySelectorAll<HTMLElement>(".archive-sheet-item") ?? [])];
    const row = rows.find((item) => item.dataset.operationId === request!.id);
    let target: HTMLElement | null = null;
    if (request.kind !== "next") target = row?.querySelector<HTMLElement>(request.kind === "undo" ? ".archive-sheet-undo" : ".archive-sheet-restore") ?? null;
    if (request.kind !== "next" && row && !target && !archive.error) return;
    if (!target) {
      const next = rows.slice(request.index + (row ? 1 : 0)).find((item) => item.querySelector(".archive-sheet-restore:not([aria-disabled])"));
      const previous = rows.slice(0, request.index).reverse().find((item) => item.querySelector(".archive-sheet-restore:not([aria-disabled])"));
      target = (next ?? previous)?.querySelector<HTMLElement>(".archive-sheet-restore") ?? searchRef.current ?? dialogRef.current;
    }
    target?.focus();
    focusRequest.current = null;
  });
  // 글로벌 단축키가 BODY로 빠진 포커스를 받기 전에 시트의 Esc 우선순위를 지킨다.
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (document.activeElement !== document.body || !["Escape", "Tab"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape") escape();
      else dialogRef.current?.focus();
    };
    document.addEventListener("keydown", handle, true);
    return () => document.removeEventListener("keydown", handle, true);
  });

  const clearSelection = () => { setSelected(new Set()); anchorRef.current = null; setArmed(null); };
  const changeQuery = (value: string) => { setQuery(value); clearSelection(); };
  const changeScope = (value: boolean) => { setAllTheaters(value); clearSelection(); };
  const escape = () => {
    if (armed) setArmed(null);
    else if (selectedIds.length) clearSelection();
    else if (query) { changeQuery(""); searchRef.current?.focus(); }
    else closeArchiveSheet();
  };
  const select = (id: string, extend: boolean) => {
    if (busyRef.current) return;
    setArmed(null);
    const ids = selectable.map((cluster) => cluster.rootId);
    if (!ids.includes(id)) return;
    const next = new Set(selectedIds);
    const anchor = anchorRef.current ? ids.indexOf(anchorRef.current) : -1;
    if (extend && anchor >= 0) {
      const end = ids.indexOf(id);
      for (const candidate of ids.slice(Math.min(anchor, end), Math.max(anchor, end) + 1)) next.add(candidate);
    } else {
      if (next.has(id)) next.delete(id); else next.add(id);
      anchorRef.current = id;
    }
    setSelected(next);
  };
  const open = (id: string) => {
    if (!openRestoredOperation(id)) { setNotice("archive.notice.restoreFailed"); return; }
    closeArchiveSheet();
  };
  const restore = async (ids: readonly string[]) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setArmed(null); setNotice(null);
    const before = entries.filter((entry) => ids.includes(entry.operation.id));
    const index = clusters.findIndex((cluster) => cluster.rootId === ids[0]);
    try {
      const result = ids.length === 1 ? await restoreOperationCluster(ids[0]!) : await restoreArchivedOperations(await previewOperationBatch(ids));
      hydrateOperations([...getState().operations.filter((node) => !ids.includes(node.id)), ...result.operations]);
      setRestored((previous) => [...previous, ...before]);
      clearSelection();
      focusRequest.current = { id: ids[0]!, index, kind: "next" };
      await fetchOperations(null).then(hydrateOperations).catch(() => {});
      await refreshOperationArchive();
    } catch (error) {
      setNotice(error instanceof ApiError && error.message === "restore_parent_missing" ? "archive.notice.restoreParentMissing" : "archive.notice.restoreFailed");
      void refreshOperationArchive();
    } finally { busyRef.current = false; setBusy(false); }
  };
  const purged = async (id: string, result: unknown) => {
    const receipt = receiptOf(result);
    if (receipt) setReceipts((previous) => [...previous.filter((entry) => entry.batch.purgeId !== receipt.purgeId), { batch: receipt, until: Date.now() + OPERATION_PURGE_GRACE_MS }]);
    clearSelection();
    focusRequest.current = { id, index: clusters.findIndex((cluster) => cluster.rootId === id), kind: "undo" };
    await refreshOperationArchive();
  };
  const undo = async (batch: OperationPendingPurge, id: string) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setArmed(null);
    try {
      await undoOperationPurge(batch.purgeId);
      setReceipts((previous) => previous.filter((entry) => entry.batch.purgeId !== batch.purgeId));
      focusRequest.current = { id, index: clusters.findIndex((cluster) => cluster.rootId === id), kind: "restore" };
      await refreshOperationArchive();
    } catch { setNotice("archive.notice.undoFailed"); void refreshOperationArchive(); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.repeat && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); event.stopPropagation(); return; }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); escape(); return; }
    const input = event.target instanceof Element && !!event.target.closest("input, textarea, [contenteditable='true']");
    if (!input && event.key === "/") { event.preventDefault(); event.stopPropagation(); searchRef.current?.focus(); return; }
    if (!input && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault(); event.stopPropagation(); setArmed(null); setSelected(new Set(selectable.map((cluster) => cluster.rootId))); return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])];
    const first = focusable[0]; const last = focusable[focusable.length - 1]; const active = document.activeElement;
    if (!first) { event.preventDefault(); dialogRef.current?.focus(); }
    else if (active === dialogRef.current || !dialogRef.current?.contains(active) || (event.shiftKey ? active === first : active === last)) {
      event.preventDefault(); (event.shiftKey ? last : first)?.focus();
    }
  };

  return createPortal(
    <div className="archive-sheet-scrim" onMouseDown={closeArchiveSheet}>
      <div ref={dialogRef} className="archive-sheet" role="dialog" aria-modal="true" aria-labelledby="archive-sheet-title" tabIndex={-1}
        onKeyDownCapture={handleKeyDown} onMouseDown={(event) => event.stopPropagation()}>
        <header className="archive-sheet-head">
          <span className="archive-sheet-glyph" aria-hidden="true"><ArchiveGlyph /></span>
          <h2 id="archive-sheet-title">{t("archive.title")}</h2><span className="archive-sheet-count">{total}</span>
          <button type="button" className="archive-sheet-close" onClick={closeArchiveSheet} aria-label={t("archive.closeAria")}>✕</button>
        </header>
        {showTools ? <div className="archive-sheet-tools">
          <input ref={searchRef} className="archive-sheet-search" value={query} onChange={(event) => changeQuery(event.target.value)} placeholder={t("archive.search")} aria-label={t("archive.search")} />
          <div className="archive-sheet-scope" aria-label={t("archive.scope")}>
            <button type="button" aria-pressed={!allTheaters} onClick={() => changeScope(false)}>{activeLabel} {currentCount}</button>
            <span aria-hidden="true">·</span>
            <button type="button" aria-pressed={allTheaters} onClick={() => changeScope(true)}>{t("archive.allTheaters")} {allCount}</button>
          </div>
        </div> : null}
        {notice ? <p className="archive-sheet-notice" role="status">{t(notice)}</p> : null}
        <div className="archive-sheet-body">
          {clusters.length === 0 && sections.length === 0 ? <div className="archive-sheet-empty" role="status">
            {archive.loading && archive.snapshot === null ? t("archive.loading") : archive.error && archive.snapshot === null ? t("archive.loadFailed") : query.trim() ?
              <p>{t(allTheaters ? "archive.noMatchesAll" : "archive.noMatches", { query })}</p> : <><strong>{t("archive.emptyTitle")}</strong><p>{t("archive.emptyGuide")}</p><p>{t("archive.emptyDormant")}</p></>}
          </div> : null}
          <div role="listbox" aria-label={t("archive.title")} aria-multiselectable="true">
            {daysOf(clusters).map((day) => {
              const label = dayLabelOf(day.at, clock, locale, t);
              return <section key={day.key} className="archive-sheet-day" aria-labelledby={`archive-sheet-day-${day.key}`}>
                <h3 id={`archive-sheet-day-${day.key}`} className="archive-sheet-day-date"><span className="archive-sheet-day-main">{label.main}</span><span className="archive-sheet-day-sub">{label.sub}</span></h3>
                <div className="archive-sheet-day-items">
                  {day.clusters.map((cluster) => {
                    const node = cluster.root.operation;
                    const group = state.groups.find((candidate) => candidate.id === node.groupId);
                    const theater = state.theaters.find((candidate) => candidate.id === node.theaterId)?.label;
                    const meta = [allTheaters ? theater : null, group?.name ?? t(node.groupId ? "archive.meta.groupLost" : "archive.meta.ungrouped"),
                      isRecent(cluster.archivedAt, clock) ? t("archive.meta.archivedAt", { when: new Intl.DateTimeFormat(LOCALE_TAG[locale], { hour: "numeric", minute: "2-digit" }).format(cluster.archivedAt) }) : null,
                      cluster.members.length ? cluster.members.join(", ") : null].filter(Boolean).join(" · ");
                    const isRestored = restoredIds.has(cluster.rootId);
                    const pending = pendingOf(cluster.rootId);
                    const index = clusters.indexOf(cluster);
                    return <article key={cluster.rootId} data-operation-id={cluster.rootId} className={`archive-sheet-item${selectedIds.includes(cluster.rootId) ? " is-selected" : ""}${isRestored ? " is-restored" : ""}${pending ? " is-pending" : ""}`}
                      role="option" aria-label={node.title} aria-selected={selectedIds.includes(cluster.rootId)} aria-disabled={isRestored || !!pending || undefined} tabIndex={0}
                      onFocus={() => { lastFocused.current = { id: cluster.rootId, index }; }}
                      onClick={(event) => { if (!(event.target instanceof Element) || event.target.closest("button")) return; select(cluster.rootId, event.shiftKey); }}
                      onKeyDown={(event) => { if (event.key !== " " || event.target !== event.currentTarget) return; event.preventDefault(); if (!event.repeat) select(cluster.rootId, event.shiftKey); }}>
                      <div className="archive-sheet-item-main"><p className="archive-sheet-item-title" title={node.title}><Highlight text={node.title} query={query} /></p><p className="archive-sheet-item-meta" title={meta}><Highlight text={meta} query={query} /></p></div>
                      <div className="archive-sheet-actions">
                        {isRestored ? <><span>{t("archive.restored")}</span><span aria-hidden="true">·</span><button type="button" className="archive-sheet-open" onClick={() => open(cluster.rootId)}>{t("archive.open")}</button></> : pending ?
                          <><span>{t("archive.pending", { seconds: Math.max(0, Math.ceil((pending.purgeAt - clock) / 1000)) })}</span><button type="button" className="archive-sheet-undo" aria-disabled={busy || undefined} onClick={() => { void undo(pending, cluster.rootId); }}>{t("archive.undo")}{pending.operationIds.length > 1 ? ` (${pending.operationIds.length})` : ""}</button></> :
                          <><button type="button" className="archive-sheet-restore" aria-disabled={busy || undefined} onClick={() => { void restore([cluster.rootId]); }}>{t("archive.restore")}</button>
                            <ArchivePurgeButton targetId={cluster.rootId} title={node.title} currentRevision={archive.revision} preview={previewOperationPurge} purge={purgeArchivedOperations}
                              armed={armed === cluster.rootId} onArm={() => setArmed(cluster.rootId)} onDisarm={() => setArmed(null)} disabled={busy}
                              onStart={() => setNotice(null)} onRefused={(message) => { setNotice(message); void refreshOperationArchive(); }} onPurged={(result) => { void purged(cluster.rootId, result); }} /></>}
                      </div>
                    </article>;
                  })}
                </div>
              </section>;
            })}
          </div>
          {otherCount > 0 ? <p className="archive-sheet-other">{t("archive.otherMatches", { count: otherCount })} <button type="button" onClick={() => changeScope(true)}>{t("archive.showAll")}</button></p> : null}
          {sections.map(({ section, count }) => <section key={section.id} className="archive-sheet-section" aria-labelledby={`archive-sheet-section-${section.id}`} data-archive-section={section.id}>
            <h3 id={`archive-sheet-section-${section.id}`} className="archive-sheet-section-head"><span>{section.title(locale)}</span><span className="archive-sheet-section-count">{count}</span></h3>
            <div className="archive-sheet-section-body">{scopedIds.filter((id) => section.count(id, query) > 0).map((id) => <div key={id}>{allTheaters ? <p className="archive-sheet-plugin-theater">{state.theaters.find((theater) => theater.id === id)?.label}</p> : null}{section.render({ language: locale, theaterId: id, query, close: closeArchiveSheet })}</div>)}</div>
          </section>)}
          {old.length > 0 ? <p className="archive-sheet-old">{t("archive.oldCount", { count: old.length })} <button type="button" onClick={() => { setQuery(""); setArmed(null); setSelected(new Set(old.map((cluster) => cluster.rootId))); anchorRef.current = null; }}>{t("archive.clearOld")}</button></p> : null}
        </div>
        {selectedIds.length > 0 ? <footer className="archive-sheet-selection">
          <span>{t("archive.selected", { count: selectedIds.length })}</span>
          <button type="button" className="archive-sheet-restore" aria-disabled={busy || undefined} onClick={() => { void restore(selectedIds); }}>{t("archive.restoreAll")}</button>
          <ArchivePurgeButton targetId="batch" title={t("archive.selected", { count: selectedIds.length })} currentRevision={archive.revision} preview={() => previewOperationBatch(selectedIds)} purge={purgeArchivedOperations}
            armed={armed === "batch"} onArm={() => setArmed("batch")} onDisarm={() => setArmed(null)} armedLabel={t("archive.purgeBatchArmed", { count: selectedIds.length })} disabled={busy}
            onStart={() => setNotice(null)} onRefused={(message) => { setNotice(message); void refreshOperationArchive(); }} onPurged={(result) => { void purged(selectedIds[0]!, result); }} />
          <button type="button" className="archive-sheet-deselect" onClick={clearSelection}>{t("archive.deselect")}</button>
        </footer> : null}
      </div>
    </div>, document.body,
  );
}

/** 확정 응답에 보류 영수증이 있으면 꺼낸다. */
function receiptOf(result: unknown): OperationPendingPurge | null {
  if (!result || typeof result !== "object") return null;
  const { purgeId, purgeAt, operationIds } = result as Partial<OperationPurgeResult>;
  return typeof purgeId === "string" && typeof purgeAt === "number" && Array.isArray(operationIds) ? { purgeId, purgeAt, operationIds } : null;
}

/** 두 번 눌러 확정하며, 첫 누름의 revision과 서버가 preview한 대상 집합을 끝까지 검증한다. */
export function ArchivePurgeButton({ targetId, title, currentRevision, preview, purge, onStart, onRefused, onPurged, armed, onArm, onDisarm, armedLabel, disabled }: {
  readonly targetId: string;
  readonly title: string;
  readonly currentRevision: number;
  readonly preview: (operationId: string) => Promise<OperationPurgeConfirmation>;
  readonly purge: (confirmation: OperationPurgeConfirmation) => Promise<OperationPurgeResult | unknown>;
  readonly onStart: () => void;
  readonly onRefused: (notice: CoreMessageKey) => void;
  readonly onPurged: (result: unknown) => void;
  readonly armed?: boolean;
  readonly onArm?: () => void;
  readonly onDisarm?: () => void;
  readonly armedLabel?: string;
  readonly disabled?: boolean;
}) {
  const t = useT();
  const [localArmed, setLocalArmed] = useState(false);
  const isArmed = armed ?? localArmed;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const armedAt = useRef(0);
  const armRevision = useRef(currentRevision);
  const revisionRef = useRef(currentRevision); revisionRef.current = currentRevision;
  const disarmRef = useRef(onDisarm); disarmRef.current = onDisarm;
  const disarm = () => { setLocalArmed(false); disarmRef.current?.(); };
  useEffect(() => {
    if (!isArmed) return;
    const timer = setTimeout(() => { setLocalArmed(false); disarmRef.current?.(); }, 3000);
    return () => clearTimeout(timer);
  }, [isArmed]);
  const run = async () => {
    if (busyRef.current || disabled) return;
    if (!isArmed || Date.now() - armedAt.current >= 3000) {
      armedAt.current = Date.now(); armRevision.current = currentRevision;
      setLocalArmed(true); onArm?.(); return;
    }
    disarm(); busyRef.current = true; setBusy(true); onStart();
    let notice: CoreMessageKey | null = null;
    let result: unknown;
    try {
      const confirmation = await preview(targetId);
      if ((revisionRef.current >= 0 && revisionRef.current !== confirmation.revision) || armRevision.current !== confirmation.revision) notice = "archive.notice.purgeStale";
      else result = await purge(confirmation);
    } catch (error) {
      notice = error instanceof ApiError && error.message === "archive_revision_conflict" ? "archive.notice.purgeStale" : "archive.notice.purgeFailed";
    }
    busyRef.current = false; setBusy(false);
    if (notice) onRefused(notice); else onPurged(result);
  };
  return <button type="button" className={`archive-sheet-purge${isArmed ? " is-armed" : ""}`} onClick={() => { void run(); }}
    onKeyDown={(event) => {
      if (event.repeat && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); event.stopPropagation(); }
      if (event.key === "Escape" && isArmed) { event.preventDefault(); event.stopPropagation(); disarm(); }
    }} aria-disabled={busy || disabled || undefined} aria-label={t(isArmed ? "archive.purgeArmedAria" : "archive.purgeAria", { title })} data-armed-label={armedLabel ?? t("archive.purgeArmed")}>
    <span>{isArmed ? armedLabel ?? t("archive.purgeArmed") : t("archive.purge")}</span>
  </button>;
}

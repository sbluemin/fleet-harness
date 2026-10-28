import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { ApiError, previewObjectivePurge, previewObjectiveBatch, purgeArchivedObjectiveRecords, restoreArchivedObjectiveRecords, restoreObjectiveCluster, undoObjectivePurge } from "../../../execution/client/objective-records.js";
import { readObjectiveLaunch } from "../../../objectives/shared/records/types.js";
import { OBJECTIVE_PURGE_GRACE_MS, type ObjectiveDescription, type ObjectivePendingPurge, type ObjectivePurgeConfirmation, type ObjectivePurgeResult } from "../../../objectives/shared/records/archive.js";
import type { ConsoleLocale } from "@fleet-console/i18n";

import { ArchiveGlyph } from "../components/archive-glyph.js";
import { useConsoleLocale, useT, type CoreMessageKey } from "../../../../core/client/src/i18n/index.js";
import { closeArchiveSheet, openRestoredObjective, refreshObjectiveArchive, useObjectiveArchive } from "../../../../core/client/src/integration/objective-archive.js";
import { fetchObjectiveRecords } from "../../../../core/client/src/integration/api.js";
import { getState, hydrateObjectiveRecords } from "../../../../core/client/src/integration/store.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { useArchiveSections } from "./archive-entry.js";
import { ArchiveRetention } from "./archive-retention.js";
import { commodoreAvatarKey } from "../../shared/avatars.js";
import { useMongleLook } from "../avatar-events.js";
import { MongleAvatar } from "../components/mongle-avatar.js";

/** Console 조합 계층이 이름·순서·소유 Theater를 전달한다. 보관 항목의 소유자는 commodoreId다. */
export interface ArchiveSheetDeps {
  readonly commodores: readonly {
    readonly commodoreId: string;
    readonly label: string;
    readonly theaters: readonly { readonly theaterId: string; readonly label: string }[];
  }[];
}

function ArchiveCommodoreAvatar({ id, label }: { readonly id: string; readonly label: string }) {
  const look = useMongleLook(commodoreAvatarKey(id));
  return <MongleAvatar base={look.base} tone={look.tone} role="commodore" state="idle" size={20} label={label} decorative />;
}

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
const LOCALE_TAG: Readonly<Record<ConsoleLocale, string>> = { en: "en-US", ko: "ko-KR" };
interface ArchiveCluster {
  readonly rootId: string;
  readonly root: ObjectiveDescription;
  readonly members: readonly string[];
  readonly archivedAt: number;
}
function clustersOf(entries: readonly ObjectiveDescription[]): readonly ArchiveCluster[] {
  return entries.map((root) => ({ rootId: root.objectiveRecord.id, root,
    members: (root.objectiveRecord.sessions ?? []).map((child) => readObjectiveLaunch(child).sessionName ?? child.id.slice(0, 8)),
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

export function ArchiveSheet({ deps }: { readonly deps: ArchiveSheetDeps }) {
  return useObjectiveArchive().sheetOpen ? <ArchiveSheetDialog deps={deps} /> : null;
}

/** 무장·고르기는 시트 전체가 공유하며, 복원·삭제 보류는 줄의 자리를 유지한다. */
function ArchiveSheetDialog({ deps }: { readonly deps: ArchiveSheetDeps }) {
  const t = useT();
  const locale = useConsoleLocale();
  const state = useConsoleState();
  const archive = useObjectiveArchive();
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [commodoreId, setCommodoreId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // 복원 기록은 열린 시트 수명만 가진다. 원본 위치·날짜를 보존하고 다시 열면 사라진다.
  const [restored, setRestored] = useState<readonly ObjectiveDescription[]>([]);
  const [notice, setNotice] = useState<CoreMessageKey | null>(null);
  const [retentionOpen, setRetentionOpen] = useState(false);
  const [clock, setClock] = useState(Date.now());
  // 확정 응답의 영수증 — 뒤따르는 목록 새로고침이 실패해도 유예 동안 되돌리기를 보여 준다.
  // 만료는 서버 시각 대신 받은 순간부터의 유예로 잰다(기기 시계 차이로 바로 사라지지 않게).
  const [receipts, setReceipts] = useState<readonly { readonly batch: ObjectivePendingPurge; readonly until: number }[]>([]);
  const focusRequest = useRef<{ id: string; index: number; kind: "next" | "restore" | "undo" } | null>(null);
  const lastFocused = useRef<{ id: string; index: number } | null>(null);

  // 제공자 계약은 Theater만 안다. 사령관 소유권으로 추정하지 않고 별도의 「기타 보관」에 둔다.
  const theaterIds = [...new Set([...deps.commodores.flatMap((owner) => owner.theaters.map((theater) => theater.theaterId))])];
  const sections = useArchiveSections(query, theaterIds).filter((entry) => entry.count > 0);
  const restoredIds = new Set(restored.map((entry) => entry.objectiveRecord.id));
  const entries = [...(archive.snapshot?.entries ?? []).filter((entry) => !restoredIds.has(entry.objectiveRecord.id)), ...restored];
  const allClusters = clustersOf(entries);
  const owners = [...deps.commodores];
  // 목록과 보관 스냅숏의 갱신 순서가 달라도 항목을 숨기거나 Theater에 소유권을 넘기지 않는다.
  for (const { root } of allClusters) {
    const id = root.objectiveRecord.commodoreId;
    if (!owners.some((owner) => owner.commodoreId === id)) owners.push({ commodoreId: id, label: t("archive.unknownCommodore", { id: id.slice(0, 8) }), theaters: [] });
  }
  const ownerOf = (cluster: ArchiveCluster) => owners.find((owner) => owner.commodoreId === cluster.root.objectiveRecord.commodoreId);
  const theaterLabelOf = (cluster: ArchiveCluster) => ownerOf(cluster)?.theaters.find((theater) => theater.theaterId === cluster.root.objectiveRecord.theaterId)?.label;
  const matches = (cluster: ArchiveCluster) => {
    const node = cluster.root.objectiveRecord;
    const haystack = [node.title, ownerOf(cluster)?.label, theaterLabelOf(cluster), state.groups.find((group) => group.id === node.groupId)?.name, ...cluster.members].filter(Boolean).join(" ");
    return haystack.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  };
  const groups = owners.map((owner) => {
    const owned = allClusters.filter((cluster) => cluster.root.objectiveRecord.commodoreId === owner.commodoreId);
    const matching = owned.filter(matches);
    return { owner, clusters: matching, total: owned.filter((cluster) => !restoredIds.has(cluster.rootId)).length,
      count: matching.filter((cluster) => !restoredIds.has(cluster.rootId)).length,
      showTheater: new Set([...owner.theaters.map((theater) => theater.theaterId), ...owned.map((cluster) => cluster.root.objectiveRecord.theaterId)]).size > 1 };
  });
  const visibleGroups = groups.filter(({ owner, clusters }) => (commodoreId === null || owner.commodoreId === commodoreId) && clusters.length > 0);
  // 선택 범위와 초점 인덱스는 화면의 사령관·날짜 순서를 그대로 따른다.
  const clusters = visibleGroups.flatMap((group) => group.clusters);
  const scopedGroups = groups.filter(({ owner }) => commodoreId === null || owner.commodoreId === commodoreId);
  const total = scopedGroups.reduce((sum, group) => sum + group.total, 0);
  const matchingCount = scopedGroups.reduce((sum, group) => sum + group.count, 0);
  const allMatchingCount = groups.reduce((sum, group) => sum + group.count, 0);
  const pendingOf = (id: string) => archive.snapshot?.pendingPurges?.find((batch) => batch.objectiveIds.includes(id))
    ?? receipts.find((entry) => entry.until > clock && entry.batch.objectiveIds.includes(id))?.batch;
  const selectable = clusters.filter((cluster) => !restoredIds.has(cluster.rootId) && !pendingOf(cluster.rootId));
  const selectedIds = selectable.filter((cluster) => selected.has(cluster.rootId)).map((cluster) => cluster.rootId);
  const old = allClusters.filter((cluster) => (commodoreId === null || cluster.root.objectiveRecord.commodoreId === commodoreId) && !restoredIds.has(cluster.rootId) && !pendingOf(cluster.rootId) && cluster.archivedAt < clock - 30 * 24 * 60 * 60 * 1000);
  const selectedOwners = groups.map((group) => ({ label: group.owner.label, count: group.clusters.filter((cluster) => selectedIds.includes(cluster.rootId)).length })).filter((group) => group.count > 0);
  // 자동 정리는 화면의 검색·범위와 무관하게 모든 사령관의 보관 루트가 대상이다(삭제 보류 중인 묶음은 서버도 건너뛴다).
  const retentionTargets = (archive.snapshot?.entries ?? []).filter((entry) => !restoredIds.has(entry.objectiveRecord.id) && !pendingOf(entry.objectiveRecord.id)).map((entry) => entry.archivedAt ?? Number.NaN);

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
    const row = rows.find((item) => item.dataset.objectiveId === request!.id);
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
  const changeScope = (value: string | null) => { setCommodoreId(value); clearSelection(); };
  const escape = () => {
    if (armed) setArmed(null);
    else if (retentionOpen) setRetentionOpen(false);
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
    if (!openRestoredObjective(id)) { setNotice("archive.notice.restoreFailed"); return; }
    closeArchiveSheet();
  };
  const restore = async (ids: readonly string[]) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setArmed(null); setNotice(null);
    const before = entries.filter((entry) => ids.includes(entry.objectiveRecord.id));
    const index = clusters.findIndex((cluster) => cluster.rootId === ids[0]);
    try {
      const result = ids.length === 1 ? await restoreObjectiveCluster(ids[0]!) : await restoreArchivedObjectiveRecords(await previewObjectiveBatch(ids));
      hydrateObjectiveRecords([...getState().objectiveRecords.filter((node) => !ids.includes(node.id)), ...result.objectiveRecords]);
      setRestored((previous) => [...previous, ...before]);
      clearSelection();
      focusRequest.current = { id: ids[0]!, index, kind: "next" };
      await fetchObjectiveRecords(null).then(hydrateObjectiveRecords).catch(() => {});
      await refreshObjectiveArchive();
    } catch (error) {
      setNotice(error instanceof ApiError && error.message === "restore_parent_missing" ? "archive.notice.restoreParentMissing" : "archive.notice.restoreFailed");
      void refreshObjectiveArchive();
    } finally { busyRef.current = false; setBusy(false); }
  };
  const purged = async (id: string, result: unknown) => {
    const receipt = receiptOf(result);
    if (receipt) setReceipts((previous) => [...previous.filter((entry) => entry.batch.purgeId !== receipt.purgeId), { batch: receipt, until: Date.now() + OBJECTIVE_PURGE_GRACE_MS }]);
    clearSelection();
    focusRequest.current = { id, index: clusters.findIndex((cluster) => cluster.rootId === id), kind: "undo" };
    await refreshObjectiveArchive();
  };
  const undo = async (batch: ObjectivePendingPurge, id: string) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setArmed(null);
    try {
      await undoObjectivePurge(batch.purgeId);
      setReceipts((previous) => previous.filter((entry) => entry.batch.purgeId !== batch.purgeId));
      focusRequest.current = { id, index: clusters.findIndex((cluster) => cluster.rootId === id), kind: "restore" };
      await refreshObjectiveArchive();
    } catch { setNotice("archive.notice.undoFailed"); void refreshObjectiveArchive(); }
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
          <h2 id="archive-sheet-title">{t("archive.title")}</h2><span className="archive-sheet-count">{query.trim() ? `${matchingCount} / ${total}` : total}</span>
          <button type="button" className="archive-sheet-close" onClick={closeArchiveSheet} aria-label={t("archive.closeAria")}>✕</button>
        </header>
        <div className="archive-sheet-tabs" role="group" aria-label={t("archive.scope")}>
          <button type="button" className="archive-sheet-tab" aria-pressed={commodoreId === null} onClick={() => changeScope(null)}>
            <span>{t("archive.allCommodores")}</span><span className="archive-sheet-tab-count">{allMatchingCount}</span>
          </button>
          {groups.map(({ owner, total, count }) => <button key={owner.commodoreId} type="button"
            className={`archive-sheet-tab${count === 0 ? " is-empty" : ""}`} aria-pressed={commodoreId === owner.commodoreId}
            aria-disabled={total === 0 || undefined} aria-label={`${owner.label} ${count}`} title={owner.label}
            onClick={() => { if (total > 0) changeScope(owner.commodoreId); }}>
            <ArchiveCommodoreAvatar id={owner.commodoreId} label={owner.label} />
            <span className="archive-sheet-tab-label">{owner.label}</span><span className="archive-sheet-tab-count">{count}</span>
          </button>)}
        </div>
        <div className="archive-sheet-tools">
          <input ref={searchRef} className="archive-sheet-search" value={query} onChange={(event) => changeQuery(event.target.value)} placeholder={t("archive.search")} aria-label={t("archive.search")} />
        </div>
        {notice ? <p className="archive-sheet-notice" role="status">{t(notice)}</p> : null}
        <div className="archive-sheet-body">
          {clusters.length === 0 && sections.length === 0 ? <div className="archive-sheet-empty" role="status">
            {archive.loading && archive.snapshot === null ? t("archive.loading") : archive.error && archive.snapshot === null ? t("archive.loadFailed") : query.trim() ?
              <p>{t("archive.noMatches", { query })}</p> : <><strong>{t("archive.emptyTitle")}</strong><p>{t("archive.emptyGuide")}</p><p>{t("archive.emptyDormant")}</p></>}
          </div> : null}
          <div role="listbox" aria-label={t("archive.title")} aria-multiselectable="true">
            {visibleGroups.map(({ owner, clusters: ownedClusters, count, showTheater }) => <section key={owner.commodoreId} className="archive-sheet-commodore" aria-labelledby={`archive-sheet-owner-${owner.commodoreId}`}>
              <h3 id={`archive-sheet-owner-${owner.commodoreId}`} className="archive-sheet-commodore-head">
                <ArchiveCommodoreAvatar id={owner.commodoreId} label={owner.label} /><span>{owner.label}</span><span className="archive-sheet-section-count">{count}</span>
              </h3>
              {daysOf(ownedClusters).map((day) => {
              const label = dayLabelOf(day.at, clock, locale, t);
              const dayId = `archive-sheet-day-${owner.commodoreId}-${day.key}`;
              return <section key={day.key} className="archive-sheet-day" aria-labelledby={dayId}>
                <h4 id={dayId} className="archive-sheet-day-date"><span className="archive-sheet-day-main">{label.main}</span><span className="archive-sheet-day-sub">{label.sub}</span></h4>
                <div className="archive-sheet-day-items">
                  {day.clusters.map((cluster) => {
                    const node = cluster.root.objectiveRecord;
                    const group = state.groups.find((candidate) => candidate.id === node.groupId);
                    const meta = [new Intl.DateTimeFormat(LOCALE_TAG[locale], { hour: "numeric", minute: "2-digit" }).format(cluster.archivedAt),
                      showTheater ? theaterLabelOf(cluster) : null, group?.name,
                      cluster.members.length ? cluster.members.join(", ") : null].filter(Boolean).join(" · ");
                    const isRestored = restoredIds.has(cluster.rootId);
                    const pending = pendingOf(cluster.rootId);
                    const index = clusters.indexOf(cluster);
                    return <article key={cluster.rootId} data-objective-id={cluster.rootId} className={`archive-sheet-item${selectedIds.includes(cluster.rootId) ? " is-selected" : ""}${isRestored ? " is-restored" : ""}${pending ? " is-pending" : ""}`}
                      role="option" aria-label={node.title} aria-selected={selectedIds.includes(cluster.rootId)} aria-disabled={isRestored || !!pending || undefined} tabIndex={0}
                      onFocus={() => { lastFocused.current = { id: cluster.rootId, index }; }}
                      onClick={(event) => { if (!(event.target instanceof Element) || event.target.closest("button")) return; select(cluster.rootId, event.shiftKey); }}
                      onKeyDown={(event) => { if (event.key !== " " || event.target !== event.currentTarget) return; event.preventDefault(); if (!event.repeat) select(cluster.rootId, event.shiftKey); }}>
                      <div className="archive-sheet-item-main"><p className="archive-sheet-item-title" title={node.title}><Highlight text={node.title} query={query} /></p><p className="archive-sheet-item-meta" title={meta}><Highlight text={meta} query={query} /></p></div>
                      <div className="archive-sheet-actions">
                        {isRestored ? <><span>{t("archive.restored")}</span><span aria-hidden="true">·</span><button type="button" className="archive-sheet-open" onClick={() => open(cluster.rootId)}>{t("archive.open")}</button></> : pending ?
                          <><span>{t("archive.pending", { seconds: Math.max(0, Math.ceil((pending.purgeAt - clock) / 1000)) })}</span><button type="button" className="archive-sheet-undo" aria-disabled={busy || undefined} onClick={() => { void undo(pending, cluster.rootId); }}>{t("archive.undo")}{pending.objectiveIds.length > 1 ? ` (${pending.objectiveIds.length})` : ""}</button></> :
                          <><button type="button" className="archive-sheet-restore" aria-disabled={busy || undefined} onClick={() => { void restore([cluster.rootId]); }}>{t("archive.restore")}</button>
                            <ArchivePurgeButton targetId={cluster.rootId} title={node.title} currentRevision={archive.revision} preview={previewObjectivePurge} purge={purgeArchivedObjectiveRecords}
                              armed={armed === cluster.rootId} onArm={() => setArmed(cluster.rootId)} onDisarm={() => setArmed(null)} disabled={busy}
                              onStart={() => setNotice(null)} onRefused={(message) => { setNotice(message); void refreshObjectiveArchive(); }} onPurged={(result) => { void purged(cluster.rootId, result); }} /></>}
                      </div>
                    </article>;
                  })}
                </div>
              </section>;
            })}
            </section>)}
          </div>
          {sections.length > 0 ? <section className="archive-sheet-other-archives" aria-labelledby="archive-sheet-other-title">
            <h3 id="archive-sheet-other-title" className="archive-sheet-section-head">{t("archive.otherArchives")}</h3>
            {sections.map(({ section, count }) => <section key={section.id} className="archive-sheet-section" aria-labelledby={`archive-sheet-section-${section.id}`} data-archive-section={section.id}>
              <h4 id={`archive-sheet-section-${section.id}`} className="archive-sheet-section-head"><span>{section.title(locale)}</span><span className="archive-sheet-section-count">{count}</span></h4>
              <div className="archive-sheet-section-body">{theaterIds.filter((id) => section.count(id, query) > 0).map((id) => <div key={id}><p className="archive-sheet-plugin-theater">{deps.commodores.flatMap((owner) => owner.theaters).find((theater) => theater.theaterId === id)?.label}</p>{section.render({ language: locale, theaterId: id, query, close: closeArchiveSheet })}</div>)}</div>
            </section>)}
          </section> : null}
        </div>
        {selectedIds.length > 0 ? <footer className="archive-sheet-selection">
          <span className="archive-sheet-selection-summary">{[t("archive.selected", { count: selectedIds.length }), ...selectedOwners.map((owner) => `${owner.label} ${owner.count}`)].join(" · ")}</span>
          <button type="button" className="archive-sheet-restore" aria-disabled={busy || undefined} onClick={() => { void restore(selectedIds); }}>{t("archive.restoreAll")}</button>
          <ArchivePurgeButton targetId="batch" title={t("archive.selected", { count: selectedIds.length })} currentRevision={archive.revision} preview={() => previewObjectiveBatch(selectedIds)} purge={purgeArchivedObjectiveRecords}
            armed={armed === "batch"} onArm={() => setArmed("batch")} onDisarm={() => setArmed(null)} armedLabel={t("archive.purgeBatchArmed", { count: selectedIds.length })} disabled={busy}
            onStart={() => setNotice(null)} onRefused={(message) => { setNotice(message); void refreshObjectiveArchive(); }} onPurged={(result) => { void purged(selectedIds[0]!, result); }} />
          <button type="button" className="archive-sheet-deselect" onClick={clearSelection}>{t("archive.deselect")}</button>
        </footer> : null}
        <ArchiveRetention open={retentionOpen} onOpenChange={setRetentionOpen} archivedAts={retentionTargets}>
          {old.length > 0 ? <span className="archive-sheet-old">{t("archive.oldCount", { count: old.length })} <button type="button" aria-disabled={busy || undefined} onClick={() => { if (busyRef.current) return; setQuery(""); setArmed(null); setSelected(new Set(old.map((cluster) => cluster.rootId))); anchorRef.current = null; }}>{t("archive.clearOld")}</button></span> : null}
        </ArchiveRetention>
      </div>
    </div>, document.body,
  );
}

/** 확정 응답에 보류 영수증이 있으면 꺼낸다. */
function receiptOf(result: unknown): ObjectivePendingPurge | null {
  if (!result || typeof result !== "object") return null;
  const { purgeId, purgeAt, objectiveIds } = result as Partial<ObjectivePurgeResult>;
  return typeof purgeId === "string" && typeof purgeAt === "number" && Array.isArray(objectiveIds) ? { purgeId, purgeAt, objectiveIds } : null;
}

/** 두 번 눌러 확정하며, 첫 누름의 revision과 서버가 preview한 대상 집합을 끝까지 검증한다. */
export function ArchivePurgeButton({ targetId, title, currentRevision, preview, purge, onStart, onRefused, onPurged, armed, onArm, onDisarm, armedLabel, disabled }: {
  readonly targetId: string;
  readonly title: string;
  readonly currentRevision: number;
  readonly preview: (objectiveId: string) => Promise<ObjectivePurgeConfirmation>;
  readonly purge: (confirmation: ObjectivePurgeConfirmation) => Promise<ObjectivePurgeResult | unknown>;
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

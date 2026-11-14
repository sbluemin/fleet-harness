import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CommodoreDeleteFlow, type CommodoreDeleteAdapter } from "../../../commodore/client/commodore-delete-body.js";
import { CommodoreDeleteDialog } from "../../../commodore/client/commodore-delete-modal.js";
import { DirectoryBrowserModal } from "../../../../core/client/src/chrome/components/directory-browser-modal.js";
import type { TheaterFolderListResponse } from "../../../../core/client/src/integration/api.js";
import { ConfirmDialog } from "@fleet-console/ui/react";
import { useT, useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import { getT as getExecutionT } from "../../../execution/client/agent/i18n/index.js";
import { TaskforceCreateDialog } from "../../../commodore/client/taskforce/taskforce.js";
import { taskforceT } from "../../../commodore/client/taskforce/i18n.js";
import { ObjectiveScheduleMenu } from "./group-context-menu.js";
import type { SidebarRemoteCommodore, SidebarRemoteObjective, SidebarRemotePage } from "../../shared/sidebar-remote.js";
import type { UnifiedSidebarRow } from "@fleet-console/protocol/desktop/console-section";
import { sidebarJson } from "../../../remote-access/client/sidebar-transport.js";
import { objectiveTabHasContent } from "../../../objectives/client/detail-content.js";
import type { SharedFolderList } from "../../../objectives/shared/shared-folder.js";
import { objectiveSidebarRow } from "../../../objectives/client/clusters.js";
import { indexClusters } from "../objective-clusters.js";
import { sortCommanderRows } from "../commander-tab/commander-sort.js";
import { isNotStartedRow, settledOrder, type CommanderSection } from "../commander-tab/commander-rows.js";
import { CommanderSidebarSections } from "../commander-tab/commander-list.js";
import { CommanderRowGlyphButtons, type CommanderRowGlyphTab } from "../commander-tab/commander-row-glyphs.js";
import { MongleAvatar } from "../components/mongle-avatar.js";
import { fallbackMongleBase, objectiveRecordAvatarKey, commodoreAvatarKey } from "../../shared/avatars.js";
import { SideBarClusterRow, type SideBarRowItem } from "./side-bar-cluster-row.js";
import { TheaterSectionHeader } from "./objective-records-side-bar.js";
import type { UnifiedStandingFrame } from "./unified-sidebar-sections.js";
import { CommodoreHoverDock } from "./commodore-hover-dock.js";
import { SectionMenu, MenuItem } from "./commodore-sidebar-sections.js";
import { requestSideBarObjectiveAction } from "./interaction.js";
import { useRemoteSidebar, refreshRemoteSidebar } from "./remote-sidebar-store.js";
import { RemoteSidebarPopup } from "./remote-sidebar-popup.js";

type Menu = { readonly kind: "owner"; readonly anchor: DOMRect; readonly opener: HTMLElement | null; readonly focus: boolean }
  | { readonly kind: "objective"; readonly item: SideBarRowItem; readonly source: SidebarRemoteObjective; readonly anchor: DOMRect; readonly opener: HTMLElement | null; readonly focus: boolean };

/** 다른 Console을 지역 상점에 넣지 않는다. 표시·입력 문법만 공유하고 명령은 대상 id와 함께 반환한다. */
export function RemoteSidebarRow({ row, console, summary, directory, compact, frame, onOpen, placement }: {
  readonly row: UnifiedSidebarRow; readonly console: string; readonly summary: SidebarRemoteCommodore; readonly directory: SidebarRemotePage;
  readonly compact: boolean; readonly frame: UnifiedStandingFrame; readonly onOpen: (commander: string | null, element: HTMLElement) => void;
  readonly placement: (onClose: () => void) => ReactNode;
}) {
  const t = useT();
  const language = useConsoleLocale();
  const tf = taskforceT(language);
  const et = getExecutionT(language === "ko" ? "ko" : "en");
  const [editing, setEditing] = useState(false);
  const [readOnlyFolds, setReadOnlyFolds] = useState<SidebarRemotePage["preferences"]["folds"] | null>(null);
  const [menuSnapshot, setMenu] = useState<Menu | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"group" | "delete" | "taskforce" | "deleteTaskforce" | "folder" | null>(null);
  const [draft, setDraft] = useState("");
  const [popup, setPopup] = useState<{ readonly id: string; readonly tab: CommanderRowGlyphTab; readonly opener: HTMLElement } | null>(null);
  const [archive, setArchive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingOpen = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelOpen = () => { if (pendingOpen.current !== null) clearTimeout(pendingOpen.current); pendingOpen.current = null; };
  useEffect(() => cancelOpen, []);
  // 다른 문서로 전환하기 전에 제목의 두 번째 클릭을 기다린다. 더블클릭 이름 편집이 전환에 먹히지 않게 한다.
  const openFromClick = (id: string | null, element: HTMLElement) => {
    cancelOpen();
    pendingOpen.current = setTimeout(() => { pendingOpen.current = null; if (element.isConnected) onOpen(id, element); }, 500);
  };
  const { page, error: readError } = useRemoteSidebar(!compact && !summary.taskforce ? console : null, row.commodoreId);
  const menu = menuSnapshot?.kind === "objective" ? { ...menuSnapshot, source: page?.objectives.find((entry) => entry.objective.id === menuSnapshot.source.objective.id) ?? menuSnapshot.source } : menuSnapshot;
  const preferences = page?.preferences ?? directory.preferences;
  const writable = directory.writable && (page?.writable ?? true);
  const close = () => { setMenu(null); if (document.hasFocus()) menu?.opener?.focus({ preventScroll: true }); };
  const mutate = async (operation: Parameters<typeof sidebarJson>[1], body: unknown, query?: Readonly<Record<string, string>>) => {
    if (!writable || busy) throw new Error(!writable ? "sidebar_read_only" : "sidebar_busy");
    setBusy(true); setError(null);
    try { const result = await sidebarJson<unknown>(console, operation, body, query); refreshRemoteSidebar(console); refreshRemoteSidebar(console, row.commodoreId); return result; }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); throw error; }
    finally { setBusy(false); }
  };
  const patch = (id: string, value: unknown) => { void mutate("patch", { objectiveId: id, patch: value }).catch(() => undefined); };
  const items = useMemo(() => {
    if (!page) return [];
    const sources = new Map(page.objectives.map((source) => [source.objective.id, source]));
    const clusters = page.objectives.flatMap((source, index) => {
      const objective = source.objective;
      const row = objectiveSidebarRow(objective, index, [], objective.hasSession === true, false, objective.origin?.title,
        { active: page.autonomous, enabled: true, stalled: [] }, false, page.at, summary.name);
      if (!row) return [];
      // rowOf의 지역 동작은 절대로 실행하지 않는다. 모든 쓰기·review·열기를 대상 Console로 바꾼다.
      const adapted = { ...row, ...(writable ? { rename: (title: string) => { cancelOpen(); patch(objective.id, { title }); }, moveToGroup: (groupId: string | null) => patch(objective.id, { groupId }) } : { rename: undefined, moveToGroup: undefined }),
        archive: writable ? () => setArchive(objective.id) : undefined, review: undefined };
      return [{ id: `${console}:${objective.id}`, theaterId: objective.theaterId, commodoreId: objective.commodoreId,
        title: objective.title, root: objective.id, members: objective.members.map((member) => ({ objectiveId: member.id, label: member.role, name: member.role, after: [], progress: "open" as const })), row: adapted }];
    });
    return sortCommanderRows(indexClusters(clusters).rows.map((layout): SideBarRowItem => ({ layout, row: layout.cluster.row!, anchor: null, fold: [] })), preferences.sort)
      .flatMap((item) => { const source = sources.get(item.layout.cluster.root!); return source ? [{ item, source }] : []; });
  // patch의 대상은 props의 Console로 고정되고, 갱신 스냅샷마다 다시 만든다.
  }, [page, preferences.sort, summary.name, console, writable]); // eslint-disable-line react-hooks/exhaustive-deps
  const face = (source: SidebarRemoteObjective, state: SidebarRemoteCommodore["state"]) => {
    const root = source.faces[source.objective.id];
    const working = source.objective.members.filter((member) => ["running", "awaiting", "unseen"].includes(source.faces[member.id]?.state ?? "")).slice(0, 3);
    const full = working.length > 0 ? 26 : 30;
    const avatar = <MongleAvatar role="commander" base={root?.look?.base ?? fallbackMongleBase(objectiveRecordAvatarKey(source.objective.id))}
      tone={root?.look?.tone} state={state} activity={root?.activity} size={full} label={source.objective.title} decorative />;
    return working.length ? <span className="side-bar-cluster-avatars" style={{ width: 30, height: 30 }}>{avatar}<span className="side-bar-cluster-avatars-minis" aria-hidden="true">
      {working.map((member) => { const shown = source.faces[member.id]!; return <span key={member.id} className="side-bar-cluster-avatars-mini">
        <MongleAvatar role="member" base={shown.look?.base ?? fallbackMongleBase(objectiveRecordAvatarKey(member.id))} tone={shown.look?.tone} state={shown.state} activity={shown.activity} size={14} label="" decorative />
      </span>; })}</span></span> : avatar;
  };
  const render = ({ item, source }: (typeof items)[number], settled: boolean) => {
    const id = source.objective.id;
    const glyph = item.row.glyph;
    const state = glyph === "fresh" || glyph === "review" ? glyph : source.faces[id]?.state ?? (glyph === "done" ? "done" : "idle");
    const shownState = state === "decision" ? "awaiting" : state === "error" ? "idle" : state;
    const activities = [id, ...source.objective.members.map((member) => member.id)].map((entryId) => source.faces[entryId]?.activity ?? null);
    const rowActivity = activities.find((activity) => activity !== null && activity !== "background") ?? activities.find((activity) => activity !== null) ?? null;
    const openPopup = (tab: CommanderRowGlyphTab, opener: HTMLElement) => setPopup({ id, tab, opener });
    return <SideBarClusterRow key={id} item={item} selected={false} settled={settled}
      presentation={{ state: shownState, avatar: face(source, state), activity: rowActivity, toolUse: source.tool }}
      onRenameBegin={cancelOpen} onFocus={(_id, element) => { if (element) openFromClick(id, element); }}
      popups={{ onAvatar: (opener) => openPopup("goal", opener), onProgress: (opener) => openPopup("crew", opener), avatarLabel: source.objective.title,
        progressLabel: (done, total) => `${source.objective.title} ${done}/${total}` }}
      rowGlyphs={<RemoteRowGlyphs console={console} source={source} onGlyph={openPopup} />}
      onContextMenu={(item, anchor, opener, focus = false) => { cancelOpen(); setMenu({ kind: "objective", source, item, anchor, opener, focus }); }} />;
  };
  const active = items.filter(({ item }) => !isNotStartedRow(item.row) && item.row.glyph !== "done");
  const settledByItem = new Map(items.map((entry) => [entry.item, entry]));
  const settled = settledOrder(items.filter(({ item }) => isNotStartedRow(item.row)).map(({ item }) => item), items.filter(({ item }) => item.row.glyph === "done").map(({ item }) => item))
    .map((item) => settledByItem.get(item)!);
  const groups = [...(page?.groups ?? [])].filter((group) => group.commodoreId === row.commodoreId).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  const groupIds = new Set(groups.map((group) => group.id));
  const activeSections: CommanderSection[] = preferences.sort.grouped
    ? [...groups.map((group) => ({ id: group.id, title: group.name, rows: active.filter(({ item }) => item.row.groupId === group.id).map(({ item }) => item), fold: null })),
      { id: "ungrouped", title: t("commanderTab.ungrouped"), rows: active.filter(({ item }) => !groupIds.has(item.row.groupId ?? "")).map(({ item }) => item), fold: null }].filter((section) => section.rows.length > 0)
    : active.length ? [{ id: "active", title: null, rows: active.map(({ item }) => item), fold: null }] : [];
  const sections: readonly CommanderSection[] = [...activeSections, ...(preferences.showSettled && settled.length ? [{ id: "settled", title: null, rows: settled.map(({ item }) => item), fold: "settled" as const,
    settled: true as const, freshCount: settled.filter(({ item }) => isNotStartedRow(item.row)).length, doneCount: settled.filter(({ item }) => item.row.glyph === "done").length }] : [])];
  const header = useRef<HTMLDivElement | null>(null);
  const taskforceAvatar = summary.taskforce ? <span className="side-bar-theater-anchor is-avatar" aria-hidden="true"><span className="taskforce-stack" data-count={Math.min(4, summary.taskforce.members.length)}>
    {summary.taskforce.members.slice(0, 4).map((id) => { const member = directory.commodores.find((row) => row.id === id); return <MongleAvatar key={id} role="commodore" base={member?.look?.base ?? fallbackMongleBase(commodoreAvatarKey(id))} tone={member?.look?.tone} state="idle" size={18} label="" decorative />; })}
  </span></span> : undefined;
  const activate = () => {
    if (header.current) openFromClick(null, header.current);
  };
  return <>
    <div ref={header} onKeyDownCapture={cancelOpen}>
      <TheaterSectionHeader theater={{ id: `${console}:${row.commodoreId}`, label: summary.name, createdAt: "", lastOpenedAt: "", activeAdmiralCount: 0, commodore: { id: row.commodoreId, alias: summary.name } }}
        accessory={frame.accessory} avatarOverride={taskforceAvatar} active={false} selectedOverride={false} lastResponse={summary.preview || undefined} dock={!compact && !summary.taskforce}
        presentation={{ live: summary.live, browsing: summary.browsing,
          mark: summary.taskforce ? null : <button type="button" className={`objectives-commodore-mark${summary.state === "error" ? " is-warn" : ""}`} onClick={activate} title={summary.name} aria-label={summary.name}>
            <MongleAvatar base={summary.look?.base ?? fallbackMongleBase(commodoreAvatarKey(row.commodoreId))} tone={summary.look?.tone} role="commodore" state={summary.state}
              activity={summary.activity} className="objectives-commodore-mark-glyph" size={18} label={summary.name} decorative figure />
            {summary.decisions ? <span className="objectives-commodore-mark-badge">{summary.decisions}</span> : null}
          </button>,
          dock: <CommodoreHoverDock name={summary.name} adapter={{ ...preferences, disabled: !writable || busy,
            onSort: (value) => { void mutate("saveSettings", { commanderSort: value }).catch(() => undefined); },
            onKeep: (value) => { void mutate("saveSettings", { commanderKeepExpanded: value }).catch(() => undefined); },
            onSettled: (value) => { void mutate("saveSettings", { commanderShowSettled: value }).catch(() => undefined); } }} /> }}
        clampAlias={(value) => [...value].slice(0, 40).join("")} editingAlias={editing}
        onStartAliasEdit={() => { cancelOpen(); if (writable && !summary.taskforce) setEditing(true); }} onFinishAliasEdit={(_id, alias) => { setEditing(false); if (alias !== undefined) void mutate("alias", { commodoreId: row.commodoreId, alias }).catch(() => undefined); }}
        showStatusLiveTick={summary.state === "awaiting" || summary.state === "decision"}
        dragging={frame.dragging} dropTarget={frame.dropTarget} dragOffsetY={frame.dragOffsetY} onOpenInbox={activate}
        onContextMenu={(anchor, opener, atCursor, focus = false) => { cancelOpen(); frame.onMenu(anchor, opener, atCursor, focus); setMenu({ kind: "owner", anchor, opener, focus }); }}
        menuTarget={menu?.kind === "owner"} onPointerDragStart={frame.onPointerDragStart} />
    </div>
    {!compact && !summary.taskforce ? <div className="side-bar-commander-list" data-keep-objective-active="" onKeyDownCapture={cancelOpen}><div className="commander-tab">
      {readError ? <p role="alert">{readError}</p> : null}
      <CommanderSidebarSections sections={sections} folds={!writable && readOnlyFolds ? readOnlyFolds : preferences.folds}
        onToggle={(id) => {
          if (!writable) { setReadOnlyFolds((value) => { const folds = value ?? preferences.folds; return { ...folds, [id]: !folds[id] }; }); return; }
          void mutate("saveSettings", { commanderFolds: { ...preferences.folds, [id]: !preferences.folds[id] } }).catch(() => undefined);
        }}
        renderItems={(rows, settled) => rows.map((item) => render(settledByItem.get(item)!, settled))} />
    </div></div> : null}
    {error ? <p role="alert">{error}</p> : null}
    {menu ? <SectionMenu anchor={menu.anchor} focusFirst={menu.focus} opener={menu.opener} label={summary.name} onClose={close}>
      {menu.kind === "owner" ? <>
        {placement(close)}
        {writable ? summary.taskforce ? <MenuItem icon={null} danger onClick={() => { close(); setDialog("deleteTaskforce"); }}>{tf("taskforce.delete")}</MenuItem> : <>
          <MenuItem icon={null} onClick={() => { close(); setEditing(true); }}>{t("sidebar.commodore.rename")}</MenuItem>
          {directory.taskforceEnabled ? <MenuItem icon={null} onClick={() => { close(); setDialog("taskforce"); }}>{tf("taskforce.fromCommodore")}</MenuItem> : null}
          <MenuItem icon={null} onClick={() => { close(); setDialog("folder"); }}>{t("sidebar.commodore.addTheater")}</MenuItem>
          <MenuItem icon={null} danger onClick={() => { close(); setDraft(""); setDialog("delete"); }}>{t("sidebar.commodore.delete")}</MenuItem>
        </> : null}
      </> : <>
        <MenuItem icon={null} onClick={() => { const id = menu.source.objective.id; const element = menu.opener; close(); if (element) onOpen(id, element); }}>{t("sidebar.groupMenu.open")}</MenuItem>
        {writable ? <>
          <MenuItem icon={null} onClick={() => { const id = menu.item.layout.cluster.id; close(); requestSideBarObjectiveAction(id, "rename"); }}>{t("sidebar.groupMenu.rename")}</MenuItem>
          {!menu.source.objective.done ? <ObjectiveScheduleMenu objective={menu.source.objective} language={language === "ko" ? "ko" : "en"}
            locked={busy || menu.source.ownWorking}
            patch={(value) => patch(menu.source.objective.id, value)} onClose={close} /> : null}
          {page?.computerUseAvailable && menu.source.objective.hasSession ? <MenuItem icon={null} checked={menu.source.computerUseEnabled} disabled={busy} onClick={() => { void mutate("computerUse", { enabled: !menu.source.computerUseEnabled, language: language === "ko" ? "ko" : "en" }, { objectiveId: menu.source.objective.id }).catch(() => undefined); }}>
            {et("terminal.experiments.menuComputerUse")} · {et(menu.source.computerUseEnabled ? "terminal.experiments.menuComputerUseOn" : "terminal.experiments.menuComputerUseOff")}
          </MenuItem> : null}
          {(page?.groups ?? []).filter((group) => group.commodoreId === row.commodoreId).map((group) => <MenuItem icon={null} key={group.id} checked={menu.source.objective.groupId === group.id} onClick={() => { patch(menu.source.objective.id, { groupId: menu.source.objective.groupId === group.id ? null : group.id }); close(); }}>{group.name}</MenuItem>)}
          <MenuItem icon={null} onClick={() => { patch(menu.source.objective.id, { groupId: null }); close(); }}>{t("commanderTab.ungrouped")}</MenuItem>
          <MenuItem icon={null} onClick={() => { setDraft(""); setDialog("group"); }}>{t("sidebar.groupMenu.newGroup")}</MenuItem>
          <MenuItem icon={null} danger onClick={() => { setArchive(menu.source.objective.id); close(); }}>{t("sidebar.groupMenu.archive")}</MenuItem>
        </> : null}
      </>}
    </SectionMenu> : null}
    {dialog === "deleteTaskforce" && summary.taskforce ? <ConfirmDialog question={tf("taskforce.deleteQuestion", { name: summary.name })} cancelLabel={tf("taskforce.cancel")} confirmLabel={tf("taskforce.deleteConfirm")} danger busy={busy} error={error}
      onCancel={() => setDialog(null)} onConfirm={() => { void mutate("taskforceDelete", { taskforceId: summary.taskforce!.id }).then(() => setDialog(null)).catch(() => undefined); }} /> : null}
    {dialog === "delete" ? <RemoteDeleteCommodore console={console} summary={summary} language={language === "ko" ? "ko" : "en"} onClose={() => setDialog(null)} /> : null}
    <DirectoryBrowserModal open={dialog === "folder"} onCancel={() => setDialog(null)}
      listFolders={(path, signal) => sidebarJson<TheaterFolderListResponse>(console, "folders", { path }, undefined, signal)}
      onConfirm={(path) => { setDialog(null); void sidebarJson<{ folderGrantId: string }>(console, "folderGrant", { path })
        .then(({ folderGrantId }) => mutate("addTheater", { commodoreId: row.commodoreId, folderGrantId, claudeTrustConsent: true })).catch((error: unknown) => setError(String(error))); }} />
    {dialog === "taskforce" ? <TaskforceCreateDialog preselected={row.commodoreId} onClose={() => setDialog(null)} adapter={{
      candidates: directory.commodores.filter((member) => !member.taskforce).map((member) => ({ id: member.id, name: member.name,
        avatar: <MongleAvatar role="commodore" base={member.look?.base ?? fallbackMongleBase(commodoreAvatarKey(member.id))} tone={member.look?.tone} state="idle" size={28} label="" decorative /> })),
      create: (input) => mutate("taskforceCreate", input),
    }} /> : null}
    {dialog === "group" ? <SectionMenu anchor={new DOMRect(window.innerWidth / 2 - 140, 100, 280, 0)} focusFirst={false} opener={null} label={summary.name} onClose={() => setDialog(null)}>
      <form onSubmit={(event) => { event.preventDefault();
        void mutate("groupCreate", { commodoreId: row.commodoreId, name: draft, color: "teal" }).then(async (result) => {
          if (menu?.kind === "objective") {
            const group = (result as { group?: { id?: string } } | undefined)?.group;
            if (group?.id) {
              await sidebarJson(console, "patch", { objectiveId: menu.source.objective.id, patch: { groupId: group.id } });
              refreshRemoteSidebar(console, row.commodoreId);
            }
          }
          setDialog(null); close();
        }).catch((error: unknown) => setError(String(error)));
      }}><label>{t("sidebar.groupMenu.newGroup")}
        <input autoFocus value={draft} maxLength={80} onChange={(event) => setDraft(event.target.value)} /></label>
        <button type="submit" disabled={busy || !draft.trim()}>{t("chrome.consoles.save")}</button>
      </form>
    </SectionMenu> : null}
    {archive ? <ConfirmDialog question={t("sidebar.groupMenu.archive")} cancelLabel={t("common.cancel")} confirmLabel={t("sidebar.groupMenu.archive")} danger busy={busy} error={error}
      onCancel={() => setArchive(null)} onConfirm={() => { void mutate("archive", { objectiveId: archive, restorable: true }).then(() => setArchive(null)).catch(() => undefined); }} /> : null}
    {popup ? <RemoteSidebarPopup console={console} objectiveId={popup.id} machine={row.machineLabel} tab={popup.tab} opener={popup.opener} onClose={() => setPopup(null)} /> : null}
  </>;
}

function RemoteRowGlyphs({ console, source, onGlyph }: { readonly console: string; readonly source: SidebarRemoteObjective; readonly onGlyph: (tab: CommanderRowGlyphTab, opener: HTMLElement) => void }) {
  const group = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  const [shared, setShared] = useState<number | null>(null);
  const id = source.objective.id;
  useEffect(() => {
    const row = group.current?.closest<HTMLElement>(".side-bar-cluster-row");
    if (!row) return;
    const on = () => setNear(true), off = () => setNear(false);
    row.addEventListener("pointerenter", on); row.addEventListener("pointerleave", off); row.addEventListener("focusin", on); row.addEventListener("focusout", off);
    return () => { row.removeEventListener("pointerenter", on); row.removeEventListener("pointerleave", off); row.removeEventListener("focusin", on); row.removeEventListener("focusout", off); };
  }, []);
  useEffect(() => {
    if (!near) return;
    const abort = new AbortController();
    void sidebarJson<SharedFolderList>(console, "shared", undefined, { objectiveId: id }, abort.signal)
      .then((list) => { if (!abort.signal.aborted) setShared(list.entries.length); }).catch(() => undefined);
    return () => abort.abort();
  }, [console, id, near]);
  return <CommanderRowGlyphButtons groupRef={group} title={source.objective.title}
    empty={(tab) => !(tab === "goal" && !source.objective.done) && !objectiveTabHasContent(source.objective, tab, shared)} onGlyph={onGlyph} />;
}

function RemoteDeleteCommodore({ console, summary, language, onClose }: {
  readonly console: string; readonly summary: SidebarRemoteCommodore; readonly language: "en" | "ko"; readonly onClose: () => void;
}) {
  const adapter = useMemo<CommodoreDeleteAdapter>(() => ({
    preview: (input, signal) => sidebarJson(console, "deletePreview", input, undefined, signal),
    remove: (input) => sidebarJson(console, "deleteCommodore", input),
    avatar: <MongleAvatar role="commodore" base={summary.look?.base ?? fallbackMongleBase(commodoreAvatarKey(summary.id))} tone={summary.look?.tone} state="idle" size={40} label={summary.name} decorative />,
  }), [console, summary.id, summary.name, summary.look?.base, summary.look?.tone]);
  return createPortal(<CommodoreDeleteFlow commodoreId={summary.id} language={language} adapter={adapter} onClose={onClose}
    onComplete={() => { refreshRemoteSidebar(console); onClose(); }} renderFrame={(frame) => <CommodoreDeleteDialog frame={frame} />} />, document.body);
}

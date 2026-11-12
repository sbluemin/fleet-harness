import type { ReactNode } from "react";
import { CONSOLE_ROSTER_MAX_COMMANDERS, type ConsoleRosterCommander, type ConsoleRosterCommodore, type ConsoleRosterRun, type ConsoleSectionEntry } from "@fleet-console/protocol/desktop/console-section";
import { ChevronGlyph } from "@fleet-console/ui/react";
import { useT } from "../../../../core/client/src/i18n/index.js";
import { getRailStoreSnapshot } from "../../../../core/client/src/chrome/rail/rail-store.js";
import { ConsoleSectionHead, consoleSwitchBlocked, type ConsoleSections } from "../../../remote-access/client/console-sections.js";
import { commodoreAvatarKey, fallbackMongleBase, objectiveRecordAvatarKey, type MongleState } from "../../shared/avatars.js";
import { isIdentityTone } from "../../shared/identity-tones.js";
import { openCommanderConversation } from "../commander-tab/commander-navigation.js";
import { useCommanderRows } from "../commander-tab/commander-rows.js";
import { MongleAvatar } from "../components/mongle-avatar.js";
import { ObjectiveAvatar } from "../avatars.js";
import { commanderObjectiveId } from "../objective-clusters.js";
import { ClusterRowProgress, SideBarClusterRow, type SideBarRowItem } from "./side-bar-cluster-row.js";

/** 지금 문서의 우측 사이드바. 탭 이름이 계약(32자)을 넘으면 열림만 넘긴다. */
function currentRightPanel(): { readonly open: boolean; readonly tab?: string } {
  const id = getRailStoreSnapshot().activePanelId;
  if (id === null) return { open: false };
  if (id.length > 0 && id.length <= 32 && !/[\u0000-\u001f\u007f]/u.test(id)) return { open: true, tab: id };
  return { open: true };
}

function rosterMongleState(run: ConsoleRosterRun): MongleState {
  return run === "working" ? "running" : run === "waiting" ? "awaiting" : "idle";
}

/**
 * 지금 떠 있지 않은 콘솔 하나. 머리글 아래에 그 콘솔의 사령관과 진행 중 지휘관을
 * 로컬 목록과 같은 카드·진행 행으로 그린다. 미리보기·지휘관이 없는 옛 명부는 이름만 있는 카드다.
 * 행을 누르면 그 콘솔로 넘어가며, 스크롤이 유지되도록 사령관과 목록의 scrollTop을 함께 보낸다.
 */
export function ConsoleRosterSection({ entry, sections, list, compact }: {
  readonly entry: ConsoleSectionEntry; readonly sections: ConsoleSections; readonly list: () => HTMLElement | null; readonly compact: boolean;
}) {
  const t = useT();
  const roster = sections.roster(entry.id);
  const folded = !compact && sections.folded(entry.id);
  const blocked = consoleSwitchBlocked(entry);
  const open = (commodore: ConsoleRosterCommodore, commanderId: string | null, row: HTMLElement) => {
    if (blocked) return;
    const box = list();
    const top = box?.getBoundingClientRect().top ?? 0;
    const anchorY = Math.max(0, Math.round(row.getBoundingClientRect().top - top));
    const scrollTop = Math.max(0, Math.round(box?.scrollTop ?? 0));
    sections.command({
      switch: entry.id, commodore: commodore.id, anchorY, scrollTop, rightPanel: currentRightPanel(),
      ...(commanderId !== null ? { commander: commanderId } : {}),
    });
  };
  // 사령관 행이 없는 콘솔(빈 명부, 명부를 모르는 옛 콘솔, 첫 읽기 실패)은 누를 행이 없다. 콘솔만 전환하는 길을 남긴다.
  const enter = <button type="button" className="side-console-enter" aria-disabled={blocked}
    onClick={() => { if (!blocked) sections.command({ switch: entry.id }); }}>{t("chrome.consoles.switchHere")}</button>;
  // 인증서가 바뀐 콘솔은 지금의 추가 창만 연다. 단추만으로는 저장된 지문이 바뀌지 않는다.
  const reviewCertificate = entry.status === "untrusted"
    ? <button type="button" className="side-console-cert" onClick={() => sections.command({ add: true })}>{t("chrome.consoles.reviewCertificate")}</button>
    : null;
  // 명부가 없는 까닭은 한 줄로 남긴다. 닿지 않는 원격은 머리글의 빈 점과 흐린 행만 두고, 상태 문장은 더하지 않는다.
  const note = entry.status === "unreachable" ? null
    : entry.status === "untrusted" ? t("chrome.consoles.rosterUntrusted")
    : !sections.rosterCapable || roster === null ? null
    : roster.status === "unsupported" ? t("chrome.consoles.rosterUnsupported")
    : roster.status === "unavailable" && roster.commodores.length === 0 ? t("chrome.consoles.rosterUnavailable")
    : roster.status === "ok" && roster.commodores.length === 0 ? t("chrome.consoles.rosterEmpty") : null;
  const rows = entry.status === "untrusted" ? [] : roster?.commodores ?? [];
  const dim = entry.status === "unreachable" && rows.length > 0;
  // 심리스에서는 집 섹션에 컴퓨터 이름 머리글을 두지 않는다 — 집 문서와 같은 높이·순서를 유지하기 위해서다. 옛 셸은 머리글을 그대로 둔다.
  const headless = sections.seamless && entry.home;
  const renderCommodore = (commodore: ConsoleRosterCommodore) => {
    const look = commodore.look ?? { base: fallbackMongleBase(commodoreAvatarKey(commodore.id)), tone: null };
    const tone = look.tone !== null && isIdentityTone(look.tone) ? look.tone : null;
    const previewText = commodore.preview && commodore.preview.length > 0 ? commodore.preview : null;
    // 새 필드를 아는 명부에서 미리보기만 없으면 로컬과 같이 빈 대화 줄을 그려 높이를 맞춘다. 옛 명부는 이름만.
    const modernRoster = (roster?.sections !== undefined) || rows.some((row) => row.preview !== undefined || row.commanders !== undefined);
    const preview = previewText ?? (modernRoster ? t("sidebar.commodore.noConversation") : null);
    const commanders = commodore.commanders ?? [];
    const moreCommanders = commodore.moreCommanders ?? 0;
    return <li key={commodore.id} className="side-bar-theater-section" data-theater-id={commodore.id}>
      <div className={`side-bar-theater-header is-card${preview === null ? " is-name-only" : ""}`}>
        <button type="button" className="side-bar-theater-activate" data-roster-commodore={commodore.id} aria-disabled={blocked || undefined}
          title={commodore.name} onClick={(event) => open(commodore, null, event.currentTarget)}>
          <span className="side-bar-theater-anchor is-avatar" aria-hidden="true">
            <MongleAvatar base={look.base} tone={tone} role="commodore" state="idle" size={32} label={commodore.name} decorative />
          </span>
          <span className="side-bar-theater-text">
            <span className="side-bar-theater-name">{commodore.name}</span>
            {preview !== null ? <span className="side-bar-theater-sub">{preview}</span> : null}
          </span>
        </button>
      </div>
      {!compact && (commanders.length > 0 || moreCommanders > 0) ? <div className="side-bar-commander-list">
        <ol className="commander-tab-list side-bar-group-chips">
          {commanders.map((commander) => <CommanderRosterRow key={commander.id} commander={commander} blocked={blocked}
            onOpen={(row) => open(commodore, commander.id, row)} />)}
        </ol>
        {moreCommanders > 0 ? <p className="side-console-more">{t("chrome.consoles.rosterMore", { count: String(moreCommanders) })}</p> : null}
      </div> : null}
    </li>;
  };
  const groupedHome = headless && roster?.sections && roster.sections.length > 0 && !compact;
  return <li className={`side-console${blocked ? " is-blocked" : ""}${dim ? " is-dim" : ""}${headless ? " is-headless" : ""}`} data-console-id={entry.id} data-status={entry.status ?? undefined}>
    {headless ? null : <ConsoleSectionHead entry={entry} folded={folded} count={rows.length + (roster?.more ?? 0)} sections={sections} compact={compact} appearance="row" />}
    {folded && !headless ? null : <ol className="side-console-roster" aria-label={entry.label}>
      {groupedHome && roster.sections
        ? <HomeRosterSections sections={roster.sections} unsectionedCollapsed={roster.unsectionedCollapsed === true} rows={rows} render={renderCommodore} />
        : rows.map(renderCommodore)}
      {roster && roster.more > 0 && rows.length > 0 ? <li className="side-console-more">{t("chrome.consoles.rosterMore", { count: String(roster.more) })}</li> : null}
      {note || reviewCertificate || (rows.length === 0 && !blocked) ? <li className="side-console-note">{note ? <p>{note}</p> : null}{reviewCertificate}{rows.length === 0 && !blocked ? enter : null}</li> : null}
    </ol>}
  </li>;
}

/** 집 명부의 사용자 섹션. 로컬 머리글과 같은 클래스이고, 접기·이름 바꾸기는 하지 않는다. */
function HomeRosterSections({ sections, unsectionedCollapsed, rows, render }: {
  readonly sections: readonly { readonly id: string; readonly name: string; readonly collapsed?: true }[];
  readonly unsectionedCollapsed: boolean;
  readonly rows: readonly ConsoleRosterCommodore[];
  readonly render: (commodore: ConsoleRosterCommodore) => ReactNode;
}) {
  const t = useT();
  const known = new Set(sections.map((section) => section.id));
  const unsectioned = rows.filter((row) => row.section === undefined || !known.has(row.section));
  const group = (id: string | null, name: string, collapsed: boolean, members: readonly ConsoleRosterCommodore[]) => (
    <li key={id ?? "none"} className="workspace-commodore-section" data-sidebar-section={id ?? ""}>
      <div className="workspace-commodore-section-head is-static" title={name}>
        <span className="workspace-commodore-section-label">{name}</span>
        {collapsed ? <span className="workspace-commodore-section-count">{members.length}</span> : null}
        <ChevronGlyph direction={collapsed ? "right" : "down"} className="workspace-commodore-section-chevron" />
      </div>
      {collapsed ? null : <ol className="workspace-commodore-section-rows">
        {members.length > 0 ? members.map(render) : <li className="workspace-commodore-section-empty">{t("sidebar.commodoreSection.empty")}</li>}
      </ol>}
    </li>
  );
  return <>
    {sections.map((section) => group(section.id, section.name, section.collapsed === true, rows.filter((row) => row.section === section.id)))}
    {group(null, t("sidebar.commodoreSection.none"), unsectionedCollapsed, unsectioned)}
  </>;
}

/** 원격 콘솔의 진행 중 지휘관 — 로컬 진행 행과 같은 아바타·제목·게이지. 조용함 문구는 적지 않고 얼굴만 idle이다. */
function CommanderRosterRow({ commander, blocked, onOpen, avatar }: {
  readonly commander: ConsoleRosterCommander; readonly blocked: boolean; readonly onOpen: (row: HTMLElement) => void; readonly avatar?: ReactNode;
}) {
  const t = useT();
  const run = commander.run === "working" ? t("chrome.consoles.run.working") : commander.run === "waiting" ? t("chrome.consoles.run.waiting") : null;
  const progress = commander.total > 0 ? { done: commander.done, total: commander.total } : null;
  const look = commander.look ?? null;
  const base = look?.base ?? fallbackMongleBase(objectiveRecordAvatarKey(commander.id));
  const tone = look?.tone !== undefined && look.tone !== null && isIdentityTone(look.tone) ? look.tone : null;
  return <li className="side-bar-cluster-row side-bar-cluster-row--conversation">
    <span className="side-bar-cluster-row-glyph" aria-hidden="true">
      {avatar ?? <MongleAvatar base={base} tone={tone} role="commander" state={rosterMongleState(commander.run)} size={30} label={commander.title} decorative />}
    </span>
    <button type="button" className="side-bar-cluster-row-main" data-roster-commander={commander.id} aria-disabled={blocked || undefined}
      aria-label={[commander.title, progress ? `${progress.done}/${progress.total}` : "", run ?? ""].filter(Boolean).join(", ")}
      title={commander.title} onClick={(event) => onOpen(event.currentTarget)}>
      <span className="side-bar-cluster-row-head"><span className="side-bar-cluster-row-title">{commander.title}</span></span>
      {progress !== null || run !== null ? <span className="side-bar-cluster-row-line" aria-hidden="true">
        <ClusterRowProgress progress={progress} />
        {run !== null ? <span className="side-bar-cluster-row-preview side-console-run">{run}</span> : null}
      </span> : null}
    </button>
  </li>;
}

/**
 * 심리스 다중 콘솔에서 자기 문서가 그리는 진행 중 지휘관. 명부와 같은 상한·같은 행이다.
 * 선택된 사령관만, "시작 전·완료 보이기"가 켜져 있을 때 그 밖의 행을 덧붙인다.
 */
export function SeamCommanderRows({ commodoreId, selected, showSettled, selectedCommanderId }: {
  readonly commodoreId: string; readonly selected: boolean; readonly showSettled: boolean; readonly selectedCommanderId: string | null;
}) {
  const t = useT();
  const listed = useCommanderRows(commodoreId, selectedCommanderId);
  const active = listed.listSections.filter((section) => section.settled !== true).flatMap((section) => section.rows);
  const settled = showSettled ? listed.listSections.filter((section) => section.settled === true).flatMap((section) => section.rows) : [];
  const shown = active.slice(0, CONSOLE_ROSTER_MAX_COMMANDERS);
  const more = Math.max(0, active.length - shown.length);
  const open = (id: string) => openCommanderConversation(commodoreId, id);
  return <div className="side-bar-commander-list" data-keep-objective-active="">
    <ol className="commander-tab-list side-bar-group-chips">
      {shown.map((item) => <LocalRosterCommanderRow key={item.layout.cluster.id} item={item} onOpen={open} />)}
    </ol>
    {more > 0 ? <p className="side-console-more">{t("chrome.consoles.rosterMore", { count: String(more) })}</p> : null}
    {selected && settled.length > 0 ? <ol className="commander-tab-list side-bar-group-chips">
      {settled.map((item) => <SideBarClusterRow key={item.layout.cluster.id} item={item} settled selected={selectedCommanderId !== null && commanderObjectiveId(item.layout.cluster) === selectedCommanderId} onFocus={open} />)}
    </ol> : null}
  </div>;
}

function LocalRosterCommanderRow({ item, onOpen }: { readonly item: SideBarRowItem; readonly onOpen: (id: string) => void }) {
  const id = commanderObjectiveId(item.layout.cluster) ?? item.layout.cluster.id;
  const activity = item.anchor?.status;
  const run: ConsoleRosterRun = item.row.decisionRequestedAt !== undefined || activity === "awaiting" ? "waiting" : activity === "running" ? "working" : "quiet";
  const record = item.anchor?.objectiveRecord;
  const progress = item.row.progress && item.row.progress.total > 0 ? item.row.progress : null;
  const commander: ConsoleRosterCommander = { id, title: item.layout.cluster.title, done: progress?.done ?? 0, total: progress?.total ?? 0, run };
  return <CommanderRosterRow commander={commander} blocked={false} onOpen={() => onOpen(id)} avatar={record
    ? <ObjectiveAvatar objectiveRecord={record} role="commander" state={rosterMongleState(run)} size={30} label={commander.title} decorative />
    : undefined} />;
}

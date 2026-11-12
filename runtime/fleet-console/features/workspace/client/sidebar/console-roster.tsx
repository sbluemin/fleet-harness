import type { ConsoleRosterCommander, ConsoleRosterCommodore, ConsoleSectionEntry } from "@fleet-console/protocol/desktop/console-section";
import { useT } from "../../../../core/client/src/i18n/index.js";
import { ConsoleSectionHead, consoleSwitchBlocked, type ConsoleSections } from "../../../remote-access/client/console-sections.js";
import { commodoreAvatarKey, fallbackMongleBase, objectiveRecordAvatarKey } from "../../shared/avatars.js";
import { isIdentityTone } from "../../shared/identity-tones.js";
import { MongleAvatar } from "../components/mongle-avatar.js";
import { ClusterRowProgress } from "./side-bar-cluster-row.js";

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
      switch: entry.id, commodore: commodore.id, anchorY, scrollTop,
      ...(commanderId !== null ? { commander: commanderId } : {}),
    });
  };
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
  return <li className={`side-console${blocked ? " is-blocked" : ""}${dim ? " is-dim" : ""}${headless ? " is-headless" : ""}`} data-console-id={entry.id} data-status={entry.status ?? undefined}>
    {headless ? null : <ConsoleSectionHead entry={entry} folded={folded} count={rows.length + (roster?.more ?? 0)} sections={sections} compact={compact} appearance="row" />}
    {folded && !headless ? null : <ol className="side-console-roster" aria-label={entry.label}>
      {rows.map((commodore) => {
        const look = commodore.look ?? { base: fallbackMongleBase(commodoreAvatarKey(commodore.id)), tone: null };
        const tone = look.tone !== null && isIdentityTone(look.tone) ? look.tone : null;
        const preview = commodore.preview && commodore.preview.length > 0 ? commodore.preview : null;
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
      })}
      {roster && roster.more > 0 && rows.length > 0 ? <li className="side-console-more">{t("chrome.consoles.rosterMore", { count: String(roster.more) })}</li> : null}
      {note || reviewCertificate ? <li className="side-console-note">{note ? <p>{note}</p> : null}{reviewCertificate}</li> : null}
    </ol>}
  </li>;
}

/** 원격 콘솔의 진행 중 지휘관 — 로컬 진행 행과 같은 아바타·제목·게이지. 조용함은 적지 않는다. */
function CommanderRosterRow({ commander, blocked, onOpen }: {
  readonly commander: ConsoleRosterCommander; readonly blocked: boolean; readonly onOpen: (row: HTMLElement) => void;
}) {
  const t = useT();
  const run = commander.run === "working" ? t("chrome.consoles.run.working") : commander.run === "waiting" ? t("chrome.consoles.run.waiting") : null;
  const progress = commander.total > 0 ? { done: commander.done, total: commander.total } : null;
  return <li className="side-bar-cluster-row side-bar-cluster-row--conversation">
    <span className="side-bar-cluster-row-glyph" aria-hidden="true">
      <MongleAvatar base={fallbackMongleBase(objectiveRecordAvatarKey(commander.id))} tone={null} role="commander" state="idle" size={30} label={commander.title} decorative />
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

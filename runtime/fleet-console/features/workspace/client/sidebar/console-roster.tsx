import type { ConsoleRosterCommodore, ConsoleSectionEntry } from "@fleet-console/protocol/desktop/console-section";
import { useT } from "../../../../core/client/src/i18n/index.js";
import { ConsoleSectionHead, consoleSwitchBlocked, type ConsoleSections } from "../../../remote-access/client/console-sections.js";
import { commodoreAvatarKey, fallbackMongleBase } from "../../shared/avatars.js";
import { isIdentityTone } from "../../shared/identity-tones.js";
import { MongleAvatar } from "../components/mongle-avatar.js";

/**
 * 지금 떠 있지 않은 콘솔 하나 — 머리글과 그 콘솔의 사령관을 흐리게 나열한다.
 *
 * 여기 서는 것은 셸이 건넨 명부뿐이다(이름·모습·상태 한 낱말). 미리보기와 목표는 그 콘솔로 넘어간 뒤 그 콘솔이 그린다.
 * 사령관을 누르면 그 콘솔로 전환하면서 누른 행의 높이를 함께 보낸다 — 도착한 화면이 같은 높이에 그 행을 둔다.
 */
export function ConsoleRosterSection({ entry, sections, list, compact }: {
  readonly entry: ConsoleSectionEntry; readonly sections: ConsoleSections; readonly list: () => HTMLElement | null; readonly compact: boolean;
}) {
  const t = useT();
  const roster = sections.roster(entry.id);
  const folded = !compact && sections.folded(entry.id);
  const blocked = consoleSwitchBlocked(entry);
  const open = (commodore: ConsoleRosterCommodore | null, row: HTMLElement) => {
    if (blocked) return;
    const top = list()?.getBoundingClientRect().top ?? 0;
    const anchorY = Math.max(0, Math.round(row.getBoundingClientRect().top - top));
    sections.command(commodore ? { switch: entry.id, commodore: commodore.id, anchorY } : { switch: entry.id });
  };
  const enter = <button type="button" className="side-console-enter" aria-disabled={blocked} onClick={(event) => open(null, event.currentTarget)}>{t("chrome.consoles.switchHere")}</button>;
  // 명부가 없는 까닭마다 한 줄로 말하고, 갈 수 있으면 콘솔만 전환하는 길을 남긴다.
  const note = entry.status === "untrusted" ? t("chrome.consoles.rosterUntrusted")
    : !sections.rosterCapable || roster === null ? null
    : roster.status === "unsupported" ? t("chrome.consoles.rosterUnsupported")
    : roster.status === "unavailable" && roster.commodores.length === 0 ? t("chrome.consoles.rosterUnavailable")
    : roster.status === "ok" && roster.commodores.length === 0 ? t("chrome.consoles.rosterEmpty") : null;
  const rows = entry.status === "untrusted" ? [] : roster?.commodores ?? [];
  return <li className={`side-console${blocked ? " is-blocked" : ""}`} data-console-id={entry.id} data-status={entry.status ?? undefined}>
    <ConsoleSectionHead entry={entry} folded={folded} count={rows.length + (roster?.more ?? 0)} sections={sections} compact={compact} />
    {folded ? null : <ol className="side-console-roster" aria-label={entry.label}>
      {rows.map((commodore) => {
        const look = commodore.look ?? { base: fallbackMongleBase(commodoreAvatarKey(commodore.id)), tone: null };
        const run = t(commodore.run === "working" ? "chrome.consoles.run.working" : commodore.run === "waiting" ? "chrome.consoles.run.waiting" : "chrome.consoles.run.quiet");
        return <li key={commodore.id}>
          <button type="button" className="side-console-row" data-roster-commodore={commodore.id} aria-disabled={blocked}
            title={`${commodore.name} · ${run}`} onClick={(event) => open(commodore, event.currentTarget)}>
            <MongleAvatar base={look.base} tone={look.tone !== null && isIdentityTone(look.tone) ? look.tone : null} role="commodore"
              // 다른 콘솔의 사령관은 연기하지 않는다 — 지금 하는 일은 옆의 낱말이 말한다.
              state="idle" size={24} label={commodore.name} decorative className="side-console-avatar" />
            <span className="side-console-row-name">{commodore.name}</span>
            <span className="side-console-row-run" data-run={commodore.run}>{run}</span>
            {blocked ? null : <span className="side-console-row-hint" aria-hidden="true">{t("chrome.consoles.openHere")}</span>}
          </button>
        </li>;
      })}
      {roster && roster.more > 0 && rows.length > 0 ? <li className="side-console-more">{t("chrome.consoles.rosterMore", { count: String(roster.more) })}</li> : null}
      {note || rows.length === 0 ? <li className="side-console-note">{note ? <p>{note}</p> : null}{blocked ? null : enter}</li> : null}
    </ol>}
  </li>;
}

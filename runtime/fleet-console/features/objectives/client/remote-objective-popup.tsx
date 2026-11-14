import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { ConsoleObjectivePeek } from "@fleet-console/protocol/desktop/console-section";
import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { consoleObjectivePeekAllowed, type ConsoleSections } from "../../remote-access/client/console-sections.js";
import { closeObjectivePeek, objectivePeekSnapshot, openObjectivePeek, subscribeObjectivePeek, type ObjectivePeekTab } from "../../remote-access/client/objective-peek.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { LineupZoom } from "./objectives-panel.js";
import "./remote-objective-popup.css";

const TABS: readonly ObjectivePeekTab[] = ["goal", "crew", "results"];
const TAB_KEYS: Record<ObjectivePeekTab, ObjectiveMessageKey> = {
  goal: "objectives.tabs.goal", crew: "objectives.missions.title", results: "objectives.results.title",
};

/** 명부의 글과 결과물 목록만 그린다. 지역 목표·파일·첨부·공유 폴더 훅은 이 경계 안에 들이지 않는다. */
export function RemoteObjectivePopupHost({ sections }: { readonly sections: ConsoleSections }) {
  const opened = useSyncExternalStore(subscribeObjectivePeek, objectivePeekSnapshot, () => null);
  const t = getT(useConsoleLocale() === "ko" ? "ko" : "en");
  useEffect(() => () => closeObjectivePeek(false), []);
  const allowed = opened !== null && consoleObjectivePeekAllowed(sections, opened.target.console);
  useEffect(() => { if (opened !== null && !allowed) closeObjectivePeek(); }, [opened, allowed]);
  if (opened === null || !allowed) return null;
  const data = opened.snapshot;
  return createPortal(<LineupZoom t={t} title={data?.title ?? opened.target.title} category={t(TAB_KEYS[opened.tab])}
    width={880} onClose={() => closeObjectivePeek()}
    tools={<span className="objectives-remote-peek-source"><b>{opened.target.machine}</b><span>{t("objectives.peek.readOnly")}</span></span>}>
    <div className="objectives-remote-peek">
      <nav className="objectives-remote-peek-tabs" aria-label={t("objectives.tabs.aria")}>
        {TABS.map((tab) => <button key={tab} type="button" className="objectives-popup-text-button" aria-pressed={opened.tab === tab}
          onClick={() => openObjectivePeek(opened.target, tab)}>{t(TAB_KEYS[tab])}</button>)}
      </nav>
      <div className="objectives-remote-peek-content">
        {opened.status !== "ok" ? <p role="status">{t(opened.status === "loading" ? "objectives.peek.loading" : `objectives.peek.${opened.status}`)}</p>
          : data ? <>
            <p className="objectives-remote-peek-state">{t(`objectives.peek.status.${data.phase}`)}</p>
            {data.truncated ? <p role="status">{t("objectives.peek.truncated")}</p> : null}
            {opened.tab === "goal" ? <>
              <section><h3>{t("objectives.objective.memo")}</h3><p className="objectives-remote-peek-prose">{data.note || t("objectives.peek.empty")}</p></section>
              <section><h3>{t("objectives.criteria.title")}</h3>
                {data.criteria.length ? <ol className="objectives-remote-peek-list">{data.criteria.map((criterion, index) =>
                  <li key={index} className="objectives-remote-peek-prose"><span aria-label={t(criterion.met ? "objectives.criteria.met" : "objectives.criteria.unchecked")}>{criterion.met ? "✓" : "○"}</span> {criterion.text}</li>)}</ol>
                  : <p>{t("objectives.peek.empty")}</p>}
              </section>
            </> : opened.tab === "crew" ? <>
              <section><h3>{t("objectives.members.title")}</h3>
                {data.members.length ? <ul className="objectives-remote-peek-list">{data.members.map((member, index) => <li key={index}>
                  <div className="objectives-remote-peek-line"><b>{member.role}</b><span>{member.model ?? t("objectives.members.assigned")}</span><span>{t(`objectives.peek.run.${member.run}`)}</span></div>
                  {member.brief ? <p className="objectives-remote-peek-prose">{member.brief}</p> : null}
                </li>)}</ul> : <p>{t("objectives.peek.empty")}</p>}
              </section>
              <section><h3>{t("objectives.missions.title")}</h3>
                {data.missions.length ? <ol className="objectives-remote-peek-list">{data.missions.map((mission, index) => <li key={index}>
                  <div className="objectives-remote-peek-line"><b>{mission.title}</b><span>{t(mission.done ? "objectives.graph.state.done" : "objectives.peek.mission.notDone")}</span>{mission.assignee ? <span>{mission.assignee}</span> : null}</div>
                  <p className="objectives-remote-peek-prose">{mission.text}</p>
                  {mission.premises.length ? <p>{t("objectives.peek.prerequisites", { numbers: mission.premises.join(", ") })}</p> : null}
                  {mission.records.length ? <ul className="objectives-remote-peek-records">{mission.records.map((line, lineIndex) => <li key={lineIndex}>{line}</li>)}</ul> : null}
                </li>)}</ol> : <p>{t("objectives.peek.empty")}</p>}
              </section>
            </> : <RemoteResultList data={data} t={t} />}
          </> : null}
      </div>
      <footer className="objectives-remote-peek-footer">
        <button type="button" className="objectives-popup-text-button" onClick={() => { const target = opened.target; closeObjectivePeek(false); target.openConsole(); }}>{t("objectives.peek.openConsole")}</button>
      </footer>
    </div>
  </LineupZoom>, document.body);
}

/** 원격 문자열은 경로나 스크립트가 되지 않는다. 클릭 가능한 결과물은 절대 https 링크뿐이다. */
function safeResultUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin !== location.origin && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function RemoteResultList({ data, t }: { readonly data: ConsoleObjectivePeek; readonly t: ReturnType<typeof getT> }) {
  return <section><h3>{t("objectives.results.title")}</h3>
    <p>{t("objectives.peek.evidenceList")}</p>
    {data.results.length ? <ul className="objectives-remote-peek-list">{data.results.map((result, index) => {
      const href = result.kind !== "evidence" ? safeResultUrl(result.url) : null;
      const title = result.label ?? (result.kind === "evidence" ? result.name : result.url);
      return <li key={index}>
        {href ? <a className="objectives-link" href={href} target="_blank" rel="noopener noreferrer">{title}</a> : <b>{title}</b>}
        {result.kind === "evidence" ? <p className="objectives-remote-peek-evidence">{result.name} · {result.mediaType} · {new Intl.NumberFormat().format(result.bytes)} B</p> : null}
        {result.note ? <p className="objectives-remote-peek-prose">{result.note}</p> : null}
      </li>;
    })}</ul> : <p>{t("objectives.peek.empty")}</p>}
  </section>;
}

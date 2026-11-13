import { useState, type JSX, type MouseEvent as ReactMouseEvent } from "react";

import { missionTitle, type Objective, type ObjectiveResult } from "../../shared/types.js";
import { getT } from "../i18n/index.js";
import { openResultWindow, openSharedFolderWindow } from "../result-window.js";
import { bytesLabel } from "../result-content.js";
import { useSharedFolder } from "../shared-folder-count.js";
import { openFollowups } from "../followups.js";
import { FollowupCandidateList } from "../followups-view.js";
import "./crew-results.css";

const EMPTY_IDS: ReadonlySet<string> = new Set();

export function resultsCount(objective: Objective): string {
  return String(objective.results.length);
}

/** 임무 귀속 꼬리표 — 없으면 「임무 밖」. */
const missionTag = (objective: Objective, result: ObjectiveResult, t: ReturnType<typeof getT>): string => {
  if (!result.sourceMissionId) return t("objectives.results.loose");
  const index = objective.missions.findIndex((mission) => mission.id === result.sourceMissionId);
  if (index < 0) return t("objectives.results.loose");
  return t("objectives.decisions.mission", { n: index + 1 });
};

const openerOf = (event: ReactMouseEvent<HTMLElement>): HTMLElement | null =>
  event.currentTarget instanceof HTMLElement ? event.currentTarget : null;

function ResultRow({ objective, result, t, title, sub, kind, tagClass, tag }: {
  readonly objective: Objective;
  readonly result: ObjectiveResult;
  readonly t: ReturnType<typeof getT>;
  readonly title: string;
  readonly sub: string;
  readonly kind: string;
  readonly tagClass: string;
  readonly tag: string;
}) {
  return (
    <li className="objective-rail-row objective-rail-results-item">
      <button
        type="button"
        className="objective-rail-results-open"
        aria-label={t("objectives.results.openAria", { name: title })}
        onClick={(event) => openResultWindow(objective.id, result.id, openerOf(event))}
      >
        <span className="objective-rail-results-kind" aria-hidden="true">{kind}</span>
        <span className="objective-rail-results-main">
          <span className="objective-rail-results-name">{title}</span>
          <small>{sub}</small>
        </span>
        <span className={`objective-rail-tag ${tagClass}`}>{tag}</span>
      </button>
    </li>
  );
}

/** 아래 영역 본문 — PR → 아티팩트 → 증거 파일 → 공유 폴더 → 후속 후보 순. 머리·스크롤은 골격이 감싼다. */
export function ResultsArea({ objective, language }: { objective: Objective; language: "en" | "ko" }): JSX.Element {
  const t = getT(language);
  const [followupOpen, setFollowupOpen] = useState<string | null>(null);
  const shared = useSharedFolder(objective, true);
  const entries = shared.list?.entries ?? [];

  const prs = objective.results.filter((result) => result.kind === "pr");
  const artifacts = objective.results.filter((result) => result.kind === "artifact");
  const evidence = objective.results.filter((result) => result.kind === "evidence");
  const followups = openFollowups(objective);
  const empty = prs.length === 0 && artifacts.length === 0 && evidence.length === 0 && entries.length === 0 && followups.length === 0 && !shared.failed;
  if (empty) return <p className="objective-rail-empty">{t("objectives.rail.area.empty")}</p>;

  return (
    <>
      {prs.length > 0 ? (
        <div className="objective-rail-section">
          <div className="objective-rail-section-head">{t("objectives.results.prs")} <em>{prs.length}</em></div>
          <ul className="objective-rail-list">
            {prs.map((result) => {
              if (result.kind !== "pr") return null;
              const state = result.observation.state;
              const tagClass = state === "merged" ? "is-ok" : state === "open" ? "is-run" : "is-wait";
              const tag = t(state === "error" ? "objectives.results.pr.error" : state === "unchecked" ? "objectives.results.pr.unchecked" : `objectives.results.pr.${state}`);
              const title = result.label ?? result.observation.title ?? `${result.owner}/${result.repo} #${result.number}`;
              return (
                <ResultRow
                  key={result.id}
                  objective={objective}
                  result={result}
                  t={t}
                  title={title}
                  sub={missionTag(objective, result, t)}
                  kind="PR"
                  tagClass={tagClass}
                  tag={tag}
                />
              );
            })}
          </ul>
        </div>
      ) : null}
      {artifacts.length > 0 ? (
        <div className="objective-rail-section">
          <div className="objective-rail-section-head">{t("objectives.rail.results.artifacts")} <em>{artifacts.length}</em></div>
          <ul className="objective-rail-list">
            {artifacts.map((result) => (
              <ResultRow
                key={result.id}
                objective={objective}
                result={result}
                t={t}
                title={result.label ?? t("objectives.results.artifact.untitled")}
                sub={missionTag(objective, result, t)}
                kind="A"
                tagClass=""
                tag={t("objectives.results.open")}
              />
            ))}
          </ul>
        </div>
      ) : null}
      {evidence.length > 0 ? (
        <div className="objective-rail-section">
          <div className="objective-rail-section-head">{t("objectives.rail.results.evidence")} <em>{evidence.length}</em></div>
          <ul className="objective-rail-list">
            {evidence.map((result) => {
              if (result.kind !== "evidence") return null;
              const kind = result.mediaType === "text/plain" ? "TXT" : "IMG";
              const mission = result.sourceMissionId ? objective.missions.find((entry) => entry.id === result.sourceMissionId) : undefined;
              const missionName = mission ? missionTitle(mission) : null;
              // 뷰어 제목과 같다(result-window: label ?? name). 라벨이 제목이면 캡션처럼 아래 줄에 파일명을 남긴다.
              const title = result.label ?? result.name;
              const file = result.label && result.label !== result.name ? `${result.name} · ` : "";
              const sub = `${missionName ?? missionTag(objective, result, t)} · ${file}${bytesLabel(result.bytes)}`;
              return (
                <ResultRow
                  key={result.id}
                  objective={objective}
                  result={result}
                  t={t}
                  title={title}
                  sub={sub}
                  kind={kind}
                  tagClass=""
                  tag={t("objectives.results.open")}
                />
              );
            })}
          </ul>
        </div>
      ) : null}
      {entries.length > 0 || shared.failed ? (
        <div className="objective-rail-section">
          <div className="objective-rail-section-head">{t("objectives.shared.title")} <em>{entries.length}</em></div>
          {shared.failed ? (
            <p className="objective-rail-empty">{t("objectives.shared.failed")}</p>
          ) : (
            <ul className="objective-rail-list">
              <li className="objective-rail-row objective-rail-results-item">
                <button
                  type="button"
                  className="objective-rail-results-open"
                  aria-label={t("objectives.shared.openAria", { name: t("objectives.shared.title") })}
                  onClick={(event) => {
                    const first = entries[0];
                    if (first) openSharedFolderWindow(objective.id, entries, first.path, openerOf(event));
                  }}
                >
                  <span className="objective-rail-results-kind" aria-hidden="true">DIR</span>
                  <span className="objective-rail-results-main">
                    <span className="objective-rail-results-name">{t("objectives.shared.title")}</span>
                    <small>{t("objectives.rail.results.files", { count: entries.length })}{shared.list?.truncated ? ` · ${t("objectives.shared.truncated")}` : ""}</small>
                  </span>
                  <span className="objective-rail-tag">{t("objectives.results.open")}</span>
                </button>
              </li>
            </ul>
          )}
        </div>
      ) : null}
      {followups.length > 0 ? (
        <div className="objective-rail-section">
          <div className="objective-rail-section-head">{t("objectives.followup.title")} <em>{followups.length}</em></div>
          <FollowupCandidateList
            candidates={followups}
            selectable={false}
            selection={EMPTY_IDS}
            t={t}
            idPrefix={`rail-${objective.id}`}
            openId={followupOpen}
            onOpenChange={setFollowupOpen}
            onToggleCheck={() => undefined}
          />
        </div>
      ) : null}
    </>
  );
}

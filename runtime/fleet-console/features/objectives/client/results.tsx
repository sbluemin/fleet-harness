import { useRef } from "react";
import type { ConsoleLocale, Translate } from "@fleet-console/i18n";
import { missionTitle, type Objective, type ObjectiveMission, type ObjectiveResult } from "../shared/types.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";
import { LinkText } from "./link-text.js";
import { absolute, bytesLabel, PrRow, relative, resultFileUrl, useNow } from "./result-content.js";
import { openResultWindow } from "./result-window.js";

type T = Translate<ObjectiveMessageKey>;
type PrResult = Extract<ObjectiveResult, { kind: "pr" }>;
type EvidenceResult = Extract<ObjectiveResult, { kind: "evidence" }>;

export const resultGroupKey = (objectiveId: string, missionId: string = "loose") => `result:${objectiveId}:${missionId}`;

export function ObjectiveResults({ objective, t, language, onShowMission, highlightMission, groupOpen, onToggleGroup }: {
  readonly objective: Objective; readonly t: T; readonly language: ConsoleLocale;
  /** 그래프로 가는 ↗ — 그래프가 없는 자리(모바일 상세)는 넘기지 않고, 그때는 ↗ 칸도 세우지 않는다. */
  readonly onShowMission?: (missionId: string) => void; readonly highlightMission: string | null;
  readonly groupOpen: (key: string) => boolean; readonly onToggleGroup: (key: string) => void;
}) {
  const now = useNow();
  const openerRefs = useRef(new Map<string, HTMLButtonElement>());
  const openerRef = (id: string) => (node: HTMLButtonElement | null) => { if (node) openerRefs.current.set(id, node); else openerRefs.current.delete(id); };
  const viewResult = (id: string) => openResultWindow(objective.id, id, openerRefs.current.get(id) ?? null);
  const groups = objective.missions.map((mission, index) => ({ mission, n: index + 1, results: objective.results.filter((result) => result.sourceMissionId === mission.id) })).filter((group) => group.results.length > 0);
  const knownMissions = new Set(objective.missions.map((mission) => mission.id));
  const loose = objective.results.filter((result) => !result.sourceMissionId || !knownMissions.has(result.sourceMissionId));
  const source = (result: ObjectiveResult) => {
    const n = result.sourceMissionId ? objective.missions.findIndex((mission) => mission.id === result.sourceMissionId) + 1 : 0;
    return n > 0 ? t("objectives.results.mission", { n }) : t(result.sourceMissionId ? "objectives.results.looseRemoved" : "objectives.results.looseNoSource");
  };
  const sourceTag = (result: ObjectiveResult) => result.sourceMissionId && knownMissions.has(result.sourceMissionId) ? "" : ` · ${source(result)}`;
  const uploaded = (result: EvidenceResult) => t("objectives.results.uploaded", { ago: relative(result.capturedAt, now, language) });
  const group = (mission: ObjectiveMission | null, n: number, results: readonly ObjectiveResult[]) => {
    const record = mission?.records.at(-1);
    const key = resultGroupKey(objective.id, mission?.id);
    const open = groupOpen(key);
    const bodyId = `objectives-result-body-${objective.id}-${mission?.id ?? "loose"}`;
    const name = mission ? `${t("objectives.graph.detail", { n })} · ${missionTitle(mission)}` : t("objectives.results.loose");
    const groupImages = results.filter((result): result is EvidenceResult => result.kind === "evidence" && result.mediaType !== "text/plain");
    return <section key={mission?.id ?? "loose"} data-result-mission={mission?.id} className={`objectives-result-group${mission ? "" : " is-loose"}${highlightMission === mission?.id ? " is-highlight" : ""}`}>
      <div className="objectives-result-group-bar">
        <button type="button" className="objectives-result-group-head" aria-label={`${name} · ${t("objectives.results.title")} ${t("objectives.results.count", { count: results.length })}`} aria-expanded={open} aria-controls={bodyId} onClick={() => onToggleGroup(key)}>
          <span className="objectives-result-mission-n" aria-hidden="true">{mission ? n : "—"}</span><span className="objectives-result-mission-title">{mission ? missionTitle(mission) : t("objectives.results.loose")}</span>
          <span className="objectives-result-group-count">{t("objectives.results.count", { count: results.length })}</span>
          <span className="objectives-section-chev" aria-hidden="true"><ChevronGlyph /></span>
        </button>
        {!onShowMission ? null : mission ? <button type="button" className="objectives-glyph objectives-result-goto" aria-label={`${t("objectives.graph.detail", { n })} · ${t("objectives.results.showInGraph")}`} title={t("objectives.results.showInGraph")} onClick={() => onShowMission(mission.id)}>↗</button>
          : <span className="objectives-result-goto-space" aria-hidden="true" />}
      </div>
      <div id={bodyId} className="objectives-result-group-body" hidden={!open}>
      {record ? <div className="objectives-result-record">
        <span title={record.lines[0] ?? ""}><LinkText text={record.lines[0] ?? ""} /></span>
        <time dateTime={new Date(record.at).toISOString()} title={absolute(record.at, language)}>{t("objectives.results.lastRecord", { time: relative(record.at, now, language) })}</time>
      </div> : null}
      {groupImages.length ? <div className="objectives-result-strip">{groupImages.map((result) => {
        const title = result.label ?? result.name;
        return <div key={result.id} className="objectives-result-thumb">
          <button ref={openerRef(result.id)} type="button" className="objectives-result-thumb-hit" aria-label={`${t("objectives.results.zoom", { name: title })} · ${source(result)}`} title={`${result.name} · ${uploaded(result)} · ${source(result)}`} onClick={() => viewResult(result.id)}>
            <span className="objectives-result-img"><img src={resultFileUrl(objective.id, result)} alt="" loading="lazy" draggable={false} /></span>
          </button>
          <span className="objectives-result-name" onClick={(event) => { if (event.target instanceof Element && event.target.closest("a")) return; viewResult(result.id); }}><LinkText text={title} /></span>
          {!mission ? <span className="objectives-result-sub">{source(result)}</span> : null}
        </div>;
      })}</div> : null}
      {results.filter((result): result is EvidenceResult => result.kind === "evidence" && result.mediaType === "text/plain").map((result) => <div key={result.id} className="objectives-result-row is-button" onClick={(event) => { if (event.target instanceof Element && event.target.closest("a")) return; viewResult(result.id); }}>
        <span className="objectives-row-ic"><DocGlyph /></span>
        <span className="objectives-result-body">
          <span className="objectives-result-title is-mono"><LinkText text={result.label ?? result.name} /></span>
          <span className="objectives-result-sub">{result.label ? `${result.name} · ` : ""}{t("objectives.results.text", { size: bytesLabel(result.bytes) })} · <time dateTime={new Date(result.capturedAt).toISOString()} title={absolute(result.capturedAt, language)}>{uploaded(result)}</time>{sourceTag(result)}</span>
          {result.note ? <span className="objectives-result-sub"><LinkText text={result.note} /></span> : null}
        </span>
        <button ref={openerRef(result.id)} type="button" className="objectives-result-open" aria-label={`${t("objectives.results.openAria", { name: result.label ?? result.name })} · ${source(result)}`} onClick={() => viewResult(result.id)}>{t("objectives.results.open")}</button>
      </div>)}
      {results.filter((result) => result.kind === "artifact").map((result) => {
        const name = result.label ?? t("objectives.results.artifact.untitled");
        return <div key={result.id} className="objectives-result-row is-button is-artifact" onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("a") || window.getSelection()?.toString()) return;
          viewResult(result.id);
        }}>
          <span className="objectives-row-ic"><ArtifactGlyph /></span>
          <span className="objectives-result-body">
            <a className={`objectives-result-title${result.label ? "" : " is-placeholder"}`} href={result.url} target="_blank" rel="noopener noreferrer" aria-label={t("objectives.results.artifact.openAria", { name })} title={t("objectives.results.artifact.tooltip")}>{name}</a>
            <span className="objectives-result-sub"><span className="is-mono">claude.ai</span>{sourceTag(result)}</span>
            {result.note ? <span className="objectives-result-sub">{result.note}</span> : null}
          </span>
          <button ref={openerRef(result.id)} type="button" className="objectives-result-open" aria-label={t("objectives.results.openAria", { name })} onClick={() => viewResult(result.id)}>{t("objectives.results.open")}</button>
        </div>;
      })}
      {results.filter((result): result is PrResult => result.kind === "pr").map((result) => <PrRow key={result.id} result={result} t={t} language={language} now={now} missionTag={sourceTag(result)} onView={(opener) => openResultWindow(objective.id, result.id, opener)} />)}
      </div>
    </section>;
  };

  const artifactVisible = groups.some(({ mission, results }) => groupOpen(resultGroupKey(objective.id, mission.id)) && results.some((result) => result.kind === "artifact"))
    || groupOpen(resultGroupKey(objective.id)) && loose.some((result) => result.kind === "artifact");
  return <div className="objectives-results">
    <button type="button" className="objectives-result-window-open" onClick={(event) => openResultWindow(objective.id, undefined, event.currentTarget)}>{t("objectives.results.window.open")}</button>
    {groups.map(({ mission, n, results }) => group(mission, n, results))}
    {loose.length ? group(null, 0, loose) : null}
    {artifactVisible ? <p className="objectives-artifact-notice"><InfoGlyph /><span>{t("objectives.results.artifact.notice")}</span></p> : null}

  </div>;
}

const ChevronGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" /></svg>;
const ArtifactGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 6h12M4.5 4.3h.1M6.5 4.3h.1M6 8.5l-1.5 1.5L6 11.5M10 8.5l1.5 1.5-1.5 1.5" /></svg>;
const InfoGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 7v4M8 4.8h.01" /></svg>;
/** 결과물 구획 머리 — 상자에 담긴 산출물. */
export const ResultsGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 5.2 8 2.5l5.5 2.7v5.6L8 13.5l-5.5-2.7z" /><path d="M2.5 5.2 8 7.9l5.5-2.7M8 7.9v5.6" /></svg>;
const DocGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.5 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V5.5z" /><path d="M9.5 2v3.5H13M5.8 8.5h4.4M5.8 11h3" /></svg>;

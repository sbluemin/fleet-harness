import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { missionTitle, type Objective } from "../../../objectives/shared/types.js";
import type { SharedFileChunk, SharedFolderList } from "../../../objectives/shared/shared-folder.js";
import { LineupZoom } from "../../../objectives/client/objectives-panel.js";
import { getT } from "../../../objectives/client/i18n/index.js";
import { useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import { sidebarJson, sidebarRequest } from "../../../remote-access/client/sidebar-transport.js";
import type { CommanderRowGlyphTab } from "../commander-tab/commander-row-glyphs.js";
import "../../../objectives/client/remote-objective-popup.css";

type FileView = { readonly url: string; readonly name: string; readonly type: string; readonly text: string | null };
/** 다른 Console의 파일은 byte blob으로만 연다. 상대 shared 경로는 대상의 containment 검사를 지난다. */
export function RemoteSidebarPopup({ console, objectiveId, machine, tab: initialTab, opener, onClose }: {
  readonly console: string; readonly objectiveId: string; readonly machine: string; readonly tab: CommanderRowGlyphTab;
  readonly opener: HTMLElement | null; readonly onClose: () => void;
}) {
  const t = getT(useConsoleLocale() === "ko" ? "ko" : "en");
  const [tab, setTab] = useState(initialTab);
  const [objective, setObjective] = useState<Objective | null>(null);
  const [shared, setShared] = useState<SharedFolderList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<FileView | null>(null);
  const fileFlight = useRef<AbortController | null>(null);
  useEffect(() => () => { fileFlight.current?.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void sidebarJson<{ objective: Objective }>(console, "objective", undefined, { objectiveId }, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setObjective(value.objective); }).catch((error: unknown) => { if (!controller.signal.aborted) setError(String(error)); });
    void sidebarJson<SharedFolderList>(console, "shared", undefined, { objectiveId }, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setShared(value); }).catch((error: unknown) => { if (!controller.signal.aborted) setError(String(error)); });
    return () => { controller.abort(); if (document.hasFocus()) opener?.focus({ preventScroll: true }); };
  }, [console, objectiveId, opener]);
  useEffect(() => () => { if (file) URL.revokeObjectURL(file.url); }, [file]);
  const openFile = async (name: string, operation: "evidence" | "sharedFile", query: Record<string, string>) => {
    fileFlight.current?.abort();
    const controller = new AbortController();
    fileFlight.current = controller;
    try {
      let blob: Blob;
      if (operation === "sharedFile") {
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let offset: number | null = 0, version: string | null = null, type = "application/octet-stream", size: number | null = null;
        while (offset !== null) {
          const chunk: SharedFileChunk = await sidebarJson(console, "sharedChunk", undefined, { objectiveId, ...query, offset: String(offset), ...(version ? { version } : {}) }, controller.signal);
          if (chunk.offset !== offset || !Number.isSafeInteger(chunk.size) || chunk.size < 0 || !/^[a-f0-9]{64}$/.test(chunk.version)
            || (version !== null && chunk.version !== version) || (size !== null && chunk.size !== size)
            || typeof chunk.data !== "string" || chunk.data.length > 1024 * 1024
            || (chunk.next !== null && (!Number.isSafeInteger(chunk.next) || chunk.next <= offset || chunk.next > chunk.size))) throw new Error("sidebar_invalid_file");
          const bytes = Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0));
          if (offset + bytes.length !== (chunk.next ?? chunk.size)) throw new Error("sidebar_invalid_file");
          chunks.push(bytes); offset = chunk.next; version = chunk.version; size = chunk.size; type = chunk.type;
        }
        blob = new Blob(chunks, { type: /^(?:text\/plain|image\/(?:png|jpeg|webp|gif))$/.test(type) ? type : "application/octet-stream" });
      } else {
        const response = await sidebarRequest(console, operation, undefined, { objectiveId, ...query }, controller.signal);
        if (!response.ok) throw new Error(`sidebar_${response.status}`);
        blob = await response.blob();
      }
      const text = blob.type.startsWith("text/plain") ? await blob.text() : null;
      if (!controller.signal.aborted) setFile({ name, url: URL.createObjectURL(blob), type: blob.type, text });
    } catch (error) { if (!controller.signal.aborted) setError(String(error)); }
  };
  return createPortal(<LineupZoom t={t} title={objective?.title ?? machine} category={t(tab === "goal" ? "objectives.tabs.goal" : tab === "crew" ? "objectives.missions.title" : "objectives.results.title")}
    width={880} onClose={onClose} tools={<span className="objectives-remote-peek-source"><b>{machine}</b></span>}>
    <div className="objectives-remote-peek">
      <nav className="objectives-remote-peek-tabs" aria-label={t("objectives.tabs.aria")}>
        {(["goal", "crew", "results"] as const).map((value) => <button key={value} type="button" className="objectives-popup-text-button" aria-pressed={tab === value} onClick={() => setTab(value)}>
          {t(value === "goal" ? "objectives.tabs.goal" : value === "crew" ? "objectives.missions.title" : "objectives.results.title")}</button>)}
      </nav>
      {error ? <p role="alert">{error}</p> : null}
      {!objective ? <p role="status">{t("objectives.peek.loading")}</p> : tab === "goal" ? <>
        <section><h3>{t("objectives.objective.memo")}</h3><p className="objectives-remote-peek-prose">{objective.note}</p></section>
        <section><h3>{t("objectives.criteria.title")}</h3><ol>{objective.criteria.map((criterion) => <li key={criterion.id}>{criterion.met ? "✓" : "○"} {criterion.text}{criterion.met ? <p className="objectives-remote-peek-prose">{criterion.met}</p> : null}</li>)}</ol></section>
        {objective.decisionRequest ? <section><h3>{t("objectives.ask.title")}</h3><ol>{objective.decisionRequest.questions.map((question) => <li key={question.id}><p className="objectives-remote-peek-prose">{question.text}</p><ul>{question.options.map((option) => <li key={option.id}><b>{option.label}</b>{option.description ? <p className="objectives-remote-peek-prose">{option.description}</p> : null}</li>)}</ul></li>)}</ol></section> : null}
        {objective.decisions.length ? <section><h3>{t("objectives.decisions.title")}</h3><ol>{objective.decisions.map((decision) => <li key={decision.id}>
          <p className="objectives-remote-peek-prose">{decision.question.text}</p>
          <ul>{decision.question.options.filter((option) => decision.answer.selectedOptionIds.includes(option.id)).map((option) => <li key={option.id}>{option.label}</li>)}</ul>
          <p className="objectives-remote-peek-prose">{decision.declined ? t("objectives.decisions.declined") : decision.answer.text}</p>
        </li>)}</ol></section> : null}
        {objective.consultations.length ? <section><h3>{t("objectives.consultations.title")}</h3><ol>{objective.consultations.map((consultation) => <li key={consultation.id}>
          <p className="objectives-remote-peek-prose">{consultation.question}</p><p className="objectives-remote-peek-prose">{consultation.reply?.kind === "advice" ? consultation.reply.text : t(consultation.reply ? "objectives.consultations.none" : "objectives.consultations.unanswered")}</p>
        </li>)}</ol></section> : null}
      </> : tab === "crew" ? <>
        <section><h3>{t("objectives.members.title")}</h3><ul>{objective.members.map((member) => <li key={member.id}><b>{member.role}</b>{member.model ? <small> · {member.model}{member.effort ? ` · ${member.effort}` : ""}</small> : null}<p className="objectives-remote-peek-prose">{member.brief}</p></li>)}</ul></section>
        <section><h3>{t("objectives.missions.title")}</h3><ol>{objective.missions.map((mission) => <li key={mission.id}>
          <b>{mission.done ? "✓ " : ""}{missionTitle(mission)}</b>{mission.member ? <small> · {objective.members.find((member) => member.id === mission.member)?.role}</small> : null}<p className="objectives-remote-peek-prose">{mission.text}</p>
          {mission.records?.map((record, index) => <p key={index} className="objectives-remote-peek-prose">{record.lines.join("\n")}</p>)}
        </li>)}</ol></section>
      </> : <>
        <section><h3>{t("objectives.results.title")}</h3><ul>{objective.results.map((result) => <li key={result.id}>
          {result.kind === "evidence" ? <button type="button" className="objectives-popup-text-button" onClick={() => { void openFile(result.name, "evidence", { resultId: result.id }); }}>{result.label ?? result.name}</button>
            : /^https:\/\//.test(result.url) ? <a className="objectives-link" href={result.url} target="_blank" rel="noopener noreferrer">{result.label ?? result.url}</a> : <span>{result.label}</span>}
          {result.note ? <p>{result.note}</p> : null}
        </li>)}</ul></section>
        <section><h3>{t("objectives.shared.title")}</h3>{shared?.truncated ? <p>{t("objectives.peek.truncated")}</p> : null}
          <ul>{shared?.entries.map((entry) => <li key={entry.path}><button type="button" className="objectives-popup-text-button" onClick={() => { void openFile(entry.path, "sharedFile", { path: entry.path }); }}>{entry.path}</button> · {entry.bytes} B</li>)}</ul>
        </section>
      </>}
      {file ? <section><h3>{file.name}</h3>{file.type.startsWith("image/") ? <img style={{ maxWidth: "100%", maxHeight: "60vh", objectFit: "contain" }} src={file.url} alt={file.name} />
        : file.text !== null ? <pre className="objectives-remote-peek-prose">{file.text}</pre> : null}
        <a className="objectives-link" href={file.url} download={file.name.split("/").at(-1)}>{file.name}</a>
      </section> : null}
    </div>
  </LineupZoom>, document.body);
}
